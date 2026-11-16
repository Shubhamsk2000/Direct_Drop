// Shared wire protocol for the file-transfer data channel.
// Control messages are JSON strings; file data is sent as raw ArrayBuffers.

// v2: every batch carries a `batchId` that all replies echo, plus `transfer-cancel`.
// v3: receiver flow control via `chunk-ack`.
// v4: resume after reconnect (`batch-resume` / `resume`, `file-start.offset`).
export const PROTOCOL_VERSION = 4;

// 64 KiB is safely below every browser's SCTP message size limit.
export const CHUNK_SIZE = 64 * 1024;
// Pause sending when this much data is queued in the channel...
export const MAX_BUFFERED_AMOUNT = 1024 * 1024;
// ...and resume once it drains below this (fires `bufferedamountlow`).
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

// Flow control: the receiver acks every RECEIVER_ACK_INTERVAL bytes it has
// persisted, and the sender never has more than RECEIVE_WINDOW bytes of a
// file un-acked. This bounds receiver memory when its disk is slower than
// the network (data channel messages can't be paused on the receiving end).
export const RECEIVE_WINDOW = 8 * 1024 * 1024;
export const RECEIVER_ACK_INTERVAL = 1024 * 1024;

// Resume: how long the receiver keeps a suspended batch (and its partial file)
// waiting for the sender to reconnect before discarding it.
export const RESUME_TIMEOUT_MS = 2 * 60 * 1000;
// Sender auto-reconnect backoff; one attempt per entry.
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

// How long to wait for the receiver to accept a batch.
export const HANDSHAKE_TIMEOUT_MS = 15_000;
// How long to wait for a file-ack / transfer-ack, or for the send buffer to drain.
export const ACK_TIMEOUT_MS = 30_000;
// Receiver gives up if nothing arrives for this long during an active batch.
export const RECEIVER_IDLE_TIMEOUT_MS = 30_000;

export const MSG = Object.freeze({
    // sender -> receiver
    BATCH_METADATA: "batch-metadata",
    // after a reconnect: same payload as batch-metadata, asks "where were we?"
    BATCH_RESUME: "batch-resume",
    FILE_START: "file-start", // { batchId, fileIndex, offset } – offset > 0 continues a partial file
    FILE_COMPLETE: "file-complete",
    TRANSFER_COMPLETE: "transfer-complete",
    // receiver -> sender
    BATCH_READY: "batch-ready",
    BATCH_REJECT: "batch-reject",
    // reply to batch-resume: continue at { fileIndex, offset }, or { done: true }
    // if the receiver already finished the batch (its final ack was lost).
    RESUME: "resume",
    FILE_ACK: "file-ack",
    TRANSFER_ACK: "transfer-ack",
    CHUNK_ACK: "chunk-ack", // { batchId, fileIndex, receivedBytes } – bytes persisted so far
    // either direction: abort the batch. `{ batchId, reason, error }` where
    // `error: true` means a failure rather than a user cancellation.
    TRANSFER_CANCEL: "transfer-cancel",
});

/**
 * Error with a machine-readable `code`:
 *   cancelled       – cancelled locally by the user
 *   peer-cancelled  – the other side cancelled
 *   peer-error      – the other side reported a failure (reject, nack, ...)
 *   timeout         – the other side stopped responding
 *   disconnected    – the connection was lost
 *   error           – anything else
 */
export class TransferError extends Error {
    constructor(message, code = "error") {
        super(message);
        this.name = "TransferError";
        this.code = code;
    }
}

export function toTransferError(err) {
    if (err instanceof TransferError) return err;
    return new TransferError(err?.message || String(err), "error");
}

/** True when the error originated on the peer, so we must not echo a cancel back. */
export function isPeerError(err) {
    return err?.code === "peer-cancelled" || err?.code === "peer-error";
}

export function isCancellation(err) {
    return err?.code === "cancelled" || err?.code === "peer-cancelled";
}

/** Short random id; doesn't need crypto.randomUUID (unavailable over plain http on LAN). */
export function makeBatchId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw toTransferError(signal.reason ?? new TransferError("Aborted", "cancelled"));
}

const KNOWN_TYPES = new Set(Object.values(MSG));

export function encodeMessage(type, payload = {}) {
    return JSON.stringify({ ...payload, type });
}

/**
 * Parse a control message. Returns null (and logs) for anything malformed,
 * so callers never have to try/catch.
 */
