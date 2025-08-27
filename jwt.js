const jwt = require('jsonwebtoken');

class JWTService {
  constructor() {
    this.secretKey = process.env.JWT_SECRET_KEY;
    this.refreshSecretKey = process.env.JWT_REFRESH_SECRET_KEY;
    
    if (!this.secretKey || !this.refreshSecretKey) {
      throw new Error('JWT_SECRET_KEY and JWT_REFRESH_SECRET_KEY must be set in environment variables');
    }

    // Default token expiration times
    this.accessTokenExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
    this.refreshTokenExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
  }

  /**
   * Generate access token
   * @param {Object} payload - User data to encode in token
   * @param {string} expiresIn - Token expiration time (optional)
   * @returns {string} JWT access token
   */
  generateAccessToken(payload, expiresIn = this.accessTokenExpiry) {
    try {
      return jwt.sign(
        { 
          ...payload, 
          type: 'access',
          iat: Math.floor(Date.now() / 1000)
        },
        this.secretKey,
        { 
          expiresIn,
          issuer: 'chatexo-server',
          audience: 'chatexo-client'
        }
      );
    } catch (error) {
      throw new Error(`Failed to generate access token: ${error.message}`);
    }
  }

  /**
   * Generate refresh token
   * @param {Object} payload - User data to encode in token
   * @param {string} expiresIn - Token expiration time (optional)
   * @returns {string} JWT refresh token
   */
  generateRefreshToken(payload, expiresIn = this.refreshTokenExpiry) {
    try {
      return jwt.sign(
        { 
          ...payload, 
          type: 'refresh',
          iat: Math.floor(Date.now() / 1000)
        },
        this.refreshSecretKey,
        { 
          expiresIn,
          issuer: 'chatexo-server',
          audience: 'chatexo-client'
        }
      );
    } catch (error) {
      throw new Error(`Failed to generate refresh token: ${error.message}`);
    }
  }

  /**
   * Generate both access and refresh tokens
   * @param {Object} payload - User data to encode in tokens
   * @returns {Object} Object containing both tokens
   */
  generateTokenPair(payload) {
    const accessToken = this.generateAccessToken(payload);
    const refreshToken = this.generateRefreshToken(payload);
    
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenExpiry
    };
  }

  /**
   * Verify access token
   * @param {string} token - JWT token to verify
   * @returns {Object} Decoded token payload
   */
  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.secretKey, {
        issuer: 'chatexo-server',
        audience: 'chatexo-client'
      });

      if (decoded.type !== 'access') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new Error('Access token expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid access token');
      } else {
        throw new Error(`Token verification failed: ${error.message}`);
      }
    }
  }

  /**
   * Verify refresh token
   * @param {string} token - JWT refresh token to verify
   * @returns {Object} Decoded token payload
   */
  verifyRefreshToken(token) {
    try {
      const decoded = jwt.verify(token, this.refreshSecretKey, {
        issuer: 'chatexo-server',
        audience: 'chatexo-client'
      });

      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new Error('Refresh token expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid refresh token');
      } else {
        throw new Error(`Refresh token verification failed: ${error.message}`);
      }
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} refreshToken - Valid refresh token
   * @returns {Object} New token pair
   */
  refreshAccessToken(refreshToken) {
    try {
      const decoded = this.verifyRefreshToken(refreshToken);
      
      // Remove JWT specific fields from payload
      const { iat, exp, iss, aud, type, ...userPayload } = decoded;
      
      // Generate new token pair
      return this.generateTokenPair(userPayload);
    } catch (error) {
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  /**
   * Decode token without verification (for debugging)
   * @param {string} token - JWT token to decode
   * @returns {Object} Decoded token payload
   */
  decodeToken(token) {
    try {
      return jwt.decode(token, { complete: true });
    } catch (error) {
      throw new Error(`Token decode failed: ${error.message}`);
    }
  }

  /**
   * Check if token is expired
   * @param {string} token - JWT token to check
   * @returns {boolean} True if token is expired
   */
  isTokenExpired(token) {
    try {
      const decoded = jwt.decode(token);
      if (!decoded || !decoded.exp) {
        return true;
      }
      
      const currentTime = Math.floor(Date.now() / 1000);
      return decoded.exp < currentTime;
    } catch (error) {
      return true;
    }
  }

  /**
   * Extract token from Authorization header
   * @param {string} authHeader - Authorization header value
   * @returns {string|null} Extracted token or null
   */
  extractTokenFromHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    
    return authHeader.substring(7); // Remove "Bearer " prefix
  }

  /**
   * Middleware for protecting routes with JWT
   * @param {boolean} optional - If true, doesn't throw error for missing token
   * @returns {Function} Express middleware function
   */
  authenticateToken(optional = false) {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;
      const token = this.extractTokenFromHeader(authHeader);

      if (!token) {
        if (optional) {
          req.user = null;
          return next();
        }
        return res.status(401).json({ 
          error: 'Access token required',
          code: 'TOKEN_MISSING'
        });
      }

      try {
        const decoded = this.verifyAccessToken(token);
        req.user = decoded;
        next();
      } catch (error) {
        return res.status(401).json({ 
          error: error.message,
          code: 'TOKEN_INVALID'
        });
      }
    };
  }
}

// Create and export a singleton instance
const jwtService = new JWTService();

module.exports = jwtService;