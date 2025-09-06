function initSignaling(io, activeConnections, roomManager) {
  io.on('connection', (socket) => {
    console.log(`👤 User connected: ${socket.id}`);
    
    // Store connection info
    activeConnections.set(socket.id, {
      connectedAt: new Date().toISOString(),
      roomId: null
    });

    // Join a room with password
    socket.on('join-room', async (data) => {
      try {
        const { roomId, password } = data;
        console.log(`👤 User ${socket.id} attempting to join room: ${roomId}`);

        // Validate password
        if (password !== 'secret') {
          socket.emit('join-error', { message: 'Invalid password' });
          return;
        }

        // Get or create room
        let room = await roomManager.getRoom(roomId);
        if (!room) {
          room = await roomManager.createRoom(roomId);
        }

        // Update connection info
        const connectionInfo = activeConnections.get(socket.id);
        if (connectionInfo) {
          connectionInfo.roomId = roomId;
        }

        // Add socket to room
        socket.join(roomId);
        socket.roomId = roomId;

        // Update room user count (increment)
        const currentUserCount = (room.userCount || 0) + 1;
        await roomManager.updateRoomActivity(roomId, currentUserCount);

        console.log(`👤 User ${socket.id} joined room ${roomId}. Room size: ${currentUserCount}`);

        // Notify user they joined successfully
        socket.emit('joined-room', {
          roomId,
          userCount: currentUserCount,
          message: 'Successfully joined the room'
        });

        // Notify other users in the room
        socket.to(roomId).emit('user-joined', {
          userId: socket.id,
          userCount: currentUserCount
        });

        // If there are other users, initiate peer connections
        const roomSockets = await io.in(roomId).fetchSockets();
        if (roomSockets.length > 1) {
          socket.to(roomId).emit('new-user', { userId: socket.id });
        }

      } catch (error) {
        console.error('Error joining room:', error);
        socket.emit('join-error', { 
          message: 'Failed to join room',
          code: 'JOIN_ROOM_ERROR'
        });
      }
    });

    // Handle WebRTC offer
    socket.on('offer', (data) => {
      const { targetUserId, offer } = data;
      console.log(`📞 Offer from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('offer', {
        fromUserId: socket.id,
        offer
      });
    });

    // Handle WebRTC answer
    socket.on('answer', (data) => {
      const { targetUserId, answer } = data;
      console.log(`📞 Answer from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('answer', {
        fromUserId: socket.id,
        answer
      });
    });

    // Handle ICE candidates
    socket.on('ice-candidate', (data) => {
      const { targetUserId, candidate } = data;
      console.log(`🧊 ICE candidate from ${socket.id} to ${targetUserId}`);

      socket.to(targetUserId).emit('ice-candidate', {
        fromUserId: socket.id,
        candidate
      });
    });

    // Handle mute/unmute status
    socket.on('audio-status', (data) => {
      const { isMuted } = data;
      if (socket.roomId) {
        socket.to(socket.roomId).emit('user-audio-status', {
          userId: socket.id,
          isMuted
        });
        console.log(`🔊 User ${socket.id} ${isMuted ? 'muted' : 'unmuted'} in room ${socket.roomId}`);
      }
    });

    // Handle user speaking status (for visual indicators)
    socket.on('speaking-status', (data) => {
      const { isSpeaking } = data;
      if (socket.roomId) {
        socket.to(socket.roomId).emit('user-speaking-status', {
          userId: socket.id,
          isSpeaking
        });
      }
    });

    // Handle leaving room
    socket.on('leave-room', () => {
      handleUserLeave(socket, activeConnections, roomManager);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`👤 User disconnected: ${socket.id}`);
      handleUserLeave(socket, activeConnections, roomManager);
    });

    // Handle reconnection attempt
    socket.on('reconnect-to-room', async (data) => {
      try {
        const { roomId } = data;
        
        if (!roomId) {
          socket.emit('reconnect-error', { message: 'Room ID required for reconnection' });
          return;
        }

        const room = await roomManager.getRoom(roomId);
        if (!room) {
          socket.emit('reconnect-error', { message: 'Room no longer exists' });
          return;
        }

        // Rejoin the room
        socket.join(roomId);
        socket.roomId = roomId;

        const connectionInfo = activeConnections.get(socket.id);
        if (connectionInfo) {
          connectionInfo.roomId = roomId;
        }

        // Get current room size
        const roomSockets = await io.in(roomId).fetchSockets();
        await roomManager.updateRoomActivity(roomId, roomSockets.length);

        socket.emit('reconnected-to-room', {
          roomId,
          userCount: roomSockets.length,
          message: 'Successfully reconnected to room'
        });

        // Notify others of reconnection
        socket.to(roomId).emit('user-reconnected', {
          userId: socket.id,
          userCount: roomSockets.length
        });

        console.log(`👤 User ${socket.id} reconnected to room ${roomId}`);

      } catch (error) {
        console.error('Error reconnecting to room:', error);
        socket.emit('reconnect-error', { 
          message: 'Failed to reconnect to room',
          code: 'RECONNECT_ERROR'
        });
      }
    });

    // Handle ping for connection health check
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });
  });
}

// Helper function to handle user leaving
async function handleUserLeave(socket, activeConnections, roomManager) {
  try {
    if (socket.roomId) {
      const roomId = socket.roomId;
      
      // Get current room size before user leaves
      const roomSockets = await socket.nsp.in(roomId).fetchSockets();
      const newUserCount = Math.max(0, roomSockets.length - 1);

      console.log(`👤 User ${socket.id} left room ${roomId}. New room size: ${newUserCount}`);

      // Update room user count
      await roomManager.updateRoomActivity(roomId, newUserCount);

      // Notify other users
      socket.to(roomId).emit('user-left', {
        userId: socket.id,
        userCount: newUserCount
      });

      // Leave the socket.io room
      socket.leave(roomId);
      delete socket.roomId;

      // If room is empty, mark it as inactive but don't delete immediately
      // This allows for quick reconnections
      if (newUserCount === 0) {
        console.log(`🏠 Room ${roomId} is now empty`);
        // The room cleanup will happen in the scheduled cleanup process
      }
    }

    // Remove from active connections
    activeConnections.delete(socket.id);

  } catch (error) {
    console.error('Error handling user leave:', error);
  }
}

module.exports = initSignaling;