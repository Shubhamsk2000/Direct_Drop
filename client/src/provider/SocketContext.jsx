import { useContext, createContext, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

// Disconnects we caused ourselves (or the server forced); everything else is a
// network drop the server keeps our room for (connection state recovery).
const INTENTIONAL_DISCONNECTS = new Set(['io client disconnect', 'io server disconnect']);

export const SocketProvider = ({ children }) => {
    // Kept in state (not a ref) so consumers re-render once the socket exists.
    const [socket, setSocket] = useState(null);

    const [peerConnected, setPeerConnected] = useState(false);
    // The peer is in the room but its signaling connection is down (it may come back).
    const [peerOffline, setPeerOffline] = useState(false);
    const [connected, setConnected] = useState(false);
    // We lost the server but expect to recover the session (room kept).
    const [reconnecting, setReconnecting] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [roomId, setRoomId] = useState(null);
    const roomIdRef = useRef(null);
    roomIdRef.current = roomId;

    useEffect(() => {
        const s = io(import.meta.env.VITE_BACKEND_URL, {
            // Keep trying: a recovered socket keeps its room and resumes transfers.
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });
        setSocket(s);

        const closeRoom = (message) => {
            setRoomId(null);
            setPeerConnected(false);
            setPeerOffline(false);
            setConnectionError(message);
        };

        const onPeerConnected = () => {
            setPeerConnected(true);
            setPeerOffline(false);
            setConnectionError(null);
        };
        // Server payload: { roomClosed: boolean } — true when the sender left.
        const onPeerDisconnected = ({ roomClosed } = {}) => {
            setPeerConnected(false);
            setPeerOffline(false);
            if (roomClosed) {
                closeRoom("The sender disconnected, so the room was closed.");
            } else {
                setConnectionError("The receiver disconnected. Waiting for them to rejoin…");
            }
        };
        const onPeerOffline = () => {
            setPeerOffline(true);
            setConnectionError("The other device lost its connection. Waiting for it to come back…");
        };
        const onPeerReconnected = () => {
            setPeerOffline(false);
            setConnectionError(null);
        };
        const onRoomExpired = () => {
            closeRoom("You were offline too long, so the session ended.");
        };
        const onConnect = () => {
            setConnected(true);
            setReconnecting(false);
            if (s.recovered) {
                // Same socket id and rooms; missed events are replayed.
                console.log("Socket: session recovered");
                setConnectionError(null);
                return;
            }
            if (roomIdRef.current) {
                closeRoom("Lost the connection to the server for too long, so the session ended.");
            } else {
                setPeerConnected(false);
            }
        };
        const onDisconnect = (reason) => {
            console.warn("Socket: disconnected:", reason);
            setConnected(false);
            if (roomIdRef.current && !INTENTIONAL_DISCONNECTS.has(reason)) {
                // Keep the room; the server holds our slot while we reconnect.
                setReconnecting(true);
                setConnectionError("Lost the connection to the server. Reconnecting…");
                return;
            }
            setRoomId(null);
            setPeerConnected(false);
            setPeerOffline(false);
        };
        const onError = (arg) => {
            setConnectionError(typeof arg === "string" ? arg : arg?.message || "Connection error");
        };
        // Leaving the page can't be resumed: release our room slot right away
        // instead of letting the server hold it for the recovery window.
        const onPageHide = (event) => {
            if (!event.persisted) s.disconnect();
        };

        s.on('peer-connected', onPeerConnected);
        s.on('peer-disconnected', onPeerDisconnected);
        s.on('peer-offline', onPeerOffline);
        s.on('peer-reconnected', onPeerReconnected);
        s.on('room-expired', onRoomExpired);
        s.on('connect', onConnect);
        s.on('error', onError);
        s.on('disconnect', onDisconnect);
        window.addEventListener('pagehide', onPageHide);

        return () => {
            window.removeEventListener('pagehide', onPageHide);
            s.off('peer-connected', onPeerConnected);
            s.off('peer-disconnected', onPeerDisconnected);
            s.off('peer-offline', onPeerOffline);
            s.off('peer-reconnected', onPeerReconnected);
            s.off('room-expired', onRoomExpired);
            s.off('connect', onConnect);
            s.off('error', onError);
            s.off('disconnect', onDisconnect);
            s.close();
            setSocket(null);
        };
    }, []);

    const resetRoom = useCallback(() => {
        // Free our slot on the server so the room isn't left "full" / orphaned.
        socket?.emit('leave-room');
        setRoomId(null);
        setPeerConnected(false);
        setPeerOffline(false);
        setConnectionError(null);
    }, [socket]);

    const clearError = useCallback(() => {
        setConnectionError(null);
    }, []);

    const values = useMemo(() => ({
        socket,
        peerConnected,
        peerOffline,
        connected,
        reconnecting,
        connectionError,
        roomId,
        setRoomId,
        resetRoom,
        clearError,
        setConnectionError
    }), [socket, connected, reconnecting, peerConnected, peerOffline, connectionError, roomId, resetRoom, clearError]);

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
