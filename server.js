require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Redis = require('redis');
const initSignaling = require('./signal');
const jwtService = require('./jwt');

const app = express();
const server = http.createServer(app);

// Redis client setup
const redis = Redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  retry_strategy: (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      console.error('Redis connection refused');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      return undefined;
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

redis.on('connect', () => {
  console.log('📡 Connected to Redis');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

redis.on('ready', () => {
  console.log('✅ Redis is ready');
});

// Connect to Redis
redis.connect().catch(console.error);

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

app.use('/api/', limiter);

const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const API_VERSION = 'v1';

// In-memory store for active connections (this won't persist, but rooms will)
const activeConnections = new Map();

// Redis helper functions
const RedisKeys = {
  room: (roomId) => `room:${roomId}`,
  roomsList: 'rooms:active',
  roomsLatest: 'rooms:latest'
};

class RoomManager {
  async createRoom(roomId, createdBy = null) {
    const roomData = {
      roomId,
      userCount: 0,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      createdBy,
      isActive: true
    };

    // Store room data
    await redis.hSet(RedisKeys.room(roomId), roomData);
    
    // Add to active rooms set
    await redis.sAdd(RedisKeys.roomsList, roomId);
    
    // Add to latest rooms sorted set (score is timestamp)
    const timestamp = Date.now();
    await redis.zAdd(RedisKeys.roomsLatest, {
      score: timestamp,
      value: roomId
    });

    console.log(`🏠 Room created: ${roomId}`);
    return roomData;
  }

  async getRoom(roomId) {
    const roomData = await redis.hGetAll(RedisKeys.room(roomId));
    if (Object.keys(roomData).length === 0) {
      return null;
    }
    
    // Convert userCount to number
    roomData.userCount = parseInt(roomData.userCount) || 0;
    roomData.isActive = roomData.isActive === 'true';
    
    return roomData;
  }

  async updateRoomActivity(roomId, userCount) {
    const exists = await redis.sIsMember(RedisKeys.roomsList, roomId);
    if (!exists) {
      return false;
    }

    await redis.hSet(RedisKeys.room(roomId), {
      userCount: userCount,
      lastActivity: new Date().toISOString(),
      isActive: userCount > 0
    });

    // Update latest rooms score
    await redis.zAdd(RedisKeys.roomsLatest, {
      score: Date.now(),
      value: roomId
    });

    return true;
  }

  async getLatestRooms(limit = 10) {
    // Get latest rooms (sorted by timestamp, descending)
    const roomIds = await redis.zRange(RedisKeys.roomsLatest, 0, limit - 1, {
      REV: true
    });

    const rooms = [];
    for (const roomId of roomIds) {
      const roomData = await this.getRoom(roomId);
      if (roomData) {
        rooms.push(roomData);
      }
    }

    return rooms;
  }

  async getAllActiveRooms() {
    const roomIds = await redis.sMembers(RedisKeys.roomsList);
    const rooms = [];
    
    for (const roomId of roomIds) {
      const roomData = await this.getRoom(roomId);
      if (roomData) {
        rooms.push(roomData);
      }
    }

    return rooms.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  async removeRoom(roomId) {
    await redis.del(RedisKeys.room(roomId));
    await redis.sRem(RedisKeys.roomsList, roomId);
    await redis.zRem(RedisKeys.roomsLatest, roomId);
    console.log(`🗑️ Room removed: ${roomId}`);
  }

  async cleanupInactiveRooms() {
    const roomIds = await redis.sMembers(RedisKeys.roomsList);
    let cleaned = 0;
    
    for (const roomId of roomIds) {
      const roomData = await this.getRoom(roomId);
      if (roomData) {
        const lastActivity = new Date(roomData.lastActivity);
        const hoursSinceActivity = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
        
        // Remove rooms that have been inactive for more than 24 hours
        if (hoursSinceActivity > 24) {
          await this.removeRoom(roomId);
          cleaned++;
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} inactive rooms`);
    }
  }
}

const roomManager = new RoomManager();

// API Routes
const apiRouter = express.Router();

// Health check endpoint
apiRouter.get('/health', async (req, res) => {
  try {
    const totalRooms = await redis.sCard(RedisKeys.roomsList);
    
    res.json({
      message: 'ChatExo WebRTC Signaling Server is running!',
      version: API_VERSION,
      activeRooms: totalRooms,
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      redis: 'connected'
    });
  } catch (error) {
    res.json({
      message: 'ChatExo WebRTC Signaling Server is running!',
      version: API_VERSION,
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      redis: 'disconnected'
    });
  }
});

// Get latest rooms for mobile app home screen
apiRouter.get('/rooms/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const rooms = await roomManager.getLatestRooms(limit);
    
    res.json({
      rooms,
      count: rooms.length,
      limit,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching latest rooms:', error);
    res.status(500).json({
      error: 'Failed to fetch rooms',
      code: 'FETCH_ROOMS_ERROR'
    });
  }
});

// /auth/exchange (client sends auth token, gets access/refresh)
apiRouter.post('/auth/generate-token', (req, res) => {
  try {
    const { authToken, id, name } = req.body;
    console.log(authToken, id, name)

    if (authToken !== process.env.AUTH_TOKEN) {
      return res.status(401).json({
        error: 'Invalid auth token',
        code: 'INVALID_AUTH_TOKEN'
      });
    }

    if (!id || !name) {
      return res.status(400).json({
        error: 'ID and Name required',
        code: 'MISSING_USER_DATA'
      });
    }

    const userPayload = {
      id,
      name,
      role: 'user'
    };

    const tokens = jwtService.generateTokenPair(userPayload);

    res.json({
      message: 'Token generated successfully',
      user: userPayload,
      ...tokens
    });

  } catch (error) {
    console.error('Exchange error:', error);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

// Token refresh endpoint
apiRouter.post('/auth/refresh', async (req, res) => {
  try {
    const { authToken, refreshToken } = req.body;

    if (authToken !== process.env.AUTH_TOKEN) {
      return res.status(401).json({
        error: 'Invalid auth token',
        code: 'INVALID_AUTH_TOKEN'
      });
    }

    if (!refreshToken) {
      return res.status(400).json({
        error: 'Refresh token is required',
        code: 'MISSING_REFRESH_TOKEN'
      });
    }

    const newTokens = jwtService.refreshAccessToken(refreshToken);

    res.json({
      message: 'Token refreshed successfully',
      ...newTokens
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(401).json({
      error: error.message,
      code: 'REFRESH_FAILED'
    });
  }
});

// Logout endpoint
apiRouter.post('/auth/logout', jwtService.authenticateToken(), (req, res) => {
  res.json({
    message: 'Logout successful'
  });
});

// Room management endpoints
apiRouter.get('/rooms', jwtService.authenticateToken(true), async (req, res) => {
  try {
    const rooms = await roomManager.getAllActiveRooms();
    
    res.json({
      rooms,
      totalRooms: rooms.length
    });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({
      error: 'Failed to fetch rooms',
      code: 'FETCH_ROOMS_ERROR'
    });
  }
});

apiRouter.get('/rooms/:roomId', jwtService.authenticateToken(true), async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await roomManager.getRoom(roomId);
    
    if (room) {
      res.json(room);
    } else {
      res.status(404).json({ 
        error: 'Room not found',
        code: 'ROOM_NOT_FOUND'
      });
    }
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({
      error: 'Failed to fetch room',
      code: 'FETCH_ROOM_ERROR'
    });
  }
});

apiRouter.post('/rooms', jwtService.authenticateToken(), async (req, res) => {
  try {
    const { roomId } = req.body;
    
    if (!roomId) {
      return res.status(400).json({
        error: 'Room ID is required',
        code: 'MISSING_ROOM_ID'
      });
    }

    const existingRoom = await roomManager.getRoom(roomId);
    if (existingRoom) {
      return res.status(409).json({
        error: 'Room already exists',
        code: 'ROOM_EXISTS'
      });
    }

    const roomData = await roomManager.createRoom(roomId, req.user.id);

    res.status(201).json({
      message: 'Room created successfully',
      ...roomData
    });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({
      error: 'Failed to create room',
      code: 'CREATE_ROOM_ERROR'
    });
  }
});

// Token validation endpoint
apiRouter.post('/auth/validate', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = jwtService.extractTokenFromHeader(authHeader);

  if (!token) {
    return res.status(400).json({
      error: 'Token is required',
      code: 'MISSING_TOKEN'
    });
  }

  try {
    const decoded = jwtService.verifyAccessToken(token);
    res.json({
      valid: true,
      user: {
        id: decoded.id,
      },
      expiresAt: new Date(decoded.exp * 1000).toISOString()
    });
  } catch (error) {
    res.status(401).json({
      valid: false,
      error: error.message,
      code: 'TOKEN_INVALID'
    });
  }
});

// Mount API routes
app.use(`/api/${API_VERSION}`, apiRouter);

// Legacy routes for backwards compatibility
app.get('/', async (req, res) => {
  try {
    const totalRooms = await redis.sCard(RedisKeys.roomsList);
    res.json({ 
      message: 'ChatExo WebRTC Signaling Server is running!',
      version: API_VERSION,
      apiEndpoint: `/api/${API_VERSION}`,
      activeRooms: totalRooms,
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      message: 'ChatExo WebRTC Signaling Server is running!',
      version: API_VERSION,
      apiEndpoint: `/api/${API_VERSION}`,
      activeConnections: activeConnections.size,
      timestamp: new Date().toISOString()
    });
  }
});

// Initialize signaling with Redis support
initSignaling(io, activeConnections, roomManager);

// Clean up old rooms periodically (every hour)
setInterval(async () => {
  try {
    await roomManager.cleanupInactiveRooms();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}, 3600000); // 1 hour

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    method: req.method,
    path: req.originalUrl,
    availableEndpoints: {
      health: `GET /api/${API_VERSION}/health`,
      latestRooms: `GET /api/${API_VERSION}/rooms/latest`,
      generateToken: `POST /api/${API_VERSION}/auth/generate-token`,
      refresh: `POST /api/${API_VERSION}/auth/refresh`,
      validate: `POST /api/${API_VERSION}/auth/validate`,
      logout: `POST /api/${API_VERSION}/auth/logout`,
      rooms: `GET /api/${API_VERSION}/rooms`,
      createRoom: `POST /api/${API_VERSION}/rooms`
    },
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    redis.quit();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    redis.quit();
    process.exit(0);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ChatExo Signaling Server running on port ${PORT}`);
  console.log(`📡 Server URL: http://localhost:${PORT}`);
  console.log(`🔌 API Endpoint: http://localhost:${PORT}/api/${API_VERSION}`);
  console.log(`🏠 Latest Rooms: http://localhost:${PORT}/api/${API_VERSION}/rooms/latest`);
  console.log(`🔐 Default password: "secret"`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
});