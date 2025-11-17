import { useContext, createContext, useEffect, useState, useMemo, useRef } from "react";
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
    const socketRef = useRef(null);

    const [peerConnected, setPeerConnected] = useState(false);
    const [connected, setConnected] = useState(false);
    const [connectionError, setConnectionError] = useState("");
    const [roomId, setRoomId] = useState(null);

    useEffect(() => {
        const socket = io(import.meta.env.VITE_BACKEND_URL, {
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
        });

        socketRef.current = socket;

        const onPeerConnected = () => setPeerConnected(true);
        const onConnect = () => {
            setConnected(true);
            setPeerConnected(false);
        }
        const onDisconnect = () => {
            setConnected(false);
            setPeerConnected(false);
            setRoomId(null);
        }
        const onError = (arg) => setError(arg);

        socket.on('peer-connected', onPeerConnected);
        socket.on('connect', onConnect);
        socket.on('error', onError);
        socket.on('disconnect', onDisconnect);

        return () => {
            socket.off('peer-connected', onPeerConnected);
            socket.off('connect', onConnect);
            socket.off('error', onError);
            socket.off('disconnect', onDisconnect);
            socket.close();
        };
    }, []);

    const socket = socketRef.current;

    const resetRoom = () => {
        setRoomId(null);
        setPeerConnected(false);
    }
    const clearError = () => {
        setConnectionError("");
    }
    const values = useMemo(() => ({
        socket,
        peerConnected,
        connected,
        connectionError,
        roomId,
        setRoomId,
        resetRoom,
        clearError,
    }), [socket, connected, peerConnected, connectionError, roomId]);

    return (
        <SocketContext.Provider value={values}>
            {children}
        </SocketContext.Provider>
    )
};

export const useSocket = () => {
    const ct = useContext(SocketContext);
    if (!ct) {
        throw new Error("useSocket must be used inside SocketProvider");
    }
    return ct;
};
