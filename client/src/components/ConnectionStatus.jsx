import React, { useState } from 'react';
import { WifiOff, AlertCircle, Copy, Check, RotateCcw } from 'lucide-react';
import { useSocket } from '../provider/SocketContext';

const ConnectionStatus = ({
    connected,
    roomId,
    peerConnected,
    connectionError
}) => {
    const { resetRoom } = useSocket();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(roomId);
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
        } catch (err) {
            console.error(err.message);
        }
    };

    return (
        <div className="space-y-4">
            {connectionError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
                    <p className="text-sm">{connectionError}</p>
                </div>
            )}

            {/* Header Row: Status on Left, Controls on Right */}
            <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-gray-100 shadow-sm">
                
                {/* Left: Connection Status */}
                <div className="flex items-center gap-2 px-2">
                    {connected ? (
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-3 w-3">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                            </span>
                            <span className="text-sm font-medium text-gray-700">Connected to Server</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <WifiOff className="h-4 w-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-500">Disconnected from Server</span>
                        </div>
                    )}
                </div>

                {/* Right: Room Info & Reset Action */}
                {roomId && (
                    <div className="flex items-center gap-2">
                        {/* Room Badge */}
                        <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-gray-50 rounded-md border border-gray-100">
                            <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">Room</span>
                            <span className="text-sm font-mono font-bold text-gray-700">
                                {roomId}
                            </span>
                        </div>

                        <button 
                            onClick={resetRoom}
                            title="Disconnect and Reset"
                            className="p-2 rounded-md cursor-pointer text-red-600 hover:bg-red-50 transition-all duration-200"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>

            {/* Large Copy Area (Only shows when waiting for peer) */}
            {roomId && !peerConnected && (
                <div className="p-8 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center hover:border-gray-300 transition-colors">
                    <div className="text-center space-y-4">
                        <div className="relative group">
                            <div className="flex justify-center items-center gap-4">
                                <span className="text-5xl font-bold tracking-widest text-gray-800 font-mono select-all">
                                    {roomId}
                                </span>
                                
                                <button
                                    onClick={handleCopy}
                                    className={`
                                        p-3 rounded-xl transition-all duration-200 shadow-sm
                                        ${copied 
                                            ? "bg-green-500 text-white rotate-3 scale-110" 
                                            : "bg-white text-gray-500 hover:text-gray-800 hover:shadow-md border border-gray-100"
                                        }
                                    `}
                                >
                                    {copied ? <Check className="w-6 h-6" /> : <Copy className="w-6 h-6" />}
                                </button>
                            </div>
                        </div>

                        <p className="text-gray-500 font-medium">
                            Share this code to connect
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ConnectionStatus;