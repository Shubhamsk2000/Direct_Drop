import { useEffect, useState, useRef, useCallback } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import { watchPeerConnection } from "../webrtc/connectionMonitor.js";
import createMultiFileReceiver from "../webrtc/fileReceiver.js";
import {
    prepareBatchStorage,
    pickDirectory,
    supportsDirectoryPicker,
    sweepOpfs,
} from "../webrtc/storage.js";

/**
 * Receiver side of a P2P session.
 *
 * status: idle          – waiting for the sender's offer
 *         connecting    – WebRTC negotiation in progress
 *         connected     – data channel open, waiting for a batch
 *         receiving     – batch in progress
 *         complete      – last batch received and verified
 *         cancelled     – last batch cancelled (by either side)
 *         reconnecting  – connection dropped mid-batch; waiting for the sender to resume
 *         error         – last batch failed (see `error`)
 *         disconnected  – connection lost while idle (see `error`)
 */
export function useP2PReceiver(socket, roomId) {
    const [status, setStatus] = useState("idle");
    const [filesMetadata, setFilesMetadata] = useState([]);
    const [filesProgress, setFilesProgress] = useState([]);
    const [completedFiles, setCompletedFiles] = useState([]);
    const [error, setError] = useState(null);
    // Where the current batch is stored: { kind: "directory" | "opfs" | "memory", warning }
    const [storageInfo, setStorageInfo] = useState(null);
    // Per-file name it was saved under when writing to a chosen folder.
    const [savedNames, setSavedNames] = useState({});
    // Folder chosen with showDirectoryPicker (Chromium only); null = browser downloads.
    const [saveDirectory, setSaveDirectory] = useState(null);
    const saveDirectoryRef = useRef(null);

    // Current connection: { sid, peer, channel, pendingCandidates, stopMonitor }
    // `sid` is the sender's connection-attempt id from the offer; signaling for
    // other attempts (stale or replayed after a socket reconnect) is ignored.
    const sessionRef = useRef(null);
    // Protocol receiver for the current room (survives reconnects).
    const receiverRef = useRef(null);

    const clearBatch = useCallback(() => {
        setFilesMetadata([]);
        setFilesProgress([]);
        setCompletedFiles([]);
        setError(null);
        setStorageInfo(null);
        setSavedNames({});
    }, []);

    // Clear disk-backed leftovers from earlier sessions (finished downloads, crashed tabs).
    useEffect(() => {
        sweepOpfs();
    }, []);

    useEffect(() => {
        if (!socket || !roomId) {
            setStatus("idle");
            clearBatch();
            return;
        }

        // One protocol receiver per room: it outlives individual peer connections,
        // so a batch interrupted by a connection drop can resume on the next one.
        const receiver = createMultiFileReceiver({
            send: (msg) => {
                const channel = sessionRef.current?.channel;
                if (channel?.readyState === "open") channel.send(msg);
            },
            prepareStorage: (batchId, totalBytes) => {
                // Opportunistic cleanup of old OPFS files before taking more space.
                sweepOpfs();
                return prepareBatchStorage(batchId, totalBytes, { directory: saveDirectoryRef.current });
            },
            onBatchMetadata: (filesInfo, storage) => {
                console.log("Receiver: metadata for", filesInfo.length, "files, storage:", storage.kind);
                setFilesMetadata(filesInfo);
                setFilesProgress(filesInfo.map(() => 0));
                setCompletedFiles([]);
                setSavedNames({});
                setStorageInfo(storage);
                setError(null);
                setStatus("receiving");
            },
            onProgress: (fileIndex, progress) => {
                setFilesProgress((prev) => {
                    const next = [...prev];
                    next[fileIndex] = progress;
                    return next;
                });
            },
            // File verified (byte count matches): either already in the chosen
            // folder, or a (disk- or memory-backed) Blob to hand to the browser.
            onFileComplete: (fileIndex, result, filename) => {
                if (result.savedAs) {
                    setSavedNames((prev) => ({ ...prev, [fileIndex]: result.savedAs }));
                } else if (result.blob) {
                    downloadBlob(result.blob, filename);
                }
                setCompletedFiles((prev) => [...prev, fileIndex]);
            },
            onAllComplete: () => setStatus("complete"),
            onError: (message) => {
                setError(message);
                setStatus("error");
            },
            onCancelled: (message) => {
                setError(message);
                setStatus("cancelled");
            },
            onResumed: () => {
                setError(null);
                setStatus("receiving");
            },
        });

        /** Close the current peer connection; the receiver (and any batch) is untouched. */
        const teardown = () => {
            const session = sessionRef.current;
            if (!session) return;
            sessionRef.current = null;
            session.stopMonitor();
            if (session.channel) {
                session.channel.onopen = session.channel.onclose = session.channel.onerror = null;
                session.channel.onmessage = null;
                session.channel.close();
            }
            session.peer.close();
        };

        const connectionLost = (message) => {
            console.warn("Receiver: connection lost:", message);
            teardown();
            setError(message);
            // Mid-batch: keep the partial file and wait for the sender to reconnect.
            setStatus(receiver.suspend() ? "reconnecting" : "disconnected");
        };

        const createSession = (sid) => {
            teardown();
            // A new offer while a batch is running means the sender saw the old
            // connection die before we did.
            if (receiver.isActive()) receiver.suspend();

            console.log("Receiver: Setting up peer connection");
            const peer = createPeerConnection({
                onIceCandidate: (candidate) => socket.emit("webrtc-ice-candidate", { candidate, sid }),
            });
            const session = { sid, peer, channel: null, pendingCandidates: [], stopMonitor: () => {} };
            sessionRef.current = session;
            const isCurrent = () => sessionRef.current === session;

            peer.ondatachannel = (e) => {
                if (!isCurrent()) return;
                console.log("Receiver: Data channel received");
                const channel = e.channel;
                // Firefox defaults to "blob"; ArrayBuffer avoids an async conversion per chunk.
                channel.binaryType = "arraybuffer";
                session.channel = channel;

                channel.onmessage = (event) => receiver.handleData(event.data);
                channel.onopen = () => {
                    if (!isCurrent()) return;
                    console.log("Receiver: Data channel OPEN");
                    if (receiver.isSuspended()) {
                        // Keep the file list; the sender will send batch-resume.
                        setStatus("reconnecting");
                    } else {
                        clearBatch();
                        setStatus("connected");
                    }
                };
                channel.onerror = (event) => {
                    // A close event always follows; that's where we handle it.
                    console.error("Receiver: Data channel ERROR", event?.error || event);
                };
                channel.onclose = () => {
                    if (!isCurrent()) return;
                    console.log("Receiver: Data channel CLOSED");
                    connectionLost("The connection to the sender was closed.");
                };
            };

            session.stopMonitor = watchPeerConnection(peer, {
                onFailed: (message) => isCurrent() && connectionLost(message),
            });

            setStatus(receiver.isSuspended() ? "reconnecting" : "connecting");
            return session;
        };

        // Every offer starts a fresh connection (first connect or sender-initiated reconnect).
        const onOffer = async ({ offer, sid }) => {
            const session = createSession(sid);
            try {
                console.log("Receiver: Received offer");
                await session.peer.setRemoteDescription(offer);
                const answer = await session.peer.createAnswer();
                await session.peer.setLocalDescription(answer);
                if (sessionRef.current !== session) return;
                socket.emit("webrtc-answer", { answer, sid });
                console.log("Receiver: Answer sent");

                for (const candidate of session.pendingCandidates.splice(0)) {
                    try {
                        await session.peer.addIceCandidate(candidate);
                    } catch (err) {
                        console.error("Receiver: Error adding queued ICE candidate:", err);
                    }
                }
            } catch (err) {
                console.error("Receiver: Error handling offer:", err);
                if (sessionRef.current === session) {
                    connectionLost(`Couldn't complete the connection: ${err.message}`);
                }
            }
        };

        const onIceCandidate = async ({ candidate, sid }) => {
            const session = sessionRef.current;
            if (!session || !candidate) return;
            if (sid !== undefined && sid !== session.sid) return; // for another attempt
            if (!session.peer.remoteDescription) {
                session.pendingCandidates.push(candidate);
                return;
            }
            try {
                await session.peer.addIceCandidate(candidate);
            } catch (err) {
                console.error("Receiver: Error adding ICE candidate:", err);
            }
        };

        // The sender leaving closes the room (it can't resume), so drop everything.
        // SocketContext also resets roomId, which re-runs this effect.
        const onPeerDisconnected = () => {
            const wasReceiving = receiver.abort();
            teardown();
            if (wasReceiving) {
                setError("The sender disconnected.");
                setStatus("error");
            } else {
                setStatus("idle");
            }
        };

        socket.on("webrtc-offer", onOffer);
        socket.on("webrtc-ice-candidate", onIceCandidate);
        socket.on("peer-disconnected", onPeerDisconnected);
        receiverRef.current = receiver;

        return () => {
            socket.off("webrtc-offer", onOffer);
            socket.off("webrtc-ice-candidate", onIceCandidate);
            socket.off("peer-disconnected", onPeerDisconnected);
            teardown();
            receiver.abort();
            receiverRef.current = null;
        };
    }, [socket, roomId, clearBatch]);

    const cancelTransfer = useCallback(() => {
        receiverRef.current?.cancel();
    }, []);

    /** Must be called from a click handler. Applies from the next batch on. */
    const chooseSaveDirectory = useCallback(async () => {
        try {
            const dir = await pickDirectory();
            if (!dir) return;
            saveDirectoryRef.current = dir;
            setSaveDirectory(dir);
        } catch (err) {
            console.error("Receiver: couldn't pick a folder:", err);
            setError(`Couldn't use that folder: ${err?.message || err}`);
        }
    }, []);

    const clearSaveDirectory = useCallback(() => {
        saveDirectoryRef.current = null;
        setSaveDirectory(null);
    }, []);

    return {
        status,
        filesMetadata,
        filesProgress,
        completedFiles,
        error,
        cancelTransfer,
        storageInfo,
        savedNames,
        saveDirectoryName: saveDirectory?.name ?? null,
        canChooseDirectory: supportsDirectoryPicker(),
        chooseSaveDirectory,
        clearSaveDirectory,
    };
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a delay so the download has time to start.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
