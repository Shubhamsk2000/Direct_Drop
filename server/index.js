import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import socketHanlder from './socketHandler.js';

const PORT = 3000;

const app = express();
const server = createServer(app);

const io = new Server(server, {
 cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

socketHanlder(io);

server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});