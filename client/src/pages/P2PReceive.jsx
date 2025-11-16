import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { useSocket } from '../provider/SocketContext';
import ConnectionStatus from '../components/ConnectionStatus';
import { motion } from 'framer-motion';
import { CheckCircle, Download, Loader, XCircle, FileDown } from 'lucide-react';

const P2PReceive = () => {
  const { socket, peerConnected, connected, roomId, setRoomId } = useSocket();

  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);

  const [fileMetadata, setFileMetadata] = useState(null);
  const [transferStatus, setTransferStatus] = useState('idle');
  const [transferProgress, setTransferProgress] = useState(null);

  const chunksRef = useRef([]);
  const receivedSizeRef = useRef(0);
  const fileMetadataRef = useRef(null);

  const peerConnection = useMemo(() => new RTCPeerConnection(), []);

  // -------------------------
  // Handle code input
  // -------------------------
  const handleCodeChange = (ev) => {
    const cleaned = ev.target.value.replace(/[^0-9]/g, '').substring(0, 4);
    setCode(cleaned);
  };

  // -------------------------
  // Join a room
  // -------------------------
  const handleJoinRoom = () => {
    if (!connected || code.length !== 4) return;
    setJoining(true);
    socket.emit('join-room', code);
    setRoomId(code);
    setJoining(false);
  };

  // -------------------------
  // Create DataChannel + Offer (Receiver)
  // -------------------------
  const handleCreateOffer = async () => {
    try {
      const channel = peerConnection.createDataChannel("file-channel");
      setTransferStatus("idle");

      // Store channel to state if needed later
      channel.onopen = () => console.log("Receiver: DataChannel OPEN");

      channel.onmessage = (event) => {
        // Receiving file
        setTransferStatus("receiving");

        // TEXT MESSAGE → Metadata
        if (typeof event.data === "string") {
          try {
            const meta = JSON.parse(event.data);
            if (meta.type === "metadata") {
              setFileMetadata(meta);
              fileMetadataRef.current = meta;
              return;
            }
          } catch {
            return;
          }
        }

        // BINARY DATA → chunks
        if (event.data instanceof ArrayBuffer) {
          const chunk = event.data;
          chunksRef.current.push(chunk);
          receivedSizeRef.current += chunk.byteLength;

          // Progress bar
          const prog = (receivedSizeRef.current / fileMetadataRef.current.size) * 100;
          setTransferProgress(prog.toFixed(2));

          // Completed
          if (receivedSizeRef.current >= fileMetadataRef.current.size) {
            const blob = new Blob(chunksRef.current, { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.href = url;
            a.download = fileMetadataRef.current.name;
            a.click();

            URL.revokeObjectURL(url);

            // Reset
            chunksRef.current = [];
            receivedSizeRef.current = 0;
            setFileMetadata(null);
            fileMetadataRef.current = null;
            setTransferStatus("complete");
          }
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit("webrtc-offer", { offer });

    } catch (err) {
      console.error(err);
    }
  };

  // -------------------------
  // Auto-create offer after peer connects
  // -------------------------
  useEffect(() => {
    if (socket && peerConnected) {
      handleCreateOffer();
    }
  }, [socket, peerConnected]);

  // -------------------------
  // Handle WebRTC Answer
  // -------------------------
  const handleOfferAnswer = useCallback(async ({ answer }) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }, []);

  // -------------------------
  // ICE Candidates, Listeners
  // -------------------------
  useEffect(() => {
    if (!socket) return;

    socket.on("peer-connected", () => console.log("Receiver: Peer connected"));

    peerConnection.onicecandidate = (e) => {
      if (e.candidate) socket.emit("webrtc-ice-candidate", { candidate: e.candidate });
    };

    const handleICE = ({ candidate }) => {
      if (candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    };

    socket.on("webrtc-answer", handleOfferAnswer);
    socket.on("webrtc-ice-candidate", handleICE);

    return () => {
      socket.off("webrtc-answer", handleOfferAnswer);
      socket.off("webrtc-ice-candidate", handleICE);
    };
  }, [socket]);

  // -------------------------
  // UI
  // -------------------------
  return (
    <div className="flex flex-col items-center max-w-xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Receive Files</h1>
        <p className="text-gray-600">Enter the 4-digit code to connect to the sender.</p>
      </motion.div>

      <div className="card w-full p-4">
        <ConnectionStatus connected={connected} roomId={roomId} peerConnected={peerConnected} />

        {/* Enter Code Screen */}
        {!roomId && (
          <div className="mt-8 space-y-6">
            <div className='space-y-2'>
              <label className="block text-sm font-medium">Enter the code</label>
              <input
                type="text"
                maxLength={4}
                className="input text-center text-2xl tracking-widest font-bold w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2   focus:ring-blue-400 focus:border-transparent placeholder-gray-400"
                value={code}
                onChange={handleCodeChange}
                placeholder="Enter code"
              />
            </div>

            <button
              className="bg-(--accent-500) w-full py-2 rounded-lg text-white text-lg cursor-pointer disabled:cursor-not-allowed disabled:bg-blue-300"
              disabled={code.length !== 4}
              onClick={handleJoinRoom}
            >
              Connect
            </button>
          </div>
        )}

        {/* Connected, waiting or receiving */}
        {roomId && (
          <div className="mt-8 space-y-6 text-center">

            {!peerConnected && (
              <div className="flex justify-center">
                <Loader className="h-6 w-6 animate-spin text-gray-500" />
              </div>
            )}

            {peerConnected && transferStatus === "idle" && (
              <div className="space-y-3">
                <Download className="h-10 w-10 text-secondary-500 mx-auto" />
                <p className="font-medium">Waiting for sender to choose a file...</p>
              </div>
            )}

            {peerConnected && transferStatus === "receiving" && fileMetadata && (
              <div className="space-y-5">
                <div className="border rounded-lg p-4 flex items-center gap-3">
                  <FileDown className="h-6 w-6 text-secondary-500" />
                  <div className="text-left">
                    <p className="font-medium">{fileMetadata.name}</p>
                    <p className="text-sm text-gray-500">{(fileMetadata.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                </div>

                <div>
                  <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-secondary-500 h-2 rounded-full transition-all"
                      style={{ width: `${transferProgress}%` }}
                    ></div>
                  </div>

                  <p className="text-sm text-gray-500 mt-2">{transferProgress}%</p>
                </div>
              </div>
            )}

            {peerConnected && transferStatus === "complete" && (
              <div className="text-success-500 space-y-3">
                <CheckCircle className="h-10 w-10 mx-auto" />
                <p className="font-medium text-lg">File received successfully!</p>
                <p className="text-sm text-gray-500">The file has been downloaded.</p>
              </div>
            )}

            {transferStatus === "error" && (
              <div className="text-error-500 space-y-3">
                <XCircle className="h-10 w-10 mx-auto" />
                <p className="font-medium text-lg">Failed to receive file</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default P2PReceive;
