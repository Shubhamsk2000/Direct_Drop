import { useState } from "react";
import { useSocket } from "../provider/SocketContext.jsx";
import { useP2PReceiver } from "../hooks/useP2PReceiver.js";
import { motion } from "framer-motion";
import ConnectionStatus from "../components/ConnectionStatus.jsx";
import { CheckCircle, Download, Loader, XCircle, FileDown } from "lucide-react";

const P2PReceive = () => {
  const { socket, connected, roomId, setRoomId, peerConnected, connectionError } = useSocket();

  const [code, setCode] = useState("");

  const { status: transferStatus, progress: transferProgress } =
    useP2PReceiver(socket, roomId, peerConnected);

  // Handle 4-digit code input
  const handleCodeChange = (e) => {
    const clean = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
    setCode(clean);
  };

  // Join the room
  const handleJoinRoom = () => {
    if (!connected || code.length !== 4) return;

    socket.emit("join-room", code);
    setRoomId(code);
    
  };

  return (
    <div className="flex flex-col items-center max-w-xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="text-center mb-8"
      >
        <h1 className="text-3xl font-bold mb-2">Receive Files</h1>
        <p className="text-gray-600">Enter the 4-digit code to connect to the sender.</p>
      </motion.div>

      <div className="card w-full p-4">
        <ConnectionStatus
          connected={connected}
          roomId={roomId}
          peerConnected={peerConnected}
          connectionError={connectionError}
        />

        {/* Enter Code UI */}
        {!roomId && (
          <div className="mt-8 space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium">Enter the code</label>
              <input
                type="text"
                maxLength={4}
                className="input text-center text-2xl tracking-widest font-bold w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent placeholder-gray-400"
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

        {/* Connected States */}
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

            {peerConnected && transferStatus === "receiving" && (
              <div className="space-y-5">
                <div className="border rounded-lg p-4 flex items-center gap-3 justify-center">
                  <FileDown className="h-6 w-6 text-secondary-500" />
                  <div className="text-left">
                    <p className="font-medium">Receiving file...</p>
                    <p className="text-sm text-gray-500">{transferProgress.toFixed(2)}%</p>
                  </div>
                </div>

                <div>
                  <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-secondary-500 h-2 rounded-full transition-all"
                      style={{ width: `${transferProgress}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            )}

            {peerConnected && transferStatus === "complete" && (
              <div className="text-success-500 space-y-3">
                <CheckCircle className="h-10 w-10 mx-auto" />
                <p className="font-medium text-lg">File received successfully!</p>
                <p className="text-sm text-gray-500">Your file has been downloaded.</p>
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