export function parseMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        console.warn("Protocol: ignoring non-JSON control message");
        return null;
    }
    if (!msg || typeof msg !== "object" || !KNOWN_TYPES.has(msg.type)) {
        console.warn("Protocol: ignoring unknown control message", msg?.type);
        return null;
    }
    return msg;
}

/** Shape of a batch's file list as sent in batch-metadata / batch-resume. */
export function describeFiles(files) {
    return files.map((file, idx) => ({ index: idx, name: file.name, size: file.size, type: file.type }));
}

/** True if two batch file lists describe the same files. */
export function sameFiles(a, b) {
    return a.length === b.length && a.every((f, i) => f.name === b[i].name && f.size === b[i].size);
}

/** Validate a batch-metadata / batch-resume message; returns an error string or null. */
export function validateBatchMetadata(msg) {
    if (msg.version !== PROTOCOL_VERSION) {
        return `Unsupported protocol version ${msg.version} (expected ${PROTOCOL_VERSION})`;
    }
    if (typeof msg.batchId !== "string" || msg.batchId.length === 0) {
        return "Batch is missing an id";
    }
    if (!Array.isArray(msg.files) || msg.files.length === 0) {
        return "Batch contains no files";
    }
    for (const [i, f] of msg.files.entries()) {
        if (
            !f ||
            f.index !== i ||
            typeof f.name !== "string" ||
            !Number.isSafeInteger(f.size) ||
            f.size < 0
        ) {
            return `Invalid metadata for file ${i}`;
        }
    }
    return null;
}

/** Normalise incoming binary data to an ArrayBuffer (Firefox may hand us Blobs). */
export async function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (data instanceof Blob) return data.arrayBuffer();
    return null;
}

/**
 * Resolve with the first control message on `channel` matching `predicate`.
 * Rejects (with a TransferError) if the channel closes/errors, `signal`
 * aborts, or `timeoutMs` elapses first.
 */
export function waitForMessage(channel, predicate, { timeoutMs = 0, timeoutMessage, signal } = {}) {
    return new Promise((resolve, reject) => {
        let timer = null;

        const cleanup = () => {
            channel.removeEventListener("message", onMessage);
            channel.removeEventListener("close", onClose);
            channel.removeEventListener("error", onClose);
            signal?.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
        };
        const onMessage = (event) => {
            if (typeof event.data !== "string") return;
            const msg = parseMessage(event.data);
            if (msg && predicate(msg)) {
                cleanup();
                resolve(msg);
            }
        };
        const onClose = () => {
            cleanup();
            reject(new TransferError("The connection closed before the other device responded", "disconnected"));
        };
        const onAbort = () => {
            cleanup();
            reject(toTransferError(signal.reason));
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }
        if (channel.readyState !== "open") {
            reject(new TransferError("Data channel is not open", "disconnected"));
            return;
        }
        channel.addEventListener("message", onMessage);
        channel.addEventListener("close", onClose);
        channel.addEventListener("error", onClose);
        signal?.addEventListener("abort", onAbort);
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                cleanup();
                reject(new TransferError(timeoutMessage || "Timed out waiting for the other device", "timeout"));
            }, timeoutMs);
        }
    });
}

/**
 * Wait until the channel's send buffer has drained below the low threshold.
 * Event-driven (no polling); rejects if the channel closes, `signal` aborts,
 * or nothing drains for `timeoutMs` (the receiver has stalled).
 */
export function waitForBufferDrain(channel, { signal, timeoutMs = ACK_TIMEOUT_MS } = {}) {
    if (signal?.aborted) return Promise.reject(toTransferError(signal.reason));
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new TransferError("The receiver stopped accepting data", "timeout"));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            channel.removeEventListener("bufferedamountlow", onLow);
            channel.removeEventListener("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        };
        const onLow = () => {
            cleanup();
            resolve();
        };
        const onClose = () => {
            cleanup();
            reject(new TransferError("The connection closed during the transfer", "disconnected"));
        };
        const onAbort = () => {
            cleanup();
            reject(toTransferError(signal.reason));
        };
        channel.addEventListener("bufferedamountlow", onLow);
        channel.addEventListener("close", onClose);
        signal?.addEventListener("abort", onAbort);
    });
}

/** Returns a function that only calls `fn` when the whole-percent value changes. */
export function createProgressThrottle(fn) {
    let last = -1;
    return (percent) => {
        const rounded = Math.floor(percent);
        if (rounded !== last) {
            last = rounded;
            fn(rounded);
        }
    };
}
