const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplierController');
const { authMiddleware, authorize } = require('../middleware/authMiddleware');

router.use(authMiddleware);

/**
 * @route   GET /api/v1/suppliers
 * @desc    查询所有供应商
 */
router.get('/', supplierController.getAllSuppliers);

/**
 * @route   POST /api/v1/suppliers
 * @desc    新增供应商 (仅限经理及以上)
 */
router.post('/', authorize('MANAGER', 'BOSS', 'ADMIN'), supplierController.createSupplier);

module.exports = router;
