import { useState } from "react";
import { useSocket } from "../provider/SocketContext.jsx";
import { useP2PReceiver } from "../hooks/useP2PReceiver.js";
import { motion, AnimatePresence } from "framer-motion";
import ConnectionStatus from "../components/ConnectionStatus.jsx";
import { CheckCircle, Download, Loader, FileDown, Inbox } from "lucide-react";

const P2PReceive = () => {
  const { socket, connected, roomId, setRoomId, peerConnected } = useSocket();
  const [code, setCode] = useState("");

  const {
    status,
    filesMetadata,
    filesProgress,
    completedFiles
  } = useP2PReceiver(socket, roomId);

  const handleCodeChange = (e) => {
    const clean = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
    setCode(clean);
  };

  const handleJoinRoom = () => {
    if (!connected || code.length !== 4) return;
    socket.emit("join-room", code);
    setRoomId(code);
  };

  return (
    <div className="flex flex-col items-center max-w-2xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <h1 className="text-3xl font-bold mb-2">Receive Files</h1>
        <p className="text-gray-600">
          Enter the 4-digit code to connect and receive files.
        </p>
      </motion.div>

      <div className="card w-full p-6">
        <ConnectionStatus
          connected={connected}
          roomId={roomId}
          peerConnected={peerConnected}
        />

        {!roomId ? (
          <div className="mt-8 space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium">Enter Code</label>
              <input
                type="text"
                maxLength={4}
                className="w-full text-center text-2xl tracking-widest font-bold px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
                value={code}
                onChange={handleCodeChange}
                placeholder="0000"
              />
            </div>

            <button
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white py-3 rounded-lg font-medium"
              disabled={code.length !== 4}
              onClick={handleJoinRoom}
            >
              Connect
            </button>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            {/* Waiting for peer to connect */}
            {!peerConnected && (
              <div className="text-center space-y-3">
                <Loader className="h-12 w-12 animate-spin text-blue-400 mx-auto" />
                <p className="font-medium text-lg">Connecting to sender...</p>
                <p className="text-sm text-gray-500">Room: {roomId}</p>
              </div>
            )}

            {/* Peer connected but no files yet */}
            {peerConnected && status === "idle" && filesMetadata.length === 0 && (
              <div className="text-center space-y-4">
                <Inbox className="h-16 w-16 text-gray-400 mx-auto" />
                <div>
                  <p className="font-medium text-lg">Waiting for sender...</p>
                  <p className="text-sm text-gray-500">Ready to receive files</p>
                </div>
              </div>
            )}

            {/* Peer connected and status is "connected" but no metadata */}
            {peerConnected && (status === "connected" || status === "receiving") && filesMetadata.length === 0 && (
              <div className="text-center space-y-4">
                <Loader className="h-12 w-12 animate-spin text-blue-600 mx-auto" />
                <div>
                  <p className="font-medium text-lg">Preparing to receive...</p>
                  <p className="text-sm text-gray-500">Sender is preparing files</p>
                </div>
              </div>
            )}

            {/* Show all files when metadata arrives */}
            {filesMetadata.length > 0 && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-lg">
                    Incoming Files ({filesMetadata.length})
                  </h3>
                  {status === "complete" && (
                    <span className="text-green-600 flex items-center gap-1">
                      <CheckCircle className="h-5 w-5" />
                      All received
                    </span>
                  )}
                </div>

                <AnimatePresence>
                  {filesMetadata.map((file, index) => (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className={`border rounded-lg p-4 ${
                        completedFiles.includes(index) 
                          ? 'bg-green-50 border-green-300' 
                          : 'bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3 flex-1">
                          <FileDown className="h-6 w-6 text-blue-500" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{file.name}</p>
                            <p className="text-sm text-gray-500">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                          </div>
                        </div>

                        <div>
                          {completedFiles.includes(index) ? (
                            <CheckCircle className="h-6 w-6 text-green-600" />
                          ) : filesProgress[index] > 0 ? (
                            <span className="text-blue-600 font-medium">
                              {filesProgress[index].toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-gray-400 text-sm">Waiting...</span>
                          )}
                        </div>
                      </div>

                      {/* Progress Bar */}
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all ${
                            completedFiles.includes(index) 
                              ? 'bg-green-600' 
                              : 'bg-blue-600'
                          }`}
                          style={{ width: `${filesProgress[index] || 0}%` }}
                        />
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}

            {status === "complete" && (
              <div className="bg-green-50 border border-green-300 rounded-lg p-4 text-center">
                <CheckCircle className="h-10 w-10 text-green-600 mx-auto mb-2" />
                <p className="font-semibold text-lg text-green-900">
                  All files received!
                </p>
                <p className="text-sm text-green-700">
                  {completedFiles.length} file{completedFiles.length > 1 ? 's' : ''} downloaded
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default P2PReceive;
