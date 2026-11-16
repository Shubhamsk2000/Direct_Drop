import { useState, useRef, useEffect } from "react";
import { useSocket } from "../provider/SocketContext.jsx";
import { useP2PSender } from "../hooks/useP2PSender.js";
import { motion, AnimatePresence } from "framer-motion";
import ConnectionStatus from "../components/ConnectionStatus.jsx";
import { CheckCircle, FileUp, RefreshCw, X, Send, Loader, Ban } from "lucide-react";

const P2PSend = () => {
  const { socket, roomId, setRoomId, connected, peerConnected, connectionError } = useSocket();
  const [generatingCode, setGeneratingCode] = useState(false);
  const [files, setFiles] = useState([]);

  const fileInputRef = useRef(null);

  const {
    sendFiles,
    cancelTransfer,
    reconnect,
    filesProgress,
    currentFileIndex,
    state: transferState,
    error: transferError,
    dataChannelReady,
    resetTransfer,
    reconnectAttempt,
    waitingForPeer,
    maxReconnectAttempts,
    canResume
  } = useP2PSender(socket, roomId);

  // An interrupted batch keeps its progress on screen until it resumes or is discarded.
  const showProgress = transferState === "sending" || transferState === "reconnecting" || canResume;
  // Files can be edited whenever no batch is in flight or waiting to resume.
  const canEditFiles = !["sending", "complete", "reconnecting"].includes(transferState) && !canResume;

  const handleReset = () => {
    setFiles([]);
    resetTransfer();
  };

  // Keep the selected files so the same batch can be retried.
  const handleRetry = () => {
    if (dataChannelReady) resetTransfer();
    else reconnect();
  };

  const handleCreateRoom = () => {
    if (!connected || roomId) return;
    setGeneratingCode(true);
    socket.emit("create-room");
  };

  useEffect(() => {
    if (!socket) return;

    const handleGenerated = (code) => {
      setRoomId(code);
      setGeneratingCode(false);
    };

    socket.on("generated-code", handleGenerated);
    return () => socket.off("generated-code", handleGenerated);
  }, [socket, setRoomId]);

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    setFiles(selectedFiles);
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const triggerFileInput = () => fileInputRef.current?.click();

  const handleSend = () => {
    if (files.length === 0) {
      console.warn("No files selected");
      return;
    }

    if (!dataChannelReady) {
      console.warn("Data channel not ready");
      alert("Connection not ready. Please wait...");
      return;
    }

    console.log("Starting file transfer");
    sendFiles(files);
  };

  return (
    <div className="flex flex-col items-center max-w-2xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <h1 className="text-3xl font-bold mb-2">Send Files</h1>
        <p className="text-gray-600">
          Generate a code, share it, and send multiple files at once!
        </p>
      </motion.div>

      <div className="card w-full p-6">
        <ConnectionStatus
          connected={connected}
          roomId={roomId}
          peerConnected={peerConnected}
          connectionError={connectionError}
          isSender={true}
        />

        {!roomId ? (
          <div className="mt-8 flex flex-col items-center">
            <button
              className="bg-blue-600 hover:bg-blue-700 px-6 py-3 text-lg rounded-lg text-white disabled:bg-blue-300 cursor-pointer"
              disabled={!connected || generatingCode}
              onClick={handleCreateRoom}
            >
              {generatingCode ? (
                <>
                  <RefreshCw className="w-5 h-5 animate-spin inline mr-2" />
                  Generating...
                </>
              ) : (
                "Generate Code"
              )}
            </button>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            {peerConnected ? (
              <>
                <div className="flex items-center justify-center gap-2 text-green-600">
                  <CheckCircle className="h-6 w-6" />
                  <span className="font-medium">Connected to receiver</span>
                </div>

                {/* File Selection Area */}
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6">
                  <input
                    type="file"
                    ref={fileInputRef}
                    multiple
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {files.length === 0 ? (
                    <div className="text-center space-y-4">
                      <FileUp className="h-12 w-12 text-gray-400 mx-auto" />
                      <div>
                        <p className="text-lg font-medium">Choose files to send</p>
                        <p className="text-sm text-gray-500">Select multiple files at once</p>
                      </div>
                      <button
                        onClick={triggerFileInput}
                        className="bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded-lg"
                      >
                        Select Files
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="font-semibold text-lg">
                          {files.length} file{files.length > 1 ? 's' : ''} selected
                        </h3>
                        {canEditFiles && (
                          <button
                            onClick={triggerFileInput}
                            className="text-sm text-blue-600 hover:underline"
                          >
                            Add more
                          </button>
                        )}
                      </div>

                      <AnimatePresence>
                        {files.map((file, index) => (
                          <motion.div
                            key={index}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            className="border rounded-lg p-4"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-3 flex-1">
                                <FileUp className="h-5 w-5 text-blue-500" />
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium truncate">{file.name}</p>
                                  <p className="text-sm text-gray-500">
                                    {(file.size / 1024 / 1024).toFixed(2)} MB
                                  </p>
                                </div>
                              </div>

                              {canEditFiles && (
                                <button
                                  onClick={() => removeFile(index)}
                                  className="text-red-500 hover:bg-red-50 p-1 rounded"
                                >
                                  <X className="h-5 w-5" />
                                </button>
                              )}

                              {showProgress && (
                                <div className="flex items-center gap-2">
                                  {transferState === "sending" && index === currentFileIndex ? (
                                    <span className="text-blue-600 text-sm font-medium">
                                      Sending...
                                    </span>
                                  ) : filesProgress[index] === 100 ? (
                                    <CheckCircle className="h-5 w-5 text-green-600" />
                                  ) : (
                                    <span className="text-gray-400 text-sm">Waiting</span>
                                  )}
                                </div>
                              )}

                              {transferState === "complete" && (
                                <CheckCircle className="h-5 w-5 text-green-600" />
                              )}
                            </div>

                            {/* Progress bar */}
                            {showProgress && (
                              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                                <div
                                  className={`h-2 rounded-full transition-all ${index === currentFileIndex ? 'bg-blue-600' : 'bg-green-600'
                                    }`}
                                  style={{ width: `${filesProgress[index] || 0}%` }}
                                />
                              </div>
                            )}
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                </div>

                {/* Connecting */}
                {transferState === "connecting" && (
                  <div className="flex items-center justify-center gap-2 text-gray-600">
                    <Loader className="h-5 w-5 animate-spin" />
                    <span>Establishing a direct connection…</span>
                  </div>
                )}

                {/* Send Button */}
                {files.length > 0 && (transferState === "idle" || transferState === "ready") && (
                  <button
                    onClick={handleSend}
                    disabled={!dataChannelReady}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium flex items-center justify-center gap-2"
                  >
                    <Send className="h-5 w-5" />
                    Send {files.length} file{files.length > 1 ? 's' : ''}
                  </button>
                )}

                {/* Reconnecting: batch is suspended and will resume */}
                {transferState === "reconnecting" && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center space-y-1">
                    <p className="font-semibold text-blue-800 flex items-center justify-center gap-2">
                      <Loader className="h-5 w-5 animate-spin" />
                      {waitingForPeer
                        ? "Connection interrupted — waiting…"
                        : `Reconnecting… (attempt ${reconnectAttempt} of ${maxReconnectAttempts})`}
                    </p>
                    {transferError && <p className="text-sm text-blue-700">{transferError}</p>}
                    <p className="text-sm text-gray-600">The transfer will continue where it left off.</p>
                  </div>
                )}

                {/* Cancel Button */}
                {(transferState === "sending" || transferState === "reconnecting") && (
                  <button
                    onClick={cancelTransfer}
                    className="w-full border border-red-300 text-red-700 hover:bg-red-50 py-3 rounded-lg font-medium flex items-center justify-center gap-2"
                  >
                    <Ban className="h-5 w-5" />
                    Cancel transfer
                  </button>
                )}

                {/* Cancelled State */}
                {transferState === "cancelled" && (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-center space-y-2">
                    <p className="font-semibold text-amber-800">Transfer cancelled</p>
                    {transferError && <p className="text-sm text-amber-700">{transferError}</p>}
                    <div className="flex justify-center gap-4">
                      <button onClick={handleRetry} className="text-blue-600 hover:underline">
                        Send again
                      </button>
                      <button onClick={handleReset} className="text-gray-600 hover:underline">
                        Choose other files
                      </button>
                    </div>
                  </div>
                )}

                {/* Error State */}
                {transferState === "error" && (
                  <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-center space-y-2">
                    <p className="font-semibold text-red-800">
                      {dataChannelReady ? "Transfer failed" : "Connection lost"}
                    </p>
                    {transferError && <p className="text-sm text-red-700">{transferError}</p>}
                    <div className="flex justify-center gap-4">
                      <button onClick={handleRetry} className="text-blue-600 hover:underline">
                        {dataChannelReady ? "Try again" : canResume ? "Reconnect & resume" : "Reconnect"}
                      </button>
                      {files.length > 0 && (
                        <button onClick={handleReset} className="text-gray-600 hover:underline">
                          {canResume ? "Discard transfer" : "Clear files"}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Complete State */}
                {transferState === "complete" && (
                  <div className="text-center space-y-4">
                    <div className="text-green-600 flex items-center justify-center gap-2">
                      <CheckCircle className="h-8 w-8" />
                      <span className="text-lg font-semibold">
                        All files sent successfully!
                      </span>
                    </div>
                    <button
                      onClick={handleReset}
                      className="text-blue-600 hover:underline"
                    >
                      Send more files
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center space-y-3">
                <Loader className="h-12 w-12 text-blue-400 mx-auto animate-spin" />
                <p className="font-medium text-lg">Waiting for receiver to join...</p>
                {transferState === "error" && transferError && (
                  <p className="text-sm text-red-600">Last transfer failed: {transferError}</p>
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