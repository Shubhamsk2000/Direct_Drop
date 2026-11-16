import { useState } from "react";
import { useSocket } from "../provider/SocketContext.jsx";
import { useP2PReceiver } from "../hooks/useP2PReceiver.js";
import { motion, AnimatePresence } from "framer-motion";
import ConnectionStatus from "../components/ConnectionStatus.jsx";
import { CheckCircle, Loader, FileDown, Inbox, Ban, AlertCircle, FolderOpen, HardDrive, AlertTriangle } from "lucide-react";

const P2PReceive = () => {
  const { socket, connected, roomId, setRoomId, peerConnected, connectionError, setConnectionError } = useSocket();
  const [code, setCode] = useState("");

  const {
    status,
    filesMetadata,
    filesProgress,
    completedFiles,
    error: transferError,
    cancelTransfer,
    storageInfo,
    savedNames,
    saveDirectoryName,
    canChooseDirectory,
    chooseSaveDirectory,
    clearSaveDirectory
  } = useP2PReceiver(socket, roomId);

  // The folder applies to the next batch, so don't offer changes mid-transfer.
  const showSaveLocation = canChooseDirectory && peerConnected && status !== "receiving" && status !== "reconnecting";

  const handleCodeChange = (e) => {
    const clean = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
    setCode(clean);
  };

  const handleJoinRoom = () => {
    if (!connected || code.length !== 4) return;
    setConnectionError(null);
    socket.emit("join-room", code, (response) => {
      if (!response.success) {
        setConnectionError(response.message);
        setCode("");
        return;
      }
      setRoomId(code);
    });
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
          connectionError={connectionError}
          isSender={false}
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
                placeholder="_ _ _ _"
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

            {/* Negotiating the WebRTC connection */}
            {peerConnected && (status === "idle" || status === "connecting") && (
              <div className="text-center space-y-3">
                <Loader className="h-12 w-12 animate-spin text-blue-400 mx-auto" />
                <p className="font-medium text-lg">Establishing a direct connection…</p>
              </div>
            )}

            {/* Connected, no batch yet */}
            {peerConnected && status === "connected" && (
              <div className="text-center space-y-4">
                <Inbox className="h-16 w-16 text-gray-400 mx-auto" />
                <div>
                  <p className="font-medium text-lg">Waiting for sender...</p>
                  <p className="text-sm text-gray-500">Ready to receive files</p>
                </div>
              </div>
            )}

            {/* Connection dropped mid-batch: partial file kept, waiting for resume */}
            {status === "reconnecting" && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center space-y-1">
                <p className="font-semibold text-blue-800 flex items-center justify-center gap-2">
                  <Loader className="h-5 w-5 animate-spin" />
                  Connection interrupted — reconnecting…
                </p>
                {transferError && <p className="text-sm text-blue-700">{transferError}</p>}
                <p className="text-sm text-gray-600">Received data is kept; the transfer will resume where it stopped.</p>
              </div>
            )}

            {/* Connection lost while idle */}
            {status === "disconnected" && (
              <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-center space-y-1">
                <p className="font-semibold text-red-800">Connection lost</p>
                {transferError && <p className="text-sm text-red-700">{transferError}</p>}
                <p className="text-sm text-gray-600">Waiting for the sender to reconnect…</p>
              </div>
            )}

            {/* Batch failed / cancelled */}
            {(status === "error" || status === "cancelled") && (
              <div className={`rounded-lg p-4 text-center space-y-1 border ${status === "error"
                ? "bg-red-50 border-red-300"
                : "bg-amber-50 border-amber-300"
                }`}>
                <p className={`font-semibold flex items-center justify-center gap-2 ${status === "error" ? "text-red-800" : "text-amber-800"}`}>
                  <AlertCircle className="h-5 w-5" />
                  {status === "error" ? "Transfer failed" : "Transfer cancelled"}
                </p>
                {transferError && (
                  <p className={`text-sm ${status === "error" ? "text-red-700" : "text-amber-700"}`}>{transferError}</p>
                )}
                <p className="text-sm text-gray-600">
                  Incomplete files were discarded. {completedFiles.length > 0 &&
                    `${completedFiles.length} completed file${completedFiles.length > 1 ? "s were" : " was"} kept.`}
                </p>
              </div>
            )}

            {/* Save location (Chromium: write straight to a folder instead of Downloads) */}
            {showSaveLocation && (
              <div className="flex items-center justify-between gap-3 border border-gray-200 rounded-lg px-4 py-3 bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <FolderOpen className="h-5 w-5 text-gray-500 shrink-0" />
                  <span className="text-sm text-gray-700 truncate">
                    {saveDirectoryName
                      ? <>Saving to folder <span className="font-medium">{saveDirectoryName}</span></>
                      : "Saving to your browser's downloads"}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={chooseSaveDirectory} className="text-sm text-blue-600 hover:underline">
                    {saveDirectoryName ? "Change" : "Choose folder"}
                  </button>
                  {saveDirectoryName && (
                    <button onClick={clearSaveDirectory} className="text-sm text-gray-500 hover:underline">
                      Use downloads
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Storage warning for this batch (e.g. large transfer held in memory) */}
            {storageInfo?.warning && filesMetadata.length > 0 && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <span>{storageInfo.warning}</span>
              </div>
            )}

            {/* Show all files when metadata arrives */}
            {filesMetadata.length > 0 && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-lg">
                    Incoming Files ({filesMetadata.length})
                  </h3>
                  {(status === "receiving" || status === "reconnecting") && (
                    <button
                      onClick={cancelTransfer}
                      className="text-sm border border-red-300 text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg flex items-center gap-1"
                    >
                      <Ban className="h-4 w-4" />
                      Cancel
                    </button>
                  )}

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
                      className={`border rounded-lg p-4 ${completedFiles.includes(index)
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
                              {savedNames[index] && (
                                <span className="ml-2 inline-flex items-center gap-1 text-green-700">
                                  <HardDrive className="h-3.5 w-3.5" />
                                  Saved as {savedNames[index]}
                                </span>
                              )}
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
                          className={`h-2 rounded-full transition-all ${completedFiles.includes(index)
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
                  {completedFiles.length} file{completedFiles.length > 1 ? 's' : ''} {storageInfo?.kind === "directory" ? `saved to ${saveDirectoryName ?? "your folder"}` : "downloaded"}
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
