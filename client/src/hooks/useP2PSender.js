import { useEffect, useState, useCallback, useRef } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import sendFilesOverDataChannel from "../webrtc/fileSender.js";

export function useP2PSender(socket, roomId) {
    const [pc, setPc] = useState(null);
    const [dataChannel, setDataChannel] = useState(null);
    const [state, setState] = useState("idle");
    
    // Multi-file state
    const [filesProgress, setFilesProgress] = useState([]);
    const [currentFileIndex, setCurrentFileIndex] = useState(-1);
    
    const pendingCandidatesRef = useRef([]);

    useEffect(() => {
        if (!socket || !roomId) {
            setPc(null);
            setDataChannel(null);
            setState("idle");
            setFilesProgress([]);
            setCurrentFileIndex(-1);
            return;
        }

        console.log("Sender: Setting up peer connection");

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
            setState("ready");  // ✅ ADDED: Set state to ready
        };

        channel.onclose = () => {
            console.log("Sender: DataChannel CLOSED");
            setDataChannel(null);
            setState("idle");
        };

        channel.onerror = (error) => {
            console.error("Sender: DataChannel ERROR", error);
            setState("error");  // ✅ ADDED: Set error state
        };

        socket.on("webrtc-answer", async ({ answer }) => {
            try {
                console.log("Sender: Received answer, setting remote description");
                await peer.setRemoteDescription(answer);
                
                console.log(`Sender: Processing ${pendingCandidatesRef.current.length} queued ICE candidates`);
                for (const candidate of pendingCandidatesRef.current) {
                    try {
                        await peer.addIceCandidate(candidate);
                    } catch (error) {
                        console.error("Error adding queued ICE candidate:", error);
                    }
                }
                pendingCandidatesRef.current = [];
            } catch (error) {
                console.error("Sender: Error setting remote description:", error);
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
                console.error("Sender: Error creating offer:", error);
            }
        };

        socket.on("peer-connected", createOffer);
        return () => socket.off("peer-connected", createOffer);
    }, [pc, socket]);

    // Send multiple files
    const sendFiles = useCallback(async (files) => {
        if (!dataChannel || dataChannel.readyState !== "open") {
            console.error("Data channel not ready. State:", dataChannel?.readyState);
            return;
        }

        console.log(`Sending ${files.length} files`);
        setState("sending");
        setCurrentFileIndex(0);
        
        const initialProgress = files.map(() => 0);
        setFilesProgress(initialProgress);

        try {
            await sendFilesOverDataChannel(
                dataChannel,
                files,
                (fileIndex, progress) => {
                    setCurrentFileIndex(fileIndex);
                    setFilesProgress(prev => {
                        const newProgress = [...prev];
                        newProgress[fileIndex] = progress;
                        return newProgress;
                    });
                },
                (fileIndex) => {
                    console.log(`File ${fileIndex + 1} complete`);
                }
            );

            console.log("All files sent successfully");
            setState("complete");
            setCurrentFileIndex(-1);
        } catch (error) {
            console.error("Error sending files:", error);
            setState("error");
        }
    }, [dataChannel]);

    const resetTransfer = useCallback(() => {
        setState("idle");
        setFilesProgress([]);
        setCurrentFileIndex(-1);
    }, []);
    
    return {
        sendFiles,
        filesProgress,
        currentFileIndex,
        state,
        dataChannelReady: !!dataChannel && dataChannel.readyState === "open",
        resetTransfer
    };
}