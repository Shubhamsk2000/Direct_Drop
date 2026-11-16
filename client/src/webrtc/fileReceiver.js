import {
    MSG,
    RECEIVER_IDLE_TIMEOUT_MS,
    RECEIVER_ACK_INTERVAL,
    RESUME_TIMEOUT_MS,
    encodeMessage,
    sameFiles,
    parseMessage,
    validateBatchMetadata,
    toArrayBuffer,
    createProgressThrottle,
} from "./protocol.js";
import { prepareBatchStorage } from "./storage.js";

/**
 * Create the receiving side of the transfer protocol.
 *
 * Received data is streamed into a storage "sink" per file (see storage.js),
 * so large files don't have to fit in memory.
 *
 * @param {object} opts
 * @param {(msg: string) => void} opts.send            reply to the sender
 * @param {(files: object[], storage: { kind: string, warning: string | null }) => void} opts.onBatchMetadata
 * @param {(index: number, percent: number) => void} opts.onProgress
 * @param {(index: number, result: { blob?: Blob, savedAs?: string }, name: string) => void} opts.onFileComplete
 *        `blob` → caller should offer it as a download; `savedAs` → already written to the chosen folder
 * @param {() => void} opts.onAllComplete
 * @param {(error: string) => void} [opts.onError]      batch failed
 * @param {(message: string) => void} [opts.onCancelled] batch cancelled by either side
 * @param {(fileIndex: number, offset: number) => void} [opts.onResumed] suspended batch continues
 * @param {(batchId: string, totalBytes: number) => Promise<object>} [opts.prepareStorage]
 *        picks the storage backend for a batch (defaults to storage.js with no folder)
 * @returns {{
 *   handleData: (data: string | ArrayBuffer | Blob) => void,  // feed every channel message here
 *   cancel: () => boolean,  // user cancel: notify sender, drop partial data
 *   abort: () => boolean,   // drop partial data silently
 *   suspend: () => boolean, // connection lost: keep the batch so the sender can resume it
 *   isActive: () => boolean,
 *   isSuspended: () => boolean,
 * }}  cancel/abort/suspend return whether a batch was in progress.
 *
 * One receiver outlives individual data channels: `send` must always target
 * the current channel, so a suspended batch can resume on a new one.
 */
