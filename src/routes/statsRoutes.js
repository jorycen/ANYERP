const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

/**
 * 所有统计接口均需登录
 */
router.use(authMiddleware);

/**
 * @route   GET /api/v1/stats/my-performance
 * @desc    销售员查看个人业绩与提成
 */
router.get('/my-performance', statsController.getMyPerformance);

/**
 * @route   GET /api/v1/stats/boss-dashboard
 * @desc    老板/经理查看营业全局看板
 * @access  MANAGER, BOSS, ADMIN
 */
router.get('/boss-dashboard', authorize('MANAGER', 'BOSS', 'ADMIN'), statsController.getBossDashboard);

module.exports = router;
