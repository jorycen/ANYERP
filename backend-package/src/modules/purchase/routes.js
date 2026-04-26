/**
 * 采购管理路由
 */
const Router = require('koa-router');
const { getRequestList, createRequest, approveRequest, getSupplierList, createSupplier, updateSupplier } = require('./controller');

const router = new Router();

router.get('/requests', getRequestList);
router.post('/requests', createRequest);
router.post('/requests/:requestId/approve', approveRequest);
router.get('/suppliers', getSupplierList);
router.post('/suppliers', createSupplier);
router.put('/suppliers/:id', updateSupplier);

module.exports = router;