export default function createMultiFileReceiver({
    send,
    onBatchMetadata,
    onProgress,
    onFileComplete,
    onAllComplete,
    onError,
    onCancelled,
    onResumed,
    prepareStorage = (batchId, totalBytes) => prepareBatchStorage(batchId, totalBytes),
}) {
    // Active batch: { id, files, store, nextFileIndex, current }
    // current: { index, info, sink, receivedBytes, writtenBytes, ackedBytes, progress } | null
    let batch = null;
    let idleTimer = null;
    // Set while the connection is down and we're waiting for batch-resume.
    let suspended = false;
    let resumeTimer = null;
    // How the previous batch ended, to answer a resume whose final ack was lost.
    let lastFinished = null; // { id, outcome: "complete" | "cancelled" }

    // Serialises all processing (and storage I/O) so nothing is reordered.
    let queue = Promise.resolve();
    const enqueue = (task) => {
        queue = queue.then(task).catch((err) => fail(err?.message || String(err)));
    };

    const clearIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
    };
    const clearResumeTimer = () => {
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = null;
    };
    const touch = () => {
        clearIdleTimer();
        if (!batch || suspended) return;
        idleTimer = setTimeout(() => {
            fail("The sender stopped sending data");
        }, RECEIVER_IDLE_TIMEOUT_MS);
    };

    /** Drop the batch without telling anyone; its partial file is discarded in the background. */
    const dropBatch = () => {
        const old = batch;
        batch = null;
        suspended = false;
        clearIdleTimer();
        clearResumeTimer();
        const sink = old?.current?.sink;
        if (sink) {
            old.current = null;
            // Queued so it runs after any write already in progress.
            queue = queue.then(() => sink.abort()).catch(() => {});
        }
        return !!old;
    };

    /** Fatal error during a batch: tell the sender so it doesn't wait on us. */
    const fail = (reason, { notify = true } = {}) => {
        console.error("Receiver:", reason);
        if (notify && batch && !suspended) {
            send(encodeMessage(MSG.TRANSFER_CANCEL, { batchId: batch.id, error: true, reason }));
        }
        dropBatch();
        onError?.(reason);
    };

    async function handleControl(msg) {
        if (msg.type === MSG.BATCH_METADATA) {
            const error = validateBatchMetadata(msg);
            if (error) {
                send(encodeMessage(MSG.BATCH_REJECT, { batchId: msg.batchId, reason: error }));
                dropBatch();
                onError?.(error);
                return;
            }
            if (batch) {
                console.warn("Receiver: new batch replaces unfinished batch", batch.id);
                dropBatch();
            }

            const totalBytes = msg.files.reduce((sum, f) => sum + f.size, 0);
            let store;
            try {
                store = await prepareStorage(msg.batchId, totalBytes);
            } catch (err) {
                const reason = `Couldn't prepare storage: ${err?.message || err}`;
                send(encodeMessage(MSG.BATCH_REJECT, { batchId: msg.batchId, reason }));
                onError?.(reason);
                return;
            }

            batch = { id: msg.batchId, files: msg.files, store, nextFileIndex: 0, current: null };
            touch();
            onBatchMetadata(batch.files, { kind: store.kind, warning: store.warning ?? null });
            send(encodeMessage(MSG.BATCH_READY, { batchId: batch.id }));
            return;
        }

        if (msg.type === MSG.BATCH_RESUME) {
            handleResume(msg);
            return;
        }

        // Everything else belongs to a batch; ignore stragglers from an old one.
        if (!batch || msg.batchId !== batch.id) {
            if (msg.type !== MSG.TRANSFER_CANCEL) {
                console.warn(`Receiver: ignoring ${msg.type} for inactive batch`);
            }
            return;
        }
        touch();
        const b = batch;

        switch (msg.type) {
            case MSG.FILE_START: {
                const index = msg.fileIndex;
                const offset = msg.offset ?? 0;
                if (b.current) {
                    // Only valid right after a resume: continue the open file in place.
                    if (b.current.index !== index || b.current.writtenBytes !== offset) {
                        fail(`Can't continue file ${index} at byte ${offset} ` +
                            `(have file ${b.current.index} at byte ${b.current.writtenBytes})`);
                    }
                    return;
                }
                if (offset !== 0 || index !== b.nextFileIndex || !b.files[index]) {
                    fail(`Unexpected file-start for index ${index} (expected ${b.nextFileIndex})`);
                    return;
                }
                const info = b.files[index];
                let sink;
                try {
                    sink = await b.store.openFile(info, index);
                } catch (err) {
                    fail(`Couldn't create "${info.name}": ${err?.message || err}`);
                    return;
                }
                if (batch !== b) {
                    // Cancelled while the file was being opened.
                    await sink.abort();
                    return;
                }
                b.current = {
                    index,
                    info,
                    sink,
                    receivedBytes: 0,
                    writtenBytes: 0,
                    ackedBytes: 0,
                    progress: createProgressThrottle((p) => onProgress(index, p)),
                };
                b.current.progress(0);
                return;
            }

            case MSG.FILE_COMPLETE: {
                const index = msg.fileIndex;
                const current = b.current;
                if (!current || current.index !== index) {
                    send(encodeMessage(MSG.FILE_ACK, {
                        batchId: b.id, fileIndex: index, ok: false, reason: "No active file with that index",
                    }));
                    fail(`file-complete for inactive file ${index}`, { notify: false });
                    return;
                }

                const { info, sink, receivedBytes } = current;
                if (receivedBytes !== info.size || current.writtenBytes !== info.size) {
                    const reason = `Expected ${info.size} bytes, received ${receivedBytes}`;
                    send(encodeMessage(MSG.FILE_ACK, {
                        batchId: b.id, fileIndex: index, ok: false, receivedBytes, reason,
                    }));
                    fail(`"${info.name}": ${reason}`, { notify: false });
                    return;
                }

                b.current = null;
                let result;
                try {
                    result = await sink.close();
                } catch (err) {
                    await sink.abort();
                    const reason = `Couldn't save "${info.name}": ${err?.message || err}`;
                    send(encodeMessage(MSG.FILE_ACK, { batchId: b.id, fileIndex: index, ok: false, reason }));
                    if (batch === b) fail(reason, { notify: false });
                    return;
                }
                if (batch !== b) return; // cancelled while finalising; sender knows already

                onProgress(index, 100);
                onFileComplete(index, result, info.name);
                b.nextFileIndex = index + 1;
                send(encodeMessage(MSG.FILE_ACK, { batchId: b.id, fileIndex: index, ok: true, receivedBytes }));
                return;
            }

            case MSG.TRANSFER_COMPLETE: {
                const { id, nextFileIndex, files } = b;
                const allReceived = nextFileIndex === files.length;
                send(encodeMessage(MSG.TRANSFER_ACK, { batchId: id, ok: allReceived }));
                if (allReceived) {
                    lastFinished = { id, outcome: "complete" };
                    dropBatch();
                    onAllComplete();
                } else {
                    fail(`Transfer ended after ${nextFileIndex}/${files.length} files`, { notify: false });
                }
                return;
            }

            case MSG.TRANSFER_CANCEL: {
                lastFinished = { id: b.id, outcome: "cancelled" };
                dropBatch();
                if (msg.error) {
                    const reason = `Sender error: ${msg.reason || "unknown error"}`;
                    console.error("Receiver:", reason);
                    onError?.(reason);
                } else {
                    onCancelled?.("The sender cancelled the transfer");
                }
                return;
            }

            default:
                // Receiver-bound messages only; anything else is ignored.
                return;
        }
    }

    function handleResume(msg) {
        const reply = (type, payload = {}) => send(encodeMessage(type, { batchId: msg.batchId, ...payload }));

        if (batch && batch.id === msg.batchId) {
            if (!sameFiles(batch.files, msg.files)) {
                reply(MSG.BATCH_REJECT, { reason: "File list changed since the transfer started" });
                fail("The sender's file list changed; can't resume", { notify: false });
                return;
            }
            // The queue is serialised, so every chunk that arrived before the
            // drop has been written by now: writtenBytes is exact.
            suspended = false;
            clearResumeTimer();
            const current = batch.current;
            let fileIndex = batch.nextFileIndex;
            let offset = 0;
            if (current) {
                fileIndex = current.index;
                offset = current.writtenBytes;
                // Bytes past what we stored (if any) will be re-sent.
                current.receivedBytes = offset;
                current.ackedBytes = offset;
            }
            touch();
            console.log(`Receiver: resuming batch at file ${fileIndex}, byte ${offset}`);
            reply(MSG.RESUME, { fileIndex, offset });
            onResumed?.(fileIndex, offset);
            return;
        }

        if (lastFinished?.id === msg.batchId) {
            if (lastFinished.outcome === "complete") reply(MSG.RESUME, { done: true });
            else reply(MSG.TRANSFER_CANCEL, { error: false, reason: "Receiver cancelled the transfer" });
            return;
        }

        reply(MSG.BATCH_REJECT, { reason: "The receiver no longer has this transfer (it may have reloaded)" });
    }

    /** Connection lost: keep the batch (and partial file) for a while so it can resume. */
    function suspend() {
        if (!batch) return false;
        if (suspended) return true;
        suspended = true;
        clearIdleTimer();
        resumeTimer = setTimeout(() => {
            resumeTimer = null;
            fail("The sender didn't reconnect in time", { notify: false });
        }, RESUME_TIMEOUT_MS);
        return true;
    }

    async function handleChunk(buffer) {
        const b = batch;
        const current = b?.current;
        if (!current) {
            // Normal for in-flight chunks right after a cancel.
            return;
        }
        touch();
        current.receivedBytes += buffer.byteLength;
        if (current.receivedBytes > current.info.size) {
            // Keep counting so the size check at file-complete reports it,
            // but don't store data we know is bogus.
            return;
        }

        try {
            await current.sink.write(buffer);
        } catch (err) {
            if (b.current !== current) return; // aborted mid-write
            const quota = err?.name === "QuotaExceededError";
            fail(quota
                ? "Ran out of storage space on this device"
                : `Couldn't write "${current.info.name}": ${err?.message || err}`);
            return;
        }
        if (b.current !== current) return;

        current.writtenBytes += buffer.byteLength;
        // Flow control: tell the sender how much is safely stored.
        if (current.writtenBytes - current.ackedBytes >= RECEIVER_ACK_INTERVAL) {
            current.ackedBytes = current.writtenBytes;
            send(encodeMessage(MSG.CHUNK_ACK, {
                batchId: b.id, fileIndex: current.index, receivedBytes: current.writtenBytes,
            }));
        }

        const { info, writtenBytes } = current;
        // Cap at 99 until the file is verified on file-complete.
        current.progress(info.size > 0 ? Math.min(99, (writtenBytes / info.size) * 100) : 99);
    }

    function handleData(data) {
        enqueue(async () => {
            if (typeof data === "string") {
                const msg = parseMessage(data);
                if (msg) await handleControl(msg);
                return;
            }
            const buffer = await toArrayBuffer(data);
            if (buffer) await handleChunk(buffer);
            else console.warn("Receiver: unknown data type", typeof data);
        });
    }

    function cancel() {
        if (!batch) return false;
        // If suspended, there's no channel; a later resume gets the cancel instead.
        lastFinished = { id: batch.id, outcome: "cancelled" };
        send(encodeMessage(MSG.TRANSFER_CANCEL, {
            batchId: batch.id, error: false, reason: "Receiver cancelled the transfer",
        }));
        dropBatch();
        onCancelled?.("You cancelled the transfer");
        return true;
    }

    return {
        handleData,
        cancel,
        abort: dropBatch,
        suspend,
        isActive: () => !!batch,
        isSuspended: () => !!batch && suspended,
    };
}
