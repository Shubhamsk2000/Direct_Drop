import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import socketHanlder, { RECOVERY_WINDOW_MS } from './socketHandler.js';

const PORT = 3000;

const app = express();
const server = createServer(app);

const io = new Server(server, {
 cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // A socket that drops (Wi-Fi blip, phone backgrounded) and reconnects within
  // this window keeps its id and rooms, and receives the events it missed.
  connectionStateRecovery: {
    maxDisconnectionDuration: RECOVERY_WINDOW_MS,
    skipMiddlewares: true,
  },
});

socketHanlder(io);

server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
