import { useEffect, useState, useCallback, useRef } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import { sendFileOverDataChannel } from "../webrtc/fileSender.js";

export function useP2PSender(socket, roomId) {
    const [pc, setPc] = useState(null);
    const [dataChannel, setDataChannel] = useState(null);
    const [progress, setProgress] = useState(0);
    const [state, setState] = useState("idle");

    const pendingCandidatesRef = useRef([]);

    useEffect(() => {
        if (!socket || !roomId) {
            // Clean up when roomId is cleared (reset)
            setPc(null);
            setDataChannel(null);
            setState("idle");
            setProgress(0);
            return;
        }

        console.log("Sender: Setting up peer connection for room:", roomId);

        // Create Peer Connection
        const peer = createPeerConnection({
            onIceCandidate: (candidate) => {
                socket.emit("webrtc-ice-candidate", { candidate });
            }
        });

        setPc(peer);

        const channel = peer.createDataChannel("file-channel");

        channel.onopen = () => {
            console.log("Sender: DataChannel OPEN");
            channel.bufferedAmountLowThreshold = 64 * 1024;
            setDataChannel(channel);
        };

        channel.onclose = () => {
            console.log("Sender: DataChannel CLOSED");
            setDataChannel(null);
        };

        channel.onerror = (error) => {
            console.error("Sender: DataChannel ERROR", error);
        };

        // Listen for answer from receiver
        socket.on("webrtc-answer", async ({ answer }) => {
            try {
                console.log("Sender: Received answer");
                await peer.setRemoteDescription(answer);

                // Process queued ICE candidates
                console.log(`Sender: Processing ${pendingCandidatesRef.current.length} pending ICE candidates`);
                for (const candidate of pendingCandidatesRef.current) {
                    try {
                        await peer.addIceCandidate(candidate);
                    } catch (error) {
                        console.error("Error adding queued ICE candidate:", error);
                    }
                }
                pendingCandidatesRef.current = [];
            } catch (error) {
                console.error("Error setting remote description:", error);
            }
        });

        socket.on("webrtc-ice-candidate", async ({ candidate }) => {
            if (candidate) {
                if (peer.remoteDescription) {
                    try {
                        await peer.addIceCandidate(candidate);
                        console.log("Sender: ICE candidate added");
                    } catch (error) {
                        console.error("Error adding ICE candidate:", error);
                    }
                } else {
                    console.log("Sender: Queueing ICE candidate (no remote description yet)");
                    pendingCandidatesRef.current.push(candidate);
                }
            }
        });

        return () => {
            channel.close();
            peer.close();
            socket.off("webrtc-answer");
            socket.off("webrtc-ice-candidate");
            pendingCandidatesRef.current = [];
        };
    }, [socket, roomId]);

    // Create and send offer when peer connects
    useEffect(() => {
        if (!pc || !socket) return;

        const createOffer = async () => {
            try {
                console.log("Sender: Creating offer");
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("webrtc-offer", { offer });
                console.log("Sender: Offer sent");
            } catch (error) {
                console.error("Error creating offer:", error);
            }
        };

        socket.on("peer-connected", createOffer);

        return () => {
            socket.off("peer-connected");
        };
    }, [pc, socket]);

    // SEND FILE
    const sendFile = useCallback(async (file) => {
        if (!dataChannel || dataChannel.readyState !== "open") {
            console.log("Data channel not ready. State:", dataChannel?.readyState);
            return;
        }

        setState("sending");
        setProgress(0);

        await sendFileOverDataChannel(dataChannel, file, setProgress);

        setState("complete");
    }, [dataChannel]);

    const resetTransfer = useCallback(() => {
        setState("idle");
        setProgress(0);
    }, []);
    
    return {
        sendFile,
        progress,
        state,
        dataChannelReady: !!dataChannel && dataChannel.readyState === "open",
        resetTransfer
    };
}