import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import socketHanlder, { RECOVERY_WINDOW_MS } from './socketHandler.js';
import socketHanlder, { RECOVERY_WINDOW_MS } from './socketHandler.js';

// Load .env when present (in production the vars come from the environment).
try {
  process.loadEnvFile();
} catch {}

const PORT = process.env.PORT || 3000;

// FRONTEND_URL may hold one origin or a comma-separated list.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  throw new Error('FRONTEND_URL is not set');
}

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
};

const app = express();
app.use(cors(corsOptions));
const server = createServer(app);

const io = new Server(server, {
  cors: corsOptions,
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

