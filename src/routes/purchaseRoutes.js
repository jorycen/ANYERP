const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

router.use(authMiddleware);
router.use(authorize('MANAGER', 'BOSS', 'ADMIN')); // 采购属核心功能，仅限管理角色

/**
 * @route   POST /api/v1/purchases
 * @desc    创建采购单 (PO)
 */
router.post('/', purchaseController.createPurchaseOrder);

/**
 * @route   PUT /api/v1/purchases/receive
 * @desc    确认采购入库
 */
router.put('/receive', purchaseController.receiveOrder);

module.exports = router;
