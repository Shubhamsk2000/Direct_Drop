import React from 'react'
import { useSocket } from './provider/SocketContext';
import P2P from './pages/P2P';
import { Route, Routes } from 'react-router-dom';
import P2PSend from './pages/P2PSend';
import P2PReceive from './pages/P2PReceive'
import Navbar from './components/Navbar';


const App = () => {
  const socket = useSocket();

  return (
  <>
    <Navbar />
    <main className="app-container">
      <Routes>
        <Route path='/' element={<P2P />} />
        <Route path='/p2p/send' element={<P2PSend />} />
        <Route path='/p2p/receive' element={<P2PReceive />} />
      </Routes>
    </main>
    </>
  )
}

export default App;