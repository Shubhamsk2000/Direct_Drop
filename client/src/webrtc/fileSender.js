import {
    PROTOCOL_VERSION,
    CHUNK_SIZE,
    BUFFERED_AMOUNT_LOW_THRESHOLD,
    HANDSHAKE_TIMEOUT_MS,
    ACK_TIMEOUT_MS,
    RECEIVE_WINDOW,
    MSG,
    TransferError,
    encodeMessage,
    parseMessage,
    makeBatchId,
    describeFiles,
    throwIfAborted,
    toTransferError,
    isPeerError,
    waitForMessage,
    waitForBufferDrain,
    createProgressThrottle,
} from "./protocol.js";

/**
 * A batch of files to send, resumable across data channels.
 *
 * Flow on the first channel:
 *   batch-metadata  ->  <- batch-ready | batch-reject
 *   for each file:
 *     file-start, <binary chunks>, file-complete  ->  <- chunk-ack*, file-ack
 *   transfer-complete  ->  <- transfer-ack
 * Either side may send `transfer-cancel` at any point to abort the batch.
 *
 * If the connection drops, `run()` rejects with code "disconnected". Calling
 * `run()` again on a new channel sends `batch-resume`; the receiver answers
 * `resume { fileIndex, offset }` (bytes it has safely stored) and sending
 * continues from there with `file-start { offset }`.
 *
 * A file only counts as delivered once the receiver acks it with the
 * correct byte count.
 *
 * @param {File[]} files
 * @param {object} [opts]
 * @param {(index: number, percent: number) => void} [opts.onProgress]
 * @param {(index: number) => void} [opts.onFileComplete]
 */
