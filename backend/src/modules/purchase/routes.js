/**
 * 采购管理路由
 */
const Router = require('koa-router');
const { getRequestList, getRequestDetail, createRequest, saveRequestDraft, updateRequestDraft, submitRequestDraft, deleteRequestDraft, approveRequest, revokeRequest, getAdjustmentPreview, createPurchaseAdjustment, getSupplierList, getAllSuppliers, createSupplier, updateSupplier, deleteSupplier, sortSuppliers } = require('./controller');
const { requireRole } = require('../../middleware/permission');

const router = new Router();
const requirePurchaser = requireRole('purchaser');

// 采购申请和供应商基础资料允许全员读取；所有已登录且具备门店范围的用户均可提交申请。
router.get('/supplier-list', getSupplierList);
router.get('/supplier-all', getAllSuppliers);
router.get('/request-list', getRequestList);
router.get('/request-detail/:requestId', getRequestDetail);
router.post('/create-request', createRequest);
router.post('/request-draft', saveRequestDraft);
router.put('/request-draft/:requestId', updateRequestDraft);
router.post('/request-draft/:requestId/submit', submitRequestDraft);
router.delete('/request-draft/:requestId', deleteRequestDraft);

// 审批、撤销和供应商维护仍属于采购管理职责。
router.post('/approve-request/:requestId', requirePurchaser, approveRequest);
router.post('/revoke-request/:requestId', requirePurchaser, revokeRequest);
router.get('/adjustment-preview/:requestId', requirePurchaser, getAdjustmentPreview);
router.post('/create-adjustment', requirePurchaser, createPurchaseAdjustment);
router.post('/supplier/sort', requirePurchaser, sortSuppliers);
router.post('/supplier', requirePurchaser, createSupplier);
router.put('/supplier/:id', requirePurchaser, updateSupplier);
router.delete('/supplier/:id', requirePurchaser, deleteSupplier);

module.exports = router;
