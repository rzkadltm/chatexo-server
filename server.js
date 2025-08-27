const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const initSignaling = require('./signal');

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"]
}));

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

const PORT = process.env.PORT || 3001;

// Store active rooms and users
const rooms = new Map();

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

// Initialize signaling
initSignaling(io, rooms);

// Clean up old empty rooms periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const roomAge = now - new Date(room.createdAt).getTime();
    if (room.users.size === 0 && roomAge > 3600000) {
      rooms.delete(roomId);
      console.log(`Cleaned up old empty room: ${roomId}`);
    }
  }
}, 300000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ChatExo Signaling Server running on port ${PORT}`);
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log(`🔐 Room password: "secret"`);
});