import { useState, useRef, useEffect } from "react";
import { useSocket } from "../provider/SocketContext.jsx";
import { useP2PSender } from "../hooks/useP2PSender.js";
import { motion } from "framer-motion";
import ConnectionStatus from "../components/ConnectionStatus.jsx";
import { CheckCircle, FileUp, RefreshCw } from "lucide-react";

const P2PSend = () => {
  const { socket, roomId, setRoomId, connected, peerConnected, connectionError } = useSocket();

  const [generatingCode, setGeneratingCode] = useState(false);
  const [file, setFile] = useState(null);

  const fileInputRef = useRef(null);

  const {
    sendFile,
    progress: transferProgress,
    state: transferState,
    dataChannelReady,
    resetTransfer
  } = useP2PSender(socket, roomId);

  // Used to send more file
  const handleReset = () => {
    setFile(null);
    resetTransfer();
  }

  // Create room
  const handleCreateRoom = () => {
    if (!connected || roomId) return;
    setGeneratingCode(true);
    socket.emit("create-room");
    console.log("Creating Room id")
  };

  // Listen for generated room code
  useEffect(() => {
    if (!socket) return;

    const handleGenerated = (code) => {
      setRoomId(code);
      setGeneratingCode(false);
      console.log("New RoomId:", code);
    };

    socket.on("generated-code", handleGenerated);

    return () => socket.off("generated-code", handleGenerated);
  }, [socket]);

  // Handle file input
  const handleFileChange = (e) => {
    setFile(e.target.files?.[0] || null);
  };

  // Trigger file input browser dialog
  const triggerFileInput = () => fileInputRef.current?.click();

  // Send file when ready
  const handleSend = () => {
    if (file && dataChannelReady) {
      sendFile(file);
    }
  };

  return (
    <div className="flex flex-col items-center max-w-xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="text-center mb-8"
      >
        <h1 className="text-3xl font-bold mb-2">Send Files</h1>
        <p className="text-gray-600">
          Generate a code, share it with the receiver, and send your files once connected.
        </p>
      </motion.div>

      <div className="card w-full p-4">
        <ConnectionStatus
          connected={connected}
          roomId={roomId}
          peerConnected={peerConnected}
          connectionError={connectionError}
        />

        {!roomId ? (
          <div className="mt-8 flex flex-col items-center">
            <button
              className="bg-(--accent-500) px-6 py-2 text-lg rounded-lg text-white cursor-pointer"
              disabled={!connected || generatingCode}
              onClick={handleCreateRoom}
            >
              {generatingCode ? (
                <>
                  <RefreshCw className="w-5 h-5 animate-spin inline-block mr-2" />
                  Generating code...
                </>
              ) : (
                "Generate Code"
              )}
            </button>
          </div>
        ) : (
          <div className="mt-8">
            {peerConnected && (
              <div className="space-y-6">

                <div className="flex items-center justify-center gap-2 text-success-500">
                  <CheckCircle className="h-6 w-6" />
                  <span className="font-medium">Connected to receiver</span>
                </div>

                <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center">
                  {file ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-center gap-2">
                        <FileUp className="h-6 w-6 text-primary-500" />
                        <span className="font-medium text-lg">{file.name}</span>
                      </div>
                      <p className="text-gray-500 text-sm">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-lg font-medium">Click below to choose a file</p>
                      <p className="text-gray-500">Select the file you want to send</p>
                    </div>
                  )}

                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {!file && (
                    <button onClick={triggerFileInput} className="mt-4 btn-outline cursor-pointer ">
                      Select File
                    </button>
                  )}
                </div>

                {file && transferState === "idle" && (
                  <div className="flex justify-center">
                    <button
                      onClick={handleSend}
                      className="bg-(--accent-500) px-4 py-2 rounded-lg text-white cursor-pointer"
                    >
                      Send File
                    </button>
                  </div>
                )}

                {file && transferState === "sending" && (
                  <div className="w-full bg-gray-200 h-2 rounded-xl overflow-hidden">
                    <div
                      className="h-2 bg-green-600 rounded-2xl transition-all"
                      style={{ width: `${transferProgress}%` }}
                    />
                  </div>
                )}

                {
                  file && transferState === "complete" && (
                    <div className="flex flex-col items-center gap-2">
                      <div className="text-green-600 font-medium text-center flex items-center gap-2">
                        <CheckCircle className="w-5 h-5" />
                        File transferred successfully!
                      </div>

                      <button
                        onClick={handleReset}
                        className="text-sm text-gray-500 hover:text-gray-900 underline cursor-pointer"
                      >
                        Send another file
                      </button>
                    </div>
                  )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default P2PSend;