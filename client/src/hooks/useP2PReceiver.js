import { useEffect, useState, useRef } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import { createFileReceiver } from "../webrtc/fileReceiver.js";

export function useP2PReceiver(socket, roomId) {
    const [pc, setPc] = useState(null);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("idle");
    
    const pendingCandidatesRef = useRef([]);

    useEffect(() => {
        if (!socket || !roomId) {
            // Clean up when roomId is cleared (reset)
            setPc(null);
            setStatus("idle");
            setProgress(0);
            return;
        }

        console.log("Receiver: Setting up peer connection for room:", roomId);

        const peer = createPeerConnection({
            onIceCandidate: (candidate) => {
                socket.emit("webrtc-ice-candidate", { candidate });
            }
        });

        setPc(peer);

        const handleData = createFileReceiver(
            (p) => { setProgress(p); setStatus("receiving"); },
            (blob, filename) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                setStatus("complete");
            }
        );

        peer.ondatachannel = (e) => {
            console.log("Receiver: Data channel received");
            e.channel.onmessage = (event) => handleData(event.data);
            e.channel.onopen = () => console.log("Receiver: Data channel open");
            e.channel.onerror = (error) => console.error("Receiver: Data channel error", error);
        };

        // Receiver listens for OFFER and creates ANSWER
        socket.on("webrtc-offer", async ({ offer }) => {
            try {
                console.log("Receiver: Received offer");
                await peer.setRemoteDescription(offer);
                
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                
                socket.emit("webrtc-answer", { answer });
                console.log("Receiver: Answer sent");
                
                // Process queued ICE candidates
                console.log(`Receiver: Processing ${pendingCandidatesRef.current.length} pending ICE candidates`);
                for (const candidate of pendingCandidatesRef.current) {
                    try {
                        await peer.addIceCandidate(candidate);
                    } catch (error) {
                        console.error("Error adding queued ICE candidate:", error);
                    }
                }
                pendingCandidatesRef.current = [];
            } catch (error) {
                console.error("Receiver: Error handling offer:", error);
            }
        });

        socket.on("webrtc-ice-candidate", async ({ candidate }) => {
            if (candidate) {
                if (peer.remoteDescription) {
                    try {
                        await peer.addIceCandidate(candidate);
                        console.log("Receiver: ICE candidate added");
                    } catch (error) {
                        console.error("Error adding ICE candidate:", error);
                    }
                } else {
                    console.log("Receiver: Queueing ICE candidate (no remote description yet)");
                    pendingCandidatesRef.current.push(candidate);
                }
            }
        });

        return () => {
            peer.close();
            socket.off("webrtc-offer");
            socket.off("webrtc-ice-candidate");
            pendingCandidatesRef.current = [];
        };
    }, [socket, roomId]);

    return { status, progress };
}