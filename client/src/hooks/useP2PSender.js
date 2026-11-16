import { useEffect, useState, useCallback, useRef } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import { watchPeerConnection } from "../webrtc/connectionMonitor.js";
import { createBatchSender } from "../webrtc/fileSender.js";
import { TransferError, isCancellation, makeBatchId, RECONNECT_DELAYS_MS } from "../webrtc/protocol.js";

/**
 * Sender side of a P2P session.
 *
 * state: idle          – no receiver / no connection yet
 *        connecting    – WebRTC negotiation in progress
 *        ready         – data channel open, can send
 *        sending       – batch in progress
 *        reconnecting  – connection dropped mid-batch; retrying, will resume
 *        complete      – last batch delivered and acked
 *        cancelled     – last batch cancelled (by either side)
 *        error         – last batch or the connection failed (see `error`)
 *
 * A batch interrupted by a connection drop is kept (`batchRef`) and resumed
 * from the receiver's last stored byte once a new data channel opens, either
 * after an automatic retry or a manual `reconnect()`.
 *
 * Retries need signaling, so they pause while our socket or the receiver's is
 * offline (`waitingForPeer`) and restart as soon as both are back. Every
 * connection attempt has an id (`sid`) sent with its offer and candidates;
 * answers/candidates for any other attempt (e.g. replayed after a socket
 * reconnect) are ignored.
 */
