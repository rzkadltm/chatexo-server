const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for both Express and Socket.io
app.use(cors({
  origin: "*", // In production, specify your app's domain
  methods: ["GET", "POST"]
}));

const io = socketIo(server, {
  cors: {
    origin: "*", // In production, specify your app's domain
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

const PORT = process.env.PORT || 3001;

// Store active rooms and users
const rooms = new Map();

// Room structure:
// {
//   roomId: {
//     password: 'secret',
//     users: Set of socket.id,
//     createdAt: timestamp
//   }
// }

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'ChatExo WebRTC Signaling Server is running!',
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Get room info endpoint
app.get('/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (room) {
    res.json({
      roomId,
      userCount: room.users.size,
      createdAt: room.createdAt
    });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Socket.io connection handling
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
      // Tell the new user about existing users
      socket.to(roomId).emit('new-user', { userId: socket.id });
    }
  });

  // Handle WebRTC offer
  socket.on('offer', (data) => {
    const { targetUserId, offer } = data;
    console.log(`Offer from ${socket.id} to ${targetUserId}`);
    
    socket.to(targetUserId).emit('offer', {
      fromUserId: socket.id,
      offer: offer
    });
  });

  // Handle WebRTC answer
  socket.on('answer', (data) => {
    const { targetUserId, answer } = data;
    console.log(`Answer from ${socket.id} to ${targetUserId}`);
    
    socket.to(targetUserId).emit('answer', {
      fromUserId: socket.id,
      answer: answer
    });
  });

  // Handle ICE candidates
  socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data;
    console.log(`ICE candidate from ${socket.id} to ${targetUserId}`);
    
    socket.to(targetUserId).emit('ice-candidate', {
      fromUserId: socket.id,
      candidate: candidate
    });
  });

  // Handle leaving room
  socket.on('leave-room', () => {
    handleUserLeave(socket);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    handleUserLeave(socket);
  });
});

// Helper function to handle user leaving
function handleUserLeave(socket) {
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

// Clean up old empty rooms periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const roomAge = now - new Date(room.createdAt).getTime();
    
    // Delete empty rooms older than 1 hour
    if (room.users.size === 0 && roomAge > 3600000) {
      rooms.delete(roomId);
      console.log(`Cleaned up old empty room: ${roomId}`);
    }
  }
}, 300000); // 5 minutes

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ChatExo Signaling Server running on port ${PORT}`);
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log(`🔐 Room password: "secret"`);
});