export function createBatchSender(files, { onProgress, onFileComplete } = {}) {
    const batchId = makeBatchId();
    const metadata = describeFiles(files);
    const ofBatch = (m) => m.batchId === batchId;

    // Has the receiver ever accepted this batch? If not, a rerun starts from scratch.
    let accepted = false;
    // First file the receiver hasn't acked yet.
    let nextFile = 0;
    let running = false;

    const markDelivered = (idx) => {
        onProgress?.(idx, 100);
        onFileComplete?.(idx);
    };

    /**
     * Send (or continue sending) the batch over `channel`.
     * Rejects with a TransferError; code "disconnected" means it can be resumed
     * by calling run() again on a new channel.
     * @param {RTCDataChannel} channel
     * @param {{ signal?: AbortSignal }} [opts] abort to cancel; `signal.reason` becomes the error
     */
    async function run(channel, { signal } = {}) {
        if (running) throw new TransferError("Batch is already running", "error");
        if (!channel || channel.readyState !== "open") {
            throw new TransferError("Data channel is not open", "disconnected");
        }
        throwIfAborted(signal);
        running = true;

        channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

        // One internal signal that aborts on either a local cancel or a peer cancel.
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort(signal.reason);
        signal?.addEventListener("abort", onExternalAbort, { once: true });

        // Flow control: bytes of the current file the receiver has persisted.
        const flow = { fileIndex: -1, acked: 0, wake: null };

        const onPeerMessage = (event) => {
            if (typeof event.data !== "string") return;
            const msg = parseMessage(event.data);
            if (!msg || !ofBatch(msg)) return;
            if (msg.type === MSG.CHUNK_ACK) {
                if (msg.fileIndex === flow.fileIndex && Number.isSafeInteger(msg.receivedBytes)
                    && msg.receivedBytes > flow.acked) {
                    flow.acked = msg.receivedBytes;
                    flow.wake?.();
                }
                return;
            }
            if (msg.type !== MSG.TRANSFER_CANCEL) return;
            controller.abort(msg.error
                ? new TransferError(`Receiver error: ${msg.reason || "unknown error"}`, "peer-error")
                : new TransferError("The receiver cancelled the transfer", "peer-cancelled"));
        };
        channel.addEventListener("message", onPeerMessage);

        const opts = { signal: controller.signal };

        try {
            // 1. Agree on where to start.
            let startFile = 0;
            let startOffset = 0;

            if (!accepted) {
                const readyPromise = waitForMessage(
                    channel,
                    (m) => (m.type === MSG.BATCH_READY || m.type === MSG.BATCH_REJECT) && ofBatch(m),
                    { ...opts, timeoutMs: HANDSHAKE_TIMEOUT_MS, timeoutMessage: "The receiver didn't respond to the transfer request" }
                );
                channel.send(encodeMessage(MSG.BATCH_METADATA, {
                    version: PROTOCOL_VERSION, batchId, totalFiles: files.length, files: metadata,
                }));
                const handshake = await readyPromise;
                if (handshake.type === MSG.BATCH_REJECT) {
                    throw new TransferError(
                        `Receiver rejected the transfer: ${handshake.reason || "unknown reason"}`,
                        "peer-error"
                    );
                }
                accepted = true;
            } else {
                const resumePromise = waitForMessage(
                    channel,
                    (m) => (m.type === MSG.RESUME || m.type === MSG.BATCH_REJECT) && ofBatch(m),
                    { ...opts, timeoutMs: HANDSHAKE_TIMEOUT_MS, timeoutMessage: "The receiver didn't respond to the resume request" }
                );
                channel.send(encodeMessage(MSG.BATCH_RESUME, {
                    version: PROTOCOL_VERSION, batchId, totalFiles: files.length, files: metadata,
                }));
                const reply = await resumePromise;
                if (reply.type === MSG.BATCH_REJECT) {
                    throw new TransferError(
                        `The receiver couldn't resume the transfer: ${reply.reason || "unknown reason"}`,
                        "peer-error"
                    );
                }
                if (reply.done) {
                    // Receiver finished everything; only our final ack was lost.
                    for (let i = nextFile; i < files.length; i++) markDelivered(i);
                    nextFile = files.length;
                    return;
                }
                const { fileIndex, offset } = reply;
                if (!Number.isSafeInteger(fileIndex) || fileIndex < nextFile || fileIndex > files.length
                    || !Number.isSafeInteger(offset) || offset < 0
                    || (fileIndex < files.length ? offset > files[fileIndex].size : offset !== 0)) {
                    throw new TransferError(
                        `Receiver sent an invalid resume point (file ${fileIndex}, offset ${offset})`,
                        "peer-error"
                    );
                }
                // Files the receiver finished whose acks we never saw.
                for (let i = nextFile; i < fileIndex; i++) markDelivered(i);
                nextFile = fileIndex;
                startFile = fileIndex;
                startOffset = offset;
                console.log(`Sender: resuming at file ${fileIndex}, byte ${offset}`);
            }

            // 2. Send each remaining file and wait for the receiver to confirm it.
            for (let fileIdx = startFile; fileIdx < files.length; fileIdx++) {
                const file = files[fileIdx];
                const offset = fileIdx === startFile ? startOffset : 0;

                throwIfAborted(controller.signal);
                flow.fileIndex = fileIdx;
                flow.acked = offset;
                channel.send(encodeMessage(MSG.FILE_START, { batchId, fileIndex: fileIdx, offset }));

                const progress = createProgressThrottle((p) => onProgress?.(fileIdx, p));
                await sendFileChunks(channel, file, offset, progress, controller.signal, flow);

                const ackPromise = waitForMessage(
                    channel,
                    (m) => m.type === MSG.FILE_ACK && ofBatch(m) && m.fileIndex === fileIdx,
                    { ...opts, timeoutMs: ACK_TIMEOUT_MS, timeoutMessage: `The receiver didn't confirm "${file.name}"` }
                );
                channel.send(encodeMessage(MSG.FILE_COMPLETE, { batchId, fileIndex: fileIdx, size: file.size }));

                const ack = await ackPromise;
                if (!ack.ok) {
                    throw new TransferError(
                        `Receiver failed to verify "${file.name}": ${ack.reason || "size mismatch"}`,
                        "peer-error"
                    );
                }
                nextFile = fileIdx + 1;
                markDelivered(fileIdx);
            }

            // 3. Close out the batch.
            const doneAckPromise = waitForMessage(
                channel,
                (m) => m.type === MSG.TRANSFER_ACK && ofBatch(m),
                { ...opts, timeoutMs: ACK_TIMEOUT_MS, timeoutMessage: "The receiver didn't confirm the end of the transfer" }
            );
            channel.send(encodeMessage(MSG.TRANSFER_COMPLETE, { batchId, totalFiles: files.length }));
            const doneAck = await doneAckPromise;
            if (doneAck.ok === false) {
                throw new TransferError("Receiver reported missing files", "peer-error");
            }
        } catch (err) {
            const error = toTransferError(err);
            // Tell the receiver to drop its partial data, unless it is the one that
            // aborted, or the connection dropped (then the batch stays resumable).
            if (!isPeerError(error) && error.code !== "disconnected") {
                sendCancel(channel, error);
            }
            throw error;
        } finally {
            running = false;
            signal?.removeEventListener("abort", onExternalAbort);
            channel.removeEventListener("message", onPeerMessage);
        }
    }

    function sendCancel(channel, error) {
        if (channel?.readyState !== "open") return;
        try {
            channel.send(encodeMessage(MSG.TRANSFER_CANCEL, {
                batchId,
                error: error.code !== "cancelled",
                reason: error.code === "cancelled" ? "Sender cancelled the transfer" : error.message,
            }));
        } catch {
            // Channel closed between the check and the send; nothing to tell.
        }
    }

    return {
        batchId,
        run,
        /** Tell the receiver (on a new channel) that a suspended batch was cancelled. */
        sendCancel: (channel) => sendCancel(channel, new TransferError("cancelled", "cancelled")),
    };
}

