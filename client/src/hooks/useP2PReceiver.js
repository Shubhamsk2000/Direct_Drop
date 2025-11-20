import { useEffect, useState, useRef } from "react";
import { createPeerConnection } from "../webrtc/createPeerConnection.js";
import createMultiFileReceiver from "../webrtc/fileReceiver.js";

export function useP2PReceiver(socket, roomId) {
    const [pc, setPc] = useState(null);
    const [status, setStatus] = useState("idle");
    
    // Multi-file state
    const [filesMetadata, setFilesMetadata] = useState([]);
    const [filesProgress, setFilesProgress] = useState([]);
    const [completedFiles, setCompletedFiles] = useState([]);
    
    const pendingCandidatesRef = useRef([]);

    useEffect(() => {
        if (!socket || !roomId) {
            setPc(null);
            setStatus("idle");
            setFilesMetadata([]);
            setFilesProgress([]);
            setCompletedFiles([]);
            return;
        }

        console.log("Receiver: Setting up peer connection");

        const peer = createPeerConnection({
            onIceCandidate: (candidate) => {
                socket.emit("webrtc-ice-candidate", { candidate });
            }
        });

        setPc(peer);

        const handleData = createMultiFileReceiver(
            // onBatchMetadata - called once with all file info
            (filesInfo) => {
                console.log('📦 UI: Received metadata for', filesInfo.length, 'files');
                setFilesMetadata(filesInfo);
                setFilesProgress(filesInfo.map(() => 0));
                setCompletedFiles([]);
                setStatus("receiving");
            },
            // onProgress - update specific file's progress
            (fileIndex, progress) => {
                setFilesProgress(prev => {
                    const newProgress = [...prev];
                    newProgress[fileIndex] = progress;
                    return newProgress;
                });
            },
            // onFileComplete - file finished, auto-download
            (fileIndex, blob, filename) => {
                console.log(`✅ UI: File ${fileIndex} complete: ${filename}`);
                
                // Auto-download
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);  // ✅ FIXED: Append to body first
                a.click();
                document.body.removeChild(a);  // ✅ FIXED: Clean up
                
                // Revoke after a delay to ensure download starts
                setTimeout(() => URL.revokeObjectURL(url), 100);

                setCompletedFiles(prev => [...prev, fileIndex]);
            },
            // onAllComplete - all files done
            () => {
                console.log('🎉 UI: All files transfer complete!');
                setStatus("complete");
            }
        );

        peer.ondatachannel = (e) => {
            console.log("Receiver: Data channel received");
            const channel = e.channel;
            
            channel.onmessage = (event) => handleData(event.data);
            
            channel.onopen = () => {
                console.log("Receiver: Data channel OPEN");
                setStatus("connected");
            };
            
            channel.onerror = (error) => {
                console.error("Receiver: Data channel ERROR", error);
                setStatus("error");
            };
            
            channel.onclose = () => {
                console.log("Receiver: Data channel CLOSED");
            };
        };

        socket.on("webrtc-offer", async ({ offer }) => {
            try {
                console.log("Receiver: Received offer");
                await peer.setRemoteDescription(offer);
                
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                
                socket.emit("webrtc-answer", { answer });
                console.log("Receiver: Answer sent");
                
                // Process queued ICE candidates
                console.log(`Receiver: Processing ${pendingCandidatesRef.current.length} queued ICE candidates`);
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
                setStatus("error");
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

    return { 
        status,
        filesMetadata,
        filesProgress,
        completedFiles
    };
}