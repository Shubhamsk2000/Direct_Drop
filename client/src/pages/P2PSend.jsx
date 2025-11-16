import ConnectionStatus from '../components/ConnectionStatus';
import { useSocket } from '../provider/SocketContext'
import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, FileUp, RefreshCw } from 'lucide-react';

const P2PSend = () => {
  const { socket, peerConnected, connected, setRoomId, roomId } = useSocket();
  const [dataChannel, setDataChannel] = useState(null);
  const [file, setFile] = useState(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [transferProgress, setTransferProgress] = useState(null);
  const [transferState, setTransferState] = useState('idle');
  const fileInputRef = useRef(null);

  const peerConnection = useMemo(() => new RTCPeerConnection(), []);

  const handleFileChange = (ev) => {
    const file = ev.target.files?.[0] || null;
    setFile(file);
    setTransferState('idle');
    setTransferProgress(null);
  }

  const triggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };
  const handleCreateRoom = useCallback(() => {
    if (roomId) return;

    setGeneratingCode(true);
    socket.emit('create-room');
    console.log("room creating ")
  }, [socket]);

  const onGeneratedCode = useCallback((arg) => {
    setRoomId(arg);
    console.log(arg);
    setGeneratingCode(false);
  }, []);

  const handleReceiveOffer = useCallback(async ({ offer }) => {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      const answer = await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(answer);

      console.log("Sending answer...");
      socket.emit('webrtc-answer', { answer });
    } catch (error) {
      console.log(error.message)
    }
  }, []);


  useEffect(() => {
    if (!socket) return;

    socket.on('webrtc-offer', handleReceiveOffer);

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', { candidate: event.candidate });
      }
    };

    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onopen = () => {
        channel.bufferedAmountLowThreshold = 64 * 1024;
        console.log("Sender: Data channel OPEN");
      }
      channel.onmessage = (event) => console.log("Sender: Msg:", event.data);

      setDataChannel(channel);
    }

    const handleReceiveICECaandidate = async ({ candidate }) => {
      try {
        if (candidate) {
          peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (error) {
        console.log(error.message);
      }
    };

    socket.on('webrtc-ice-candidate', handleReceiveICECaandidate);
    socket.on('generated-code', onGeneratedCode);
    socket.on('peer-connected', () => {
      console.log("connected to room");
    })
    return () => {
      socket.off('webrtc-offer', handleReceiveOffer);
      socket.off('generated-code');
      socket.off('peer-connected');
      socket.off('webrtc-ice-candidate', handleReceiveICECaandidate);
    }
  }, [socket, peerConnection]);

  const handleSendFile = async () => {
    if(transferState === 'sending') return;
    setTransferState('sending');
    setTransferProgress(0);
    try {
      if (dataChannel && dataChannel.readyState === 'open' && file) {
        const metadata = {
          type: 'metadata',
          name: file.name,
          size: file.size
        };
        dataChannel.send(JSON.stringify(metadata));

        const CHUNK_SIZE = 64 * 1024; //64KB
        let offset = 0;

        console.log(`Sending file: ${file.name}, size: ${file.size}`);

        while (offset < file.size) {
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buffer = await slice.arrayBuffer();

          while (dataChannel.bufferedAmount > 512 * 1024) {
            await new Promise((resolve) => {
              dataChannel.onbufferedamountlow = () => resolve();
            });
          }

          dataChannel.send(buffer);
          offset += buffer.byteLength;

          setTransferProgress(((offset / file.size) * 100));
          console.log(`Sent: ${((offset / file.size) * 100).toFixed(2)}%`);
        }
        console.log("🟩 File sending Completed..");
      }
      setTransferState("complete");
    } catch (error) {
      console.log("Error in handleSendFile :", error.message);
      setTransferState("idle");
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
        />

        {
          !roomId ? (
            <div className='mt-8 flex flex-col items-center'>
              <button
                className='bg-(--accent-500) px-6 py-2 text-lg rounded-lg text-white cursor-pointer'
                disabled={!connected || generatingCode}
                onClick={handleCreateRoom}
              >
                {
                  generatingCode ? (
                    <>
                      {console.log(roomId)}
                      <RefreshCw className='w-5 h-5 animate-spin' />
                      Generating code
                    </>
                  ) : (
                    <>Generate Code</>
                  )
                }
              </button>
            </div>
          ) : (
            <div className='mt-8'>
              {
                peerConnected && (
                  <div className='space-y-6'>
                    <div className="flex items-center justify-center gap-2 text-success-500">
                      <CheckCircle className="h-6 w-6" />
                      <span className="font-medium">Connected to receiver</span>
                    </div>

                    <div className='border-2 border-dashed border-gray-200 rounded-lg p-8 text-center'>
                      {file ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-center gap-2 ">
                            <FileUp className="h-6 w-6 text-primary-500" />
                            <span className="font-medium text-lg wrap-break-word w-full">{file.name}</span>
                          </div>
                          <p className="text-gray-500 text-sm">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-lg font-medium">Drag & drop a file or click to browse</p>
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
                        <button
                          onClick={triggerFileInput}
                          className="mt-4 btn-outline cursor-pointer"
                        >
                          Select File
                        </button>
                      )}
                    </div>

                    {
                      file && transferState === 'idle' && (
                        <div className="flex justify-center">
                          <button
                            onClick={handleSendFile}
                            className='bg-(--accent-500) px-4 py-2 rounded-lg text-white cursor-pointer '
                          >
                            send File
                          </button>
                        </div>
                      )
                    }
                    {
                      file && transferState === 'sending' && (
                        <div className="w-full bg-gray-200 h-2 rounded-xl overflow-hidden">
                          <div
                            className="h-2  bg-green-600 rounded-2xl transition-all"
                            style={{ width: `${transferProgress}%` }}
                          />
                        </div>
                      )
                    }

                    {
                      file && transferState === 'complete' && (
                        <div>
                          File Transfered Successfully !
                        </div>
                      )
                    }

                  </div>
                )
              }

            </div>
          )
        }
      </div>
    </div >
  )
}

export default P2PSend