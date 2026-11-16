// How long the server keeps a dropped socket's room slot while it tries to
// reconnect. Matches Socket.IO's connection-state-recovery window (index.js)
// plus a little slack, so any socket that *can* be recovered still has its
// room when it comes back. Also matches the receiver's resume window
// (RESUME_TIMEOUT_MS in client/src/webrtc/protocol.js).
export const RECOVERY_WINDOW_MS = 2 * 60 * 1000;
const LEAVE_GRACE_MS = RECOVERY_WINDOW_MS + 5_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

// Disconnect reasons that mean "gone on purpose" – no grace period.
const INTENTIONAL_DISCONNECTS = new Set(['client namespace disconnect', 'server namespace disconnect', 'server shutting down']);

export default function socketHanlder(io) {
    const rooms = new Map();       // code -> { sender, receiver }
    const userToRoom = new Map();  // socket id -> code
    const pendingLeaves = new Map(); // socket id -> timer (member offline, may reconnect)

    //generate unique room code
    function generateCode() {
        let code;
        do {
            code = Math.floor(1000 + Math.random() * 9000).toString();
        } while (rooms.has(code));
        return code;
    };

    /**
     * Remove `socketId` from its room and tell the other member.
     * If the sender leaves, the room is closed for everyone.
     */
    function leaveRoom(socketId) {
        clearPendingLeave(socketId);
        const code = userToRoom.get(socketId);
        if (!code) return;
        userToRoom.delete(socketId);
        io.in(socketId).socketsLeave(code);

        const room = rooms.get(code);
        if (!room) return;

        if (room.sender === socketId) {
            io.to(code).except(socketId).emit('peer-disconnected', { roomClosed: true });
            if (room.receiver) {
                clearPendingLeave(room.receiver);
                userToRoom.delete(room.receiver);
            }
            io.in(code).socketsLeave(code);
            rooms.delete(code);
            console.log(`Room ${code} deleted (sender left)`);
        } else if (room.receiver === socketId) {
            io.to(code).except(socketId).emit('peer-disconnected', { roomClosed: false });
            room.receiver = null;
            console.log(`Receiver left room ${code}`);
        }
    }

    // Recovery restores a socket from the id of the last event it received,
    // and the server forgets events older than the recovery window. A long
    // transfer sends no signaling at all, so ping every room regularly to keep
    // each member's last-event id fresh enough to recover from.
    setInterval(() => {
        for (const code of rooms.keys()) io.to(code).emit('room-keepalive');
    }, KEEPALIVE_INTERVAL_MS).unref();

    function clearPendingLeave(socketId) {
        const timer = pendingLeaves.get(socketId);
        if (!timer) return false;
        clearTimeout(timer);
        pendingLeaves.delete(socketId);
        return true;
    }

    io.on('connection', (socket) => {
        if (socket.recovered) {
            // Same socket id, rooms restored by Socket.IO, missed events replayed.
            const code = userToRoom.get(socket.id);
            if (clearPendingLeave(socket.id) && code) {
                console.log(`User ${socket.id} reconnected to room ${code}`);
                socket.broadcast.to(code).emit('peer-reconnected');
            } else if (!code) {
                // Recovered after its room was already gone.
                for (const room of socket.rooms) {
                    if (room !== socket.id) socket.leave(room);
                }
                socket.emit('room-expired');
            }
        } else {
            console.log('\nUser connected with id :' + socket.id);
        }

        socket.on('create-room', () => {

            // Leave any room this socket is already in (as sender or receiver).
            leaveRoom(socket.id);

            let code = generateCode();
            //add room code with there sender in the map
            rooms.set(code, {
                sender: socket.id,
                receiver: null,
            });

            userToRoom.set(socket.id, code);

            socket.join(code);

            socket.emit('generated-code', code);
            console.log(`User ${socket.id} created room: ${code}`);
        });

        socket.on('join-room', (code, callback) => {
            const reply = typeof callback === 'function' ? callback : () => {};
            if (!rooms.has(code)) {
                reply({
                    success: false,
                    message: 'Room not found. Please check the code and try again.'
                });
                return;
            }

            const room = rooms.get(code);
            if (room.receiver && room.receiver !== socket.id) {
                if (pendingLeaves.has(room.receiver)) {
                    // The old receiver dropped and hasn't come back (e.g. the page
                    // was reloaded): let the new one take its place.
                    console.log(`Receiver ${room.receiver} replaced in room ${code}`);
                    clearPendingLeave(room.receiver);
                    userToRoom.delete(room.receiver);
                    io.in(room.receiver).socketsLeave(code);
                    room.receiver = null;
                } else {
                    reply({
                        success: false,
                        message: 'Room is full. Please try a different code.'
                    });
                    return;
                }
            }

            socket.join(code);
            room.receiver = socket.id;
            userToRoom.set(socket.id, code);

            io.to(code).emit('peer-connected');
            console.log(`User ${socket.id} joined room: ${code}`);
            reply({ success: true });
        });

        // Signaling payloads carry a `sid` (sender's connection attempt id) so
        // stale messages replayed after a reconnect can be ignored by clients.
        socket.on('webrtc-offer', ({ offer, sid } = {}) => {
            const code = userToRoom.get(socket.id);
            if (code) {
                console.log(`Forwarding offer from ${socket.id} to room ${code}`);
                socket.broadcast.to(code).emit('webrtc-offer', { offer, sid });
            }
        });

        socket.on('webrtc-answer', ({ answer, sid } = {}) => {
            const code = userToRoom.get(socket.id);
            if (code) {
                console.log(`Forwarding answer from ${socket.id} to room ${code}`);
                socket.broadcast.to(code).emit('webrtc-answer', { answer, sid });
            }
        });

        socket.on('webrtc-ice-candidate', ({ candidate, sid } = {}) => {
            const code = userToRoom.get(socket.id);
            if (code) {
                socket.broadcast.to(code).emit('webrtc-ice-candidate', { candidate, sid });
            }
        });

        socket.on('leave-room', () => leaveRoom(socket.id));

        socket.on('disconnect', (reason) => {
            console.log("User disconnected:", socket.id, `(${reason})`);
            const code = userToRoom.get(socket.id);
            if (!code || INTENTIONAL_DISCONNECTS.has(reason)) {
                leaveRoom(socket.id);
                return;
            }
            // Network drop: keep the room slot so the socket can recover and
            // an interrupted transfer can resume.
            const id = socket.id;
            socket.broadcast.to(code).emit('peer-offline');
            clearPendingLeave(id);
            pendingLeaves.set(id, setTimeout(() => {
                pendingLeaves.delete(id);
                console.log(`User ${id} didn't reconnect; leaving room ${code}`);
                leaveRoom(id);
            }, LEAVE_GRACE_MS));
        });

    });
};
