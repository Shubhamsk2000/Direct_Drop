import { createContext, useContext } from "react"
import { useSocket } from "./SocketContext";

const PeerContext = createContext(null);

export const usePeer = () => {
    return useContext(PeerContext);
}
export const PeerProvider = ({ children }) => {
    const {socket} = useSocket();

    

    return (
        <PeerContext.Provider>
            {children}
        </PeerContext.Provider>
    )
}