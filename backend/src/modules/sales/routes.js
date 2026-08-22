/**
 * 销售管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const {
  list,
  listProductOrders,
  exportOrders,
  listSalesReturnRequests,
  requestSalesReturn,
  reviewSalesReturn,
  confirmSalesReturnRefund,
  create,
  saveSalesDraft,
  updateSalesDraft,
  submitSalesDraft,
  deleteSalesDraft,
  detail,
  update,
  updateOrderItems,
  stats,
  approve,
  reject,
  auxiliaryStaff,
  paymentMethods,
  listDeposits,
  createDeposit,
  archiveDeposit,
  refundDeposit,
  availableDeposits,
  getProductPns,
  getProductSns,
  recalculateSettlementCost,
  getGrossProfit,
  updateSupplements,
  listSubsidyPhotos,
  replaceSubsidyPhotos,
  downloadSubsidyPhoto,
  downloadSubsidyPhotosArchive,
  downloadAllSubsidyPhotosArchive,
  createSubsidyPhotosDownloadTicket
} = require('./controller');
const { enforceStoreOwnership, requireRole } = require('../../middleware/permission');
const {
  getMonthlyTaskOptions,
  listMonthlyTasks,
  saveMonthlyTask,
  disableMonthlyTask
} = require('./monthlyTaskController');

const router = new Router();
const subsidyPhotoUpload = multer({
  limits: { files: 20, fileSize: 10 * 1024 * 1024 }
});
const subsidyPhotoRoles = requireRole('finance', 'manager', 'store_manager');

function normalizeDepositId(ctx, next) {
  ctx.params.depositId = ctx.params.depositId
    || ctx.request.body?.depositId
    || ctx.request.body?.deposit_id
    || ctx.query?.depositId
    || ctx.query?.deposit_id;
  return next();
}

router.get('/list', list);
router.get('/product-orders/:productId', listProductOrders);
router.get('/export', exportOrders);
router.get('/subsidy-photos', subsidyPhotoRoles, listSubsidyPhotos);
router.get('/subsidy-photos/batch-download-ticket', subsidyPhotoRoles, createSubsidyPhotosDownloadTicket);
router.get('/subsidy-photos/batch-download', subsidyPhotoRoles, downloadAllSubsidyPhotosArchive);
router.get('/subsidy-photos/:orderId/download', subsidyPhotoRoles, downloadSubsidyPhotosArchive);
router.get('/subsidy-photos/:orderId/files/:photoId', subsidyPhotoRoles, downloadSubsidyPhoto);
router.post('/subsidy-photos/:orderId', subsidyPhotoRoles, subsidyPhotoUpload.array('files', 20), replaceSubsidyPhotos);
router.get('/return-requests', listSalesReturnRequests);
router.post('/return-requests', enforceStoreOwnership, requestSalesReturn);
router.post('/return-requests/:returnId/review', reviewSalesReturn);
router.post('/return-requests/:returnId/refund-confirm', requireRole('finance'), confirmSalesReturnRefund);
router.get('/stats', stats);
router.get('/auxiliary-staff', auxiliaryStaff);
router.get('/monthly-tasks/options', getMonthlyTaskOptions);
router.get('/monthly-tasks', listMonthlyTasks);
router.post('/monthly-tasks', requireRole('admin', 'boss', 'manager', 'store_manager'), saveMonthlyTask);
router.put('/monthly-tasks/:taskId', requireRole('admin', 'boss', 'manager', 'store_manager'), saveMonthlyTask);
router.post('/monthly-tasks/:taskId/disable', requireRole('admin', 'boss', 'manager', 'store_manager'), disableMonthlyTask);
router.get('/payment-methods', paymentMethods);
router.get('/deposits', listDeposits);
router.post('/deposits', enforceStoreOwnership, createDeposit);
router.get('/deposits/available', availableDeposits);
router.post('/deposits/:depositId/archive', enforceStoreOwnership, archiveDeposit);
router.post('/deposits/:depositId/refund', enforceStoreOwnership, refundDeposit);
router.get('/deposit-list', listDeposits);
router.get('/deposits/list', listDeposits);
router.post('/deposit', enforceStoreOwnership, createDeposit);
router.post('/deposit-create', enforceStoreOwnership, createDeposit);
router.post('/deposits/create', enforceStoreOwnership, createDeposit);
router.get('/deposit-available', availableDeposits);
router.get('/available-deposits', availableDeposits);
router.get('/deposits/available-list', availableDeposits);
router.post('/deposit/:depositId/archive', enforceStoreOwnership, archiveDeposit);
router.post('/deposit/:depositId/refund', enforceStoreOwnership, refundDeposit);
router.post('/archive-deposit', normalizeDepositId, enforceStoreOwnership, archiveDeposit);
router.post('/refund-deposit', normalizeDepositId, enforceStoreOwnership, refundDeposit);
router.post('/deposits/archive', normalizeDepositId, enforceStoreOwnership, archiveDeposit);
router.post('/deposits/refund', normalizeDepositId, enforceStoreOwnership, refundDeposit);
router.get('/product-pns/:storeId/:productId', getProductPns);
router.get('/product-sns/:storeId/:productId', getProductSns);
router.post('/create', enforceStoreOwnership, create);
router.post('/draft', enforceStoreOwnership, saveSalesDraft);
router.put('/draft/:orderId', enforceStoreOwnership, updateSalesDraft);
router.post('/draft/:orderId/submit', enforceStoreOwnership, submitSalesDraft);
router.delete('/draft/:orderId', enforceStoreOwnership, deleteSalesDraft);
router.put('/order-items', enforceStoreOwnership, updateOrderItems);
router.post('/order-items', enforceStoreOwnership, updateOrderItems);
router.get('/:orderId/gross-profit', getGrossProfit);
router.put('/:orderId/supplements', enforceStoreOwnership, updateSupplements);
router.get('/:orderId', detail);
router.put('/:orderId', enforceStoreOwnership, update);
router.post('/:orderId/approve', approve);
router.post('/:orderId/reject', reject);
router.post('/:orderId/return-request', enforceStoreOwnership, requestSalesReturn);
router.post('/:orderId/recalculate-settlement-cost', recalculateSettlementCost);

module.exports = router;
