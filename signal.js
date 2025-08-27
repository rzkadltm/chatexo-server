function initSignaling(io, rooms) {
  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Join a room with password
    socket.on('join-room', (data) => {
      const { roomId, password } = data;
      console.log(`User ${socket.id} attempting to join room: ${roomId}`);

      // Validate password
      if (password !== 'secret') {
        socket.emit('join-error', { message: 'Invalid password' });
        return;
      }

      // Create room if it doesn't exist
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          password: 'secret',
          users: new Set(),
          createdAt: new Date().toISOString()
        });
        console.log(`Room created: ${roomId}`);
      }

      const room = rooms.get(roomId);

      // Add user to room
      room.users.add(socket.id);
      socket.join(roomId);
      socket.roomId = roomId;

      console.log(`User ${socket.id} joined room ${roomId}. Room size: ${room.users.size}`);

      // Notify user they joined successfully
      socket.emit('joined-room', {
        roomId,
        userCount: room.users.size,
        message: 'Successfully joined the room'
      });

      // Notify other users in the room
      socket.to(roomId).emit('user-joined', {
        userId: socket.id,
        userCount: room.users.size
      });

      // If there are other users, initiate peer connections
      if (room.users.size > 1) {
        socket.to(roomId).emit('new-user', { userId: socket.id });
      }
    });

    // Handle WebRTC offer
    socket.on('offer', (data) => {
      const { targetUserId, offer } = data;
      console.log(`Offer from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('offer', {
        fromUserId: socket.id,
        offer
      });
    });

    // Handle WebRTC answer
    socket.on('answer', (data) => {
      const { targetUserId, answer } = data;
      console.log(`Answer from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('answer', {
        fromUserId: socket.id,
        answer
      });
    });

    // Handle ICE candidates
    socket.on('ice-candidate', (data) => {
      const { targetUserId, candidate } = data;
      console.log(`ICE candidate from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('ice-candidate', {
        fromUserId: socket.id,
        candidate
      });
    });

    // Handle leaving room
    socket.on('leave-room', () => {
      handleUserLeave(socket, rooms);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.id}`);
      handleUserLeave(socket, rooms);
    });
  });
}

// Helper function to handle user leaving
function handleUserLeave(socket, rooms) {
  if (socket.roomId) {
    const room = rooms.get(socket.roomId);

    if (room) {
      room.users.delete(socket.id);
      console.log(`User ${socket.id} left room ${socket.roomId}. Room size: ${room.users.size}`);

      // Notify other users
      socket.to(socket.roomId).emit('user-left', {
        userId: socket.id,
        userCount: room.users.size
      });

      // Clean up empty rooms
      if (room.users.size === 0) {
        rooms.delete(socket.roomId);
        console.log(`Room ${socket.roomId} deleted (empty)`);
      }
    }

    socket.leave(socket.roomId);
    delete socket.roomId;
  }
}

module.exports = initSignaling;
