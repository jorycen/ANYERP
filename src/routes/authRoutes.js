const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/authMiddleware');

/**
 * @route   POST /api/v1/auth/login
 * @desc    员工账号密码登录
 * @access  Public
 */
router.post('/login', authController.login);

/**
 * @route   GET /api/v1/auth/profile
 * @desc    获取当前登录员工资料
 * @access  Private
 */
router.get('/profile', authMiddleware, authController.getProfile);

module.exports = router;
