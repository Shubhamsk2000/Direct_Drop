// Where received files are written while they stream in.
//
// Backends, in order of preference:
//   1. directory – a folder the user picked with showDirectoryPicker (Chromium).
//                  Files are written straight to their final location.
//   2. opfs      – Origin Private File System. Disk-backed; the finished file
//                  is handed to the browser's normal download flow.
//   3. memory    – chunks held in RAM, assembled into a Blob (old behaviour).
//
// Every backend produces "sinks" with the same interface:
//   write(ArrayBuffer) -> Promise
//   close()            -> Promise<{ blob?: Blob, savedAs?: string }>
//   abort()            -> Promise   (discard partial data; never throws)

const OPFS_DIR = "directdrop-incoming";
// OPFS leftovers older than this are deleted (finished downloads, crashed tabs).
const OPFS_MAX_AGE_MS = 30 * 60 * 1000;
// Keep this much headroom when checking the storage quota.
const QUOTA_MARGIN_BYTES = 50 * 1024 * 1024;
// Above this, an in-memory transfer gets a warning.
export const MEMORY_WARN_BYTES = 500 * 1024 * 1024;

// ---------------------------------------------------------------- helpers

/** Make a sender-supplied name safe to use as a file name. */
export function sanitizeFileName(name) {
    let clean = String(name ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
        .trim()
        .replace(/^\.+/, "")    // no hidden files / "." / ".."
        .replace(/[. ]+$/, ""); // Windows strips trailing dots/spaces
    if (clean.length > 200) {
        const dot = clean.lastIndexOf(".");
        const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
        clean = clean.slice(0, 200 - ext.length) + ext;
    }
    return clean || "file";
}

function withSuffix(name, n) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function exists(dir, name) {
    try {
        await dir.getFileHandle(name);
        return true;
    } catch {
        return false;
    }
}

async function safeRemove(dir, name) {
    try {
        await dir.removeEntry(name);
    } catch {
        // already gone / still locked – the OPFS sweep will get it later
    }
}

function writableSink(writable, { onClose, onAbort }) {
    let finished = false;
    return {
        write: (buffer) => writable.write(buffer),
        async close() {
            finished = true;
            await writable.close();
            return onClose();
        },
        async abort() {
            if (finished) return;
            finished = true;
            try {
                await writable.abort();
            } catch {
                // ignore
            }
            await onAbort();
        },
    };
}

// ---------------------------------------------------------------- directory

export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/** Must be called from a user gesture (click). Resolves null if the user dismisses it. */
export async function pickDirectory() {
    try {
        return await window.showDirectoryPicker({ id: "directdrop", mode: "readwrite" });
    } catch (err) {
        if (err?.name === "AbortError") return null;
        throw err;
    }
}

async function hasWritePermission(dir) {
    try {
        return (await dir.queryPermission({ mode: "readwrite" })) === "granted";
    } catch {
        return false;
    }
}

function directoryStore(dir) {
    return {
        kind: "directory",
        async openFile(info) {
            // Never overwrite an existing file: pick "name (1).ext" etc.
            const base = sanitizeFileName(info.name);
            let name = base;
            for (let n = 1; await exists(dir, name); n++) name = withSuffix(base, n);

            const handle = await dir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            return writableSink(writable, {
                onClose: () => ({ savedAs: name }),
                onAbort: () => safeRemove(dir, name),
            });
        },
    };
}

// ---------------------------------------------------------------- OPFS

let opfsProbe = null;

/** Resolves the OPFS working directory, or null if OPFS + createWritable is unusable. */
function getOpfsDir() {
    opfsProbe ??= (async () => {
        try {
            if (!navigator.storage?.getDirectory) return null;
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
            // Safari < 26 has OPFS but only sync access handles (workers).
            const probe = await dir.getFileHandle(".probe", { create: true });
            if (typeof probe.createWritable !== "function") return null;
            const w = await probe.createWritable();
            await w.abort();
            await safeRemove(dir, ".probe");
            return dir;
        } catch (err) {
            console.warn("Storage: OPFS unavailable:", err?.message || err);
            return null;
        }
    })();
    return opfsProbe;
}

/** Delete OPFS leftovers older than `maxAgeMs`. Safe to call any time. */
export async function sweepOpfs(maxAgeMs = OPFS_MAX_AGE_MS) {
    const dir = await getOpfsDir();
    if (!dir) return;
    const cutoff = Date.now() - maxAgeMs;
    try {
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== "file") continue;
            try {
                const file = await handle.getFile();
                if (file.lastModified < cutoff) await safeRemove(dir, name);
            } catch {
                // locked by an active writer – skip
            }
        }
    } catch (err) {
        console.warn("Storage: OPFS sweep failed:", err?.message || err);
    }
}

async function availableBytes() {
    try {
        const { quota, usage } = await navigator.storage.estimate();
        return typeof quota === "number" ? quota - (usage || 0) : 0;
    } catch {
        return 0;
    }
}

function opfsStore(dir, batchId) {
    return {
        kind: "opfs",
        async openFile(info, index) {
            const name = `${batchId}-${index}`;
            const handle = await dir.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            return writableSink(writable, {
                onClose: async () => {
                    const file = await handle.getFile();
                    // Re-wrap so the download gets the right MIME type; still disk-backed.
                    return { blob: file.slice(0, file.size, info.type || "application/octet-stream") };
                },
                onAbort: () => safeRemove(dir, name),
            });
        },
    };
}

// ---------------------------------------------------------------- memory

function memoryStore() {
    return {
        kind: "memory",
        async openFile(info) {
            let chunks = [];
            return {
                write: async (buffer) => {
                    chunks.push(buffer);
                },
                close: async () => {
                    const blob = new Blob(chunks, { type: info.type || "application/octet-stream" });
                    chunks = null;
                    return { blob };
                },
                abort: async () => {
                    chunks = null;
                },
            };
        },
    };
}

// ---------------------------------------------------------------- planning

function formatBytes(n) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    return `${Math.round(n / 1024 ** 2)} MB`;
}

/**
 * Pick a storage backend for a batch.
 * @param {string} batchId
 * @param {number} totalBytes
 * @param {{ directory?: FileSystemDirectoryHandle | null }} opts
 * @returns {Promise<{ kind: string, warning: string | null, openFile: Function }>}
 */
export async function prepareBatchStorage(batchId, totalBytes, { directory } = {}) {
    let warning = null;

    if (directory) {
        if (await hasWritePermission(directory)) {
            return { ...directoryStore(directory), warning };
        }
        warning = `Lost permission to write to "${directory.name}". Choose the folder again to save there.`;
    }

    const dir = await getOpfsDir();
    if (dir) {
        const free = await availableBytes();
        if (free >= totalBytes + QUOTA_MARGIN_BYTES) {
            return { ...opfsStore(dir, batchId), warning };
        }
        console.warn(`Storage: OPFS has ${free} bytes free, batch needs ${totalBytes}`);
    }

    if (totalBytes > MEMORY_WARN_BYTES) {
        const tip = supportsDirectoryPicker()
            ? " Choose a download folder to save large files directly to disk."
            : "";
        warning = `This ${formatBytes(totalBytes)} transfer is being held in memory and may fail ` +
            `or slow down your device.${tip}`;
    }
    return { ...memoryStore(), warning };
}
