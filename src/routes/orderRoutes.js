const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { authMiddleware } = require('../middleware/authMiddleware');

/**
 * 所有订单接口均需登录
 */
router.use(authMiddleware);

/**
 * @route   POST /api/v1/orders
 * @desc    创建新销售订单
 */
router.post('/', orderController.createOrder);

/**
 * @route   GET /api/v1/orders
 * @desc    获取订单列表 (销售看自己，经理及以上看全店)
 */
router.get('/', orderController.getOrders);

/**
 * @route   POST /api/v1/orders/photos
 * @desc    上传合规照片 (关联订单 ID)
 */
router.post('/photos', orderController.uploadOrderPhoto);

module.exports = router;