/** Wait until the receiver has acked enough that sending `offset` stays within the window. */
function waitForWindow(channel, flow, offset, signal) {
    if (signal?.aborted) return Promise.reject(toTransferError(signal.reason));
    if (offset - flow.acked < RECEIVE_WINDOW) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            done();
            reject(new TransferError("The receiver stopped saving data", "timeout"));
        }, ACK_TIMEOUT_MS);
        const onAbort = () => {
            done();
            reject(toTransferError(signal.reason));
        };
        const onClose = () => {
            done();
            reject(new TransferError("The connection closed during the transfer", "disconnected"));
        };
        const done = () => {
            clearTimeout(timer);
            flow.wake = null;
            signal?.removeEventListener("abort", onAbort);
            channel.removeEventListener("close", onClose);
        };
        flow.wake = () => {
            if (offset - flow.acked < RECEIVE_WINDOW) {
                done();
                resolve();
            }
        };
        signal?.addEventListener("abort", onAbort);
        channel.addEventListener("close", onClose);
    });
}

async function sendFileChunks(channel, file, startOffset, onProgress, signal, flow) {
    let offset = startOffset;
    const report = () => onProgress(file.size > 0 ? Math.min(99, (offset / file.size) * 100) : 0);
    report();

    while (offset < file.size) {
        await waitForWindow(channel, flow, offset, signal);
        await waitForBufferDrain(channel, { signal });

        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        throwIfAborted(signal);
        if (channel.readyState !== "open") {
            throw new TransferError("The connection closed during the transfer", "disconnected");
        }
        channel.send(buffer);
        offset += buffer.byteLength;

        // Report < 100 until the receiver acks, so the UI never shows
        // "done" for data that is merely buffered locally.
        report();
    }
}

/** One-shot helper: send `files` over `channel` with no resume support. */
export default function sendFilesOverDataChannel(channel, files, { onProgress, onFileComplete, signal } = {}) {
    return createBatchSender(files, { onProgress, onFileComplete }).run(channel, { signal });
}
