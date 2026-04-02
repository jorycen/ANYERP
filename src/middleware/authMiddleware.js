const jwt = require('jsonwebtoken');
const ApiResponse = require('../utils/ApiResponse');

/**
 * JWT 校验中间件
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return ApiResponse.error('No token provided').send(res, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // 注入用户信息 (userId, username, role, storeId)
    next();
  } catch (error) {
    return ApiResponse.error('Invalid or expired token').send(res, 401);
  }
};

/**
 * 角色校验中间件 (RBAC)
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return ApiResponse.error('Forbidden: Insufficient permissions').send(res, 403);
    }
    next();
  };
};

module.exports = { authMiddleware, authorize };
