import React from 'react';
import { WifiOff, Wifi, AlertCircle } from 'lucide-react';


const ConnectionStatus = ({
    connected,
    roomId,
    peerConnected,
    connectionError
}) => {
    return (
        <div className="space-y-4">
            {connectionError && (
                <div className="p-3 bg-error-50 border border-error-200 rounded-lg flex items-center gap-2 text-error-700">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
                    <p className="text-sm">{connectionError}</p>
                </div>
            )}

            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {connected ? (
                        <Wifi className="h-5 w-5 text-success-500 text-green-600" />
                    ) : (
                        <WifiOff className="h-5 w-5 text-error-500 text-red-600" />
                    )}
                    <span className="text-sm font-medium">
                        {connected ? 'Connected to server' : 'Disconnected from server'}
                    </span>
                </div>

                {roomId && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500">Room:</span>
                        <span className="text-sm font-mono font-bold bg-gray-100 px-2 py-0.5 rounded">
                            {roomId}
                        </span>
                    </div>
                )}
            </div>

            {roomId && (
                <div className="p-4 bg-gray-50 rounded-lg flex items-center justify-center">
                    <div className="text-center">
                        {
                            !peerConnected &&
                            <>
                                <div className="text-4xl font-bold tracking-widest mb-2">{roomId}</div>
                                <>Share this code with the other person</>
                            </>
                        }
                    </div>
                </div>
            )}
        </div>
    );
};

export default ConnectionStatus;