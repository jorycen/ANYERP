const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

/**
 * 所有库存接口均需登录
 */
router.use(authMiddleware);

/**
 * @route   GET /api/v1/inventory/products/:pn
 * @desc    根据 PN 获取商品基础资料
 */
router.get('/products/:pn', inventoryController.getProductByPN);

/**
 * @route   GET /api/v1/inventory/sns/:sn
 * @desc    校验序列号 (SN) 是否在库
 */
router.get('/sns/:sn', inventoryController.checkSNStatus);

/**
 * @route   GET /api/v1/inventory/stocks
 * @desc    获取当前门店全量库存清单
 */
router.get('/stocks', inventoryController.getStoreInventory);

/**
 * @route   POST /api/v1/inventory/stock-in
 * @desc    采购入库 (管理员/店长权限)
 */
router.post('/stock-in', authorize('MANAGER', 'BOSS', 'ADMIN'), inventoryController.stockIn);

module.exports = router;
