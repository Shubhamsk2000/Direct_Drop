import { useContext, createContext, useEffect, useState, useMemo, useRef } from "react";
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
    const socketRef = useRef(null);

    const [peerConnected, setPeerConnected] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState("");
    const [roomId, setRoomId] = useState(null);

    useEffect(() => {
        const socket = io(import.meta.env.VITE_BACKEND_URL, {
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
        });

        socketRef.current = socket;

        const onPeerConnected = () => setPeerConnected(true);
        const onConnect = () =>{
            setConnected(true);
            setPeerConnected(false);
        } 
        const onError = (arg) => setError(arg);

        socket.on('peer-connected', onPeerConnected);
        socket.on('connect', onConnect);
        socket.on('error', onError);

        return () => {
            socket.off('peer-connected', onPeerConnected);
            socket.off('connect', onConnect);
            socket.off('error', onError);
        };
    }, []);
    const socket = socketRef.current;

    const values = useMemo(() => ({
        socket,
        peerConnected,
        connected,
        error,
        roomId,
        setRoomId
    }), [socket, connected, peerConnected, error, roomId]);

    return (
        <SocketContext.Provider value={values}>
            {children}
        </SocketContext.Provider>
    )
};

export const useSocket = () => {
    return useContext(SocketContext);
};
