/**
 * 采购管理路由
 */
const Router = require('koa-router');
const { getRequestList, getRequestDetail, createRequest, approveRequest, revokeRequest, getSupplierList, getAllSuppliers, createSupplier, updateSupplier, deleteSupplier } = require('./controller');
const { requireRole } = require('../../middleware/permission');

const router = new Router();

router.use(requireRole('purchaser'));

router.get('/request-list', getRequestList);
router.get('/request-detail/:requestId', getRequestDetail);
router.post('/create-request', createRequest);
router.post('/approve-request/:requestId', approveRequest);
router.post('/revoke-request/:requestId', revokeRequest);
router.get('/supplier-list', getSupplierList);
router.get('/supplier-all', getAllSuppliers);
router.post('/supplier', createSupplier);
router.put('/supplier/:id', updateSupplier);
router.delete('/supplier/:id', deleteSupplier);

module.exports = router;
