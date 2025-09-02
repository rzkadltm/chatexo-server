require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const initSignaling = require('./signal');
const jwtService = require('./jwt');

const app = express();
const server = http.createServer(app);

// Security middleware with updated configuration for WebSocket
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP to avoid WebSocket blocking
  crossOriginEmbedderPolicy: false
}));

// Enhanced CORS configuration for web browsers
const allowedOrigins = [
  'http://localhost:3000',
  'https://localhost:3000', 
  'http://localhost:8081', // Expo dev server
  'https://localhost:8081',
  'http://127.0.0.1:3000',
  'https://127.0.0.1:3000',
  'http://192.168.1.100:3000', // Add your local IP
  'https://192.168.1.100:3000',
  ...(process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) || [])
];

console.log('Allowed origins:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps)
    if (!origin) return callback(null, true);
    
    // Allow localhost in any form and configured origins
    if (origin.includes('localhost') || 
        origin.includes('127.0.0.1') ||
        origin.includes('192.168.') ||
        allowedOrigins.includes(origin) ||
        process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    console.log('CORS blocked origin:', origin);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Origin", "X-Requested-With", "Accept"],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);

// Enhanced Socket.IO configuration for web browser compatibility
const io = socketIo(server, {
  cors: {
    origin: function (origin, callback) {
      // Same logic as Express CORS
      if (!origin) return callback(null, true);
      
      if (origin.includes('localhost') || 
          origin.includes('127.0.0.1') ||
          origin.includes('192.168.') ||
          allowedOrigins.includes(origin) ||
          process.env.NODE_ENV === 'development') {
        return callback(null, true);
      }
      
      console.log('Socket.IO CORS blocked origin:', origin);
      return callback(null, false);
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  // Enhanced transport configuration for web browsers
  transports: ['websocket', 'polling'],
  allowEIO3: true, // Allow older Engine.IO clients
  upgradeTimeout: 30000, // 30 seconds for upgrade
  pingTimeout: 60000, // 60 seconds before considering connection dead
  pingInterval: 25000, // Ping every 25 seconds
  maxHttpBufferSize: 1e6, // 1MB max buffer
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 10,
    windowBits: 13
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const API_VERSION = 'v1';

// Store active rooms and users
const rooms = new Map();

// API Routes
const apiRouter = express.Router();

// Health check endpoint with enhanced information
apiRouter.get('/health', (req, res) => {
  res.json({
    message: 'ChatExo WebRTC Signaling Server is running!',
    version: API_VERSION,
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    platform: process.platform,
    nodeVersion: process.version,
    allowedOrigins: allowedOrigins,
    socketTransports: ['websocket', 'polling']
  });
});

// Enhanced debug endpoint for troubleshooting
apiRouter.get('/debug', (req, res) => {
  res.json({
    server: {
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      allowedOrigins: allowedOrigins
    },
    rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      userCount: room.users.size,
      users: Array.from(room.users),
      createdAt: room.createdAt
    })),
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});

// /auth/exchange (client sends auth token, gets access/refresh)
apiRouter.post('/auth/generate-token', (req, res) => {
  try {
    const { authToken, id, name } = req.body;
    console.log('Token generation request:', { authToken: authToken ? 'provided' : 'missing', id, name });

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
  // In a real application, you might want to blacklist the token
  res.json({
    message: 'Logout successful'
  });
});

// Room management endpoints
apiRouter.get('/rooms', jwtService.authenticateToken(true), (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([roomId, room]) => ({
    roomId,
    userCount: room.users.size,
    createdAt: room.createdAt,
    isActive: room.users.size > 0
  }));

  res.json({
    rooms: roomList,
    totalRooms: rooms.size
  });
});

apiRouter.get('/rooms/:roomId', jwtService.authenticateToken(true), (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (room) {
    res.json({
      roomId,
      userCount: room.users.size,
      createdAt: room.createdAt,
      users: req.user ? Array.from(room.users.keys()) : [] // Only show users if authenticated
    });
  } else {
    res.status(404).json({ 
      error: 'Room not found',
      code: 'ROOM_NOT_FOUND'
    });
  }
});

apiRouter.post('/rooms', jwtService.authenticateToken(), (req, res) => {
  const { roomId } = req.body;
  
  if (!roomId) {
    return res.status(400).json({
      error: 'Room ID is required',
      code: 'MISSING_ROOM_ID'
    });
  }

  if (rooms.has(roomId)) {
    return res.status(409).json({
      error: 'Room already exists',
      code: 'ROOM_EXISTS'
    });
  }

  // Create new room
  rooms.set(roomId, {
    users: new Map(),
    createdAt: new Date().toISOString(),
    createdBy: req.user.id
  });

  res.status(201).json({
    message: 'Room created successfully',
    roomId,
    createdAt: rooms.get(roomId).createdAt
  });
});

// Token validation endpoint (useful for client-side token checks)
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
app.get('/', (req, res) => {
  res.json({ 
    message: 'ChatExo WebRTC Signaling Server is running!',
    version: API_VERSION,
    apiEndpoint: `/api/${API_VERSION}`,
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    allowedOrigins: allowedOrigins
  });
});

// CORS preflight handler for all routes
app.options('*', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    if (origin.includes('localhost') || 
        origin.includes('127.0.0.1') ||
        origin.includes('192.168.') ||
        allowedOrigins.includes(origin) ||
        process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    return callback(null, false);
  },
  credentials: true
}));

// Initialize signaling with JWT support
initSignaling(io, rooms, jwtService);

// Enhanced Socket.IO connection logging
io.engine.on('connection_error', (err) => {
  console.log('Socket.IO connection error:', err.req);
  console.log('Error code:', err.code);
  console.log('Error message:', err.message);
  console.log('Error context:', err.context);
});

// Clean up old empty rooms periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const roomAge = now - new Date(room.createdAt).getTime();
    if (room.users.size === 0 && roomAge > 3600000) { // 1 hour
      rooms.delete(roomId);
      console.log(`Cleaned up old empty room: ${roomId}`);
    }
  }
}, 300000); // 5 minutes

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  console.error('Request details:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: req.get('origin')
  });
  
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    timestamp: new Date().toISOString()
  });
});

// Enhanced 404 handler
app.use((req, res) => {
  console.log('404 - Not found:', req.method, req.originalUrl, 'Origin:', req.get('origin'));
  
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    method: req.method,
    path: req.originalUrl,
    availableEndpoints: {
      health: `GET /api/${API_VERSION}/health`,
      debug: `GET /api/${API_VERSION}/debug`,
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

// Enhanced server startup with more detailed logging
server.listen(PORT, "0.0.0.0", () => {
  console.log('='.repeat(60));
  console.log(`ChatExo Signaling Server STARTED`);
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Local URL: http://localhost:${PORT}`);
  console.log(`API Endpoint: http://localhost:${PORT}/api/${API_VERSION}`);
  console.log(`Auth Token: ${process.env.AUTH_TOKEN ? 'configured' : 'NOT SET'}`);
  console.log(`Allowed Origins:`, allowedOrigins);
  console.log(`Socket.IO Transports: websocket, polling`);
  console.log('='.repeat(60));
  
  // Test Socket.IO initialization
  console.log('Socket.IO server initialized successfully');
  console.log('WebSocket upgrade support: enabled');
  console.log('CORS configuration: enhanced for web browsers');
});