export function useP2PSender(socket, roomId) {
    const [state, setState] = useState("idle");
    const [channelOpen, setChannelOpen] = useState(false);
    const [filesProgress, setFilesProgress] = useState([]);
    const [currentFileIndex, setCurrentFileIndex] = useState(-1);
    const [error, setError] = useState(null);
    const [reconnectAttempt, setReconnectAttempt] = useState(0);
    // Signaling to the receiver is down (either socket); retries are paused.
    const [waitingForPeer, setWaitingForPeer] = useState(false);
    // Mirrors `batchRef.current !== null` for rendering.
    const [hasBatch, setHasBatch] = useState(false);

    // Current connection attempt: { sid, peer, channel, pendingCandidates, stopMonitor }
    const sessionRef = useRef(null);
    // Batch being sent or waiting to resume: createBatchSender() result.
    const batchRef = useRef(null);
    // AbortController of the run() in flight, if any.
    const transferRef = useRef(null);
    // Id of a batch cancelled while disconnected; the receiver is told on reconnect.
    const cancelledBatchRef = useRef(null);
    // Functions bound to the current socket/room by the effect.
    const actionsRef = useRef(null);

    const setBatch = useCallback((batch) => {
        batchRef.current = batch;
        setHasBatch(!!batch);
    }, []);

    useEffect(() => {
        if (!socket || !roomId) {
            setState("idle");
            setChannelOpen(false);
            setFilesProgress([]);
            setCurrentFileIndex(-1);
            setError(null);
            setBatch(null);
            return;
        }

        let receiverPresent = false;
        // Signaling health: the receiver's socket (server tells us) and our own.
        let receiverOnline = true;
        let signalingUp = socket.connected;
        let attempts = 0;
        let retryTimer = null;

        const canSignal = () => receiverPresent && receiverOnline && signalingUp;

        const clearRetry = () => {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
        };

        const teardown = () => {
            const session = sessionRef.current;
            if (!session) return;
            sessionRef.current = null;
            session.stopMonitor();
            session.channel.onopen = session.channel.onclose = session.channel.onerror = null;
            session.channel.close();
            session.peer.close();
            setChannelOpen(false);
        };

        /** Abort the run() in flight (the batch itself is kept). */
        const abortRun = (message, code) => {
            transferRef.current?.abort(new TransferError(message, code));
        };

        /** Give up on the current batch entirely. */
        const dropBatch = (message, code) => {
            abortRun(message, code);
            setBatch(null);
            clearRetry();
        };

        /** Run (or resume) the current batch on the open channel. */
        const runBatch = async () => {
            const batch = batchRef.current;
            const session = sessionRef.current;
            if (!batch || !session || transferRef.current) return;

            const controller = new AbortController();
            transferRef.current = controller;
            setState("sending");
            setError(null);

            try {
                await batch.run(session.channel, { signal: controller.signal });
                if (batchRef.current === batch) setBatch(null);
                console.log("All files sent successfully");
                setState("complete");
            } catch (err) {
                console.warn("Sender: batch stopped:", err?.code, err?.message);
                // Connection dropped: keep the batch; connectionLost() handles retries.
                if (err?.code === "disconnected" && batchRef.current === batch) {
                    if (sessionRef.current === session) connectionLost(err.message);
                    return;
                }
                if (batchRef.current === batch) setBatch(null);
                // If the session was torn down for another reason, that path set the state.
                if (sessionRef.current === session) {
                    setError(err?.message || "Transfer failed");
                    setState(isCancellation(err) ? "cancelled" : "error");
                }
            } finally {
                if (transferRef.current === controller) transferRef.current = null;
                setCurrentFileIndex(-1);
            }
        };

        const scheduleReconnect = (message) => {
            clearRetry();
            if (!canSignal()) {
                // Can't negotiate right now; resumeSignaling() reconnects once
                // both sides are back. Doesn't use up a retry.
                setWaitingForPeer(true);
                setError(signalingUp
                    ? "Waiting for the receiver to come back online…"
                    : "Waiting for the connection to the server…");
                setState("reconnecting");
                return;
            }
            if (attempts >= RECONNECT_DELAYS_MS.length) {
                setError(`${message} Couldn't reconnect automatically.`);
                setState("error");
                return;
            }
            const delay = RECONNECT_DELAYS_MS[attempts++];
            setReconnectAttempt(attempts);
            setError(message);
            setState("reconnecting");
            console.log(`Sender: reconnect attempt ${attempts} in ${delay} ms`);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (!batchRef.current) return;
                if (canSignal()) connect();
                else scheduleReconnect(message); // went offline meanwhile: wait
            }, delay);
        };

        /** Signaling is back on both ends: reconnect if the data channel is down. */
        const resumeSignaling = () => {
            if (!canSignal()) return;
            setWaitingForPeer(false);
            if (sessionRef.current?.channel.readyState === "open") return; // P2P link survived
            if (!batchRef.current && !sessionRef.current) return; // nothing to restore
            console.log("Sender: signaling back, reconnecting");
            attempts = 0;
            connect();
        };

        const connectionLost = (message) => {
            console.warn("Sender: connection lost:", message);
            abortRun(message, "disconnected");
            teardown();
            if (batchRef.current && receiverPresent) {
                scheduleReconnect(message);
            } else {
                setError(message);
                setState("error");
            }
        };

        const connect = () => {
            clearRetry();
            abortRun("Reconnecting", "disconnected");
            teardown();

            console.log("Sender: Setting up peer connection");
            const sid = makeBatchId();
            const peer = createPeerConnection({
                onIceCandidate: (candidate) => socket.emit("webrtc-ice-candidate", { candidate, sid }),
            });
            const channel = peer.createDataChannel("file-channel", { ordered: true });
            const session = { sid, peer, channel, pendingCandidates: [], stopMonitor: () => {} };
            sessionRef.current = session;
            const isCurrent = () => sessionRef.current === session;

            channel.onopen = () => {
                if (!isCurrent()) return;
                console.log("Sender: DataChannel OPEN");
                attempts = 0;
                setReconnectAttempt(0);
                setChannelOpen(true);
                setWaitingForPeer(false);

                // A batch cancelled while we were offline: let the receiver discard it.
                if (cancelledBatchRef.current) {
                    cancelledBatchRef.current.sendCancel(channel);
                    cancelledBatchRef.current = null;
                }
                if (batchRef.current) {
                    runBatch(); // resume
                } else {
                    setError(null);
                    setState("ready");
                }
            };
            channel.onclose = () => {
                if (!isCurrent()) return;
                console.log("Sender: DataChannel CLOSED");
                connectionLost("The connection to the receiver was closed.");
            };
            channel.onerror = (event) => {
                // A close event always follows; that's where we handle it.
                console.error("Sender: DataChannel ERROR", event?.error || event);
            };

            session.stopMonitor = watchPeerConnection(peer, {
                onFailed: (message) => isCurrent() && connectionLost(message),
            });

            if (!batchRef.current) {
                setError(null);
                setState("connecting");
            }

            (async () => {
                try {
                    const offer = await peer.createOffer();
                    await peer.setLocalDescription(offer);
                    if (!isCurrent()) return;
                    socket.emit("webrtc-offer", { offer, sid });
                    console.log("Sender: Offer sent");
                } catch (err) {
                    console.error("Sender: Error creating offer:", err);
                    if (isCurrent()) connectionLost(`Couldn't start the connection: ${err.message}`);
                }
            })();
        };

        const onPeerConnected = () => {
            receiverPresent = true;
            receiverOnline = true;
            setWaitingForPeer(false);
            attempts = 0;
            // A receiver that (re)joined the room is a fresh page: it can't resume.
            if (batchRef.current) {
                dropBatch("The receiver rejoined; the interrupted transfer can't be resumed.", "disconnected");
                setError("The receiver rejoined, so the interrupted transfer was discarded. Send again to restart.");
            }
            connect();
        };

        const onPeerDisconnected = () => {
            receiverPresent = false;
            receiverOnline = true;
            setWaitingForPeer(false);
            const hadBatch = !!batchRef.current;
            dropBatch("The receiver disconnected.", "disconnected");
            teardown();
            if (hadBatch) {
                setError("The receiver disconnected.");
                setState("error");
            } else {
                setState("idle");
            }
        };

        // The receiver's socket dropped. The P2P link may still be fine, so
        // keep it; just don't start new negotiations until it's back.
        const onPeerOffline = () => {
            receiverOnline = false;
            if (retryTimer && batchRef.current) scheduleReconnect("The receiver lost its connection.");
        };
        const onPeerReconnected = () => {
            receiverOnline = true;
            resumeSignaling();
        };
        const onSocketDisconnect = () => {
            signalingUp = false;
            if (retryTimer && batchRef.current) scheduleReconnect("Lost the connection to the server.");
        };
        const onSocketConnect = () => {
            signalingUp = true;
            // Not recovered → SocketContext clears the room and this effect re-runs.
            if (socket.recovered) resumeSignaling();
        };

        /** Ignore signaling for any connection attempt other than the current one. */
        const isForSession = (session, sid) => sid === undefined || sid === session.sid;

        const onAnswer = async ({ answer, sid }) => {
            const session = sessionRef.current;
            if (!session || !isForSession(session, sid)) return;
            try {
                console.log("Sender: Received answer, setting remote description");
                await session.peer.setRemoteDescription(answer);
                for (const candidate of session.pendingCandidates.splice(0)) {
                    try {
                        await session.peer.addIceCandidate(candidate);
                    } catch (err) {
                        console.error("Sender: Error adding queued ICE candidate:", err);
                    }
                }
            } catch (err) {
                console.error("Sender: Error setting remote description:", err);
                if (sessionRef.current === session) {
                    connectionLost(`Couldn't complete the connection: ${err.message}`);
                }
            }
        };

        const onIceCandidate = async ({ candidate, sid }) => {
            const session = sessionRef.current;
            if (!session || !candidate || !isForSession(session, sid)) return;
            if (!session.peer.remoteDescription) {
                session.pendingCandidates.push(candidate);
                return;
            }
            try {
                await session.peer.addIceCandidate(candidate);
            } catch (err) {
                console.error("Sender: Error adding ICE candidate:", err);
            }
        };

        socket.on("peer-connected", onPeerConnected);
        socket.on("peer-disconnected", onPeerDisconnected);
        socket.on("webrtc-answer", onAnswer);
        socket.on("webrtc-ice-candidate", onIceCandidate);
        socket.on("peer-offline", onPeerOffline);
        socket.on("peer-reconnected", onPeerReconnected);
        socket.on("disconnect", onSocketDisconnect);
        socket.on("connect", onSocketConnect);

        actionsRef.current = {
            runBatch,
            connect: () => {
                attempts = 0;
                connect();
            },
            clearRetry,
            hasReceiver: () => receiverPresent,
        };

        return () => {
            socket.off("peer-connected", onPeerConnected);
            socket.off("peer-disconnected", onPeerDisconnected);
            socket.off("webrtc-answer", onAnswer);
            socket.off("webrtc-ice-candidate", onIceCandidate);
            socket.off("peer-offline", onPeerOffline);
            socket.off("peer-reconnected", onPeerReconnected);
            socket.off("disconnect", onSocketDisconnect);
            socket.off("connect", onSocketConnect);
            setWaitingForPeer(false);
            dropBatch("The session was closed.", "cancelled");
            teardown();
            actionsRef.current = null;
        };
    }, [socket, roomId, setBatch]);

    const sendFiles = useCallback((files) => {
        const channel = sessionRef.current?.channel;
        if (!channel || channel.readyState !== "open") {
            console.error("Data channel not ready. State:", channel?.readyState);
            return;
        }
        if (batchRef.current || files.length === 0) return;

        console.log(`Sending ${files.length} files`);
        setCurrentFileIndex(0);
        setFilesProgress(files.map(() => 0));

        setBatch(createBatchSender(files, {
            onProgress: (fileIndex, progress) => {
                setCurrentFileIndex(fileIndex);
                setFilesProgress((prev) => {
                    const next = [...prev];
                    next[fileIndex] = progress;
                    return next;
                });
            },
            onFileComplete: (fileIndex) => console.log(`File ${fileIndex + 1} complete`),
        }));
        actionsRef.current?.runBatch();
    }, [setBatch]);

    const cancelTransfer = useCallback(() => {
        const batch = batchRef.current;
        if (!batch) return;
        if (transferRef.current) {
            // Running: run() tells the receiver and rejects; runBatch sets the state.
            transferRef.current.abort(new TransferError("You cancelled the transfer.", "cancelled"));
            return;
        }
        // Suspended (reconnecting): stop retrying; tell the receiver if we reconnect later.
        setBatch(null);
        cancelledBatchRef.current = batch;
        actionsRef.current?.clearRetry();
        setError("You cancelled the transfer.");
        setState("cancelled");
    }, [setBatch]);

    /** Clear the last batch's result so another batch can be sent on the same connection. */
    const resetTransfer = useCallback(() => {
        if (transferRef.current) return; // use cancelTransfer while sending
        if (batchRef.current) {
            // Discard an interrupted batch the user no longer wants to resume.
            cancelledBatchRef.current = batchRef.current;
            setBatch(null);
            actionsRef.current?.clearRetry();
        }
        setFilesProgress([]);
        setCurrentFileIndex(-1);
        setError(null);
        const open = sessionRef.current?.channel.readyState === "open";
        if (open) {
            setState("ready");
        } else if (actionsRef.current?.hasReceiver()) {
            actionsRef.current.connect(); // also delivers the pending cancel
        } else {
            setState("idle");
        }
    }, [setBatch]);

    /** Re-run WebRTC negotiation after the connection was lost; resumes an interrupted batch. */
    const reconnect = useCallback(() => {
        if (!batchRef.current) {
            setFilesProgress([]);
            setCurrentFileIndex(-1);
        }
        actionsRef.current?.connect();
    }, []);

    return {
        sendFiles,
        cancelTransfer,
        resetTransfer,
        reconnect,
        filesProgress,
        currentFileIndex,
        state,
        error,
        reconnectAttempt,
        waitingForPeer,
        maxReconnectAttempts: RECONNECT_DELAYS_MS.length,
        // An interrupted batch is waiting; reconnecting will resume it.
        canResume: hasBatch && state !== "sending",
        dataChannelReady: channelOpen,
    };
}
