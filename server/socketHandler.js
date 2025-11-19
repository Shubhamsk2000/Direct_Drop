
export default function socketHanlder(io) {
    const rooms = new Map();
    const userToRoom = new Map();

    //generate unique room code
    function generateCode() {
        let code;
        do {
            code = Math.floor(1000 + Math.random() * 9000).toString();
        } while (rooms.has(code));
        return code;
    };

    io.on('connection', (socket) => {
        console.log('\nUser connected with id :' + socket.id);

        socket.on('create-room', () => {
            // Clean up any existing room for this user
            const existingCode = userToRoom.get(socket.id);
            if (existingCode) {
                const existingRoom = rooms.get(existingCode);
                if (existingRoom && existingRoom.sender === socket.id) {
                    socket.leave(existingCode);
                    rooms.delete(existingCode);
                    userToRoom.delete(socket.id);
                    console.log(`Cleaned up existing room: ${existingCode}`);
                }
            }

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

        socket.on('join-room', (code) => {
            if (!rooms.has(code)) {
                //TODO: Implement this event at frontend
                socket.emit('error', 'Room not found. Please check the code and try again.');
                return;
            }

            const room = rooms.get(code);

            if (room.receiver) {
                socket.emit('error', 'Room is full. Please try a different code.');
                return;
            }

            socket.join(code);
            room.receiver = socket.id;
            userToRoom.set(socket.id, code);

            io.to(code).emit('peer-connected');
            console.log(`User ${socket.id} joined room: ${code}`);
        });

        socket.on('webrtc-offer', ({ offer }) => {
            const code = userToRoom.get(socket.id);
            if (code) {
                console.log(`Forwarding offer from ${socket.id} to room ${code}`);
                socket.broadcast.to(code).emit('webrtc-offer', { offer });
            }
        });

        socket.on('webrtc-answer', ({answer}) => {
            const code = userToRoom.get(socket.id);
            if(code){
                console.log(`Forwarding answer from ${socket.id} to room ${code}`);
                socket.broadcast.to(code).emit('webrtc-answer', {answer});
            }
        });

        socket.on('webrtc-ice-candidate', ({ candidate}) => {
            const code = userToRoom.get(socket.id);
            if(code){
                socket.broadcast.to(code).emit('webrtc-ice-candidate', {candidate});
            }
        });

        socket.on('disconnect', () => {
            console.log("User disconnected:", socket.id);
            
            // Clean up user's room
            const code = userToRoom.get(socket.id);
            if (code) {
                const room = rooms.get(code);
                if (room) {
                    // Notify the other peer
                    socket.broadcast.to(code).emit('peer-disconnected');
                    
                    // If user was sender, delete the room
                    if (room.sender === socket.id) {
                        rooms.delete(code);
                        console.log(`Room ${code} deleted (sender left)`);
                    } 
                    // If user was receiver, just clear receiver
                    else if (room.receiver === socket.id) {
                        room.receiver = null;
                        console.log(`Receiver left room ${code}`);
                    }
                }
                userToRoom.delete(socket.id);
            }
        });

    });
};
