/**
 * 采购管理路由
 */
const Router = require('koa-router');
const { getRequestList, getRequestDetail, createRequest, approveRequest, revokeRequest, getSupplierList, getAllSuppliers, createSupplier, updateSupplier, deleteSupplier, sortSuppliers } = require('./controller');
const { requireRole } = require('../../middleware/permission');

const router = new Router();

// 供应商是全员可读的基础资料；新增、修改、删除仍受采购角色限制。
router.get('/supplier-list', getSupplierList);
router.get('/supplier-all', getAllSuppliers);

router.use(requireRole('purchaser'));

router.get('/request-list', getRequestList);
router.get('/request-detail/:requestId', getRequestDetail);
router.post('/create-request', createRequest);
router.post('/approve-request/:requestId', approveRequest);
router.post('/revoke-request/:requestId', revokeRequest);
router.post('/supplier/sort', sortSuppliers);
router.post('/supplier', createSupplier);
router.put('/supplier/:id', updateSupplier);
router.delete('/supplier/:id', deleteSupplier);

module.exports = router;
