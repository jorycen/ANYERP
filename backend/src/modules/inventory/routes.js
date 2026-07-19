/**
 * 库房管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const {
  getList, exportList, getSnInventoryList, exportSnInventoryList, setSnSpecialPrice, cancelSnSpecialPrice,
  getSnSpecialPriceHistory, getSnList, getInboundList, getInboundDetail, getSnTraceInboundDetail,
  executeInbound, getReturnList, requestReturn, approveReturn, executeReturn,
  inbound, outbound, transfer, getTransferList, confirmTransferOut,
  confirmTransferIn, revokeTransfer, rejectTransfer, getTransferDetail, getConversionList, getConversionDetail, createConversion,
  voidConversion, getLocationsByStore, updateSn, adjustSnLocation, snTrace
} = require('./controller');
const { enforceStoreOwnership, requireRole } = require('../../middleware/permission');
const resourceRights = require('./resourceRights');
const batchMaintenance = require('./batchMaintenance');

const router = new Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/list', getList);
router.get('/list/export', exportList);
router.get('/sn-inventory-list', getSnInventoryList);
router.get('/sn-inventory-list/export', exportSnInventoryList);
router.put('/sn/:snId/special-price', requireRole('admin'), setSnSpecialPrice);
router.delete('/sn/:snId/special-price', requireRole('admin'), cancelSnSpecialPrice);
router.get('/sn/:snId/special-price-history', requireRole('admin'), getSnSpecialPriceHistory);
router.get('/sn-list', getSnList);
router.put('/sn/:snId', updateSn);
router.post('/sn/:snId/location-adjust', adjustSnLocation);
router.get('/sn-trace/:snCode', snTrace);
router.get('/sn-trace-inbound/:inboundId', getSnTraceInboundDetail);
router.get('/resource-rights', resourceRights.listRights);
router.get('/resource-rights/changes', resourceRights.listChanges);
router.get('/resource-rights/cost-configs', resourceRights.listCostConfigs);
router.get('/resource-rights/cost-adjustments', resourceRights.listCostAdjustments);
router.post('/resource-rights/cost-configs', resourceRights.saveCostConfig);
router.post('/resource-rights/batch-adjust', resourceRights.batchAdjustRights);
router.post('/resource-rights/batch-refresh', resourceRights.batchRefreshRights);
router.get('/resource-categories', resourceRights.listResourceCategories);
router.post('/resource-categories', resourceRights.saveResourceCategory);
router.delete('/resource-categories/:categoryId', resourceRights.deleteResourceCategory);
router.get('/goods-types', resourceRights.listGoodsTypes);
router.post('/goods-types', resourceRights.saveGoodsType);
router.delete('/goods-types/:goodsTypeId', resourceRights.deleteGoodsType);
router.get('/resource-settlements', resourceRights.listResourceSettlements);
router.post('/resource-settlements/manual-rebate', resourceRights.createManualRebateSettlement);
router.post('/resource-settlements/:settlementId/settle', resourceRights.settleResource);
router.post('/resource-settlements/:settlementId/cancel', resourceRights.cancelResourceSettlement);
router.post('/resource-settlements/:settlementId/reverse', resourceRights.reverseResourceSettlement);
router.post('/resource-rights/claim', resourceRights.submitClaim);
router.post('/resource-rights/claim/:changeId/review', resourceRights.reviewClaim);
router.get('/sn/:snId/resource-rights', resourceRights.snRights);
router.put('/sn/:snId/resource-rights', resourceRights.saveSnRights);
router.get('/batch-maintenance', batchMaintenance.listBatchApplications);
router.post('/batch-maintenance/import', requireRole('manager', 'admin'), upload.single('file'), batchMaintenance.createBatchApplication);
router.get('/batch-maintenance/:applicationId', batchMaintenance.getBatchApplicationDetail);
router.post('/batch-maintenance/:applicationId/review', requireRole('admin'), batchMaintenance.reviewBatchApplication);
router.get('/inbound-list', getInboundList);
router.get('/inbound-detail/:inboundId', getInboundDetail);
router.post('/execute-inbound', enforceStoreOwnership, executeInbound);
router.get('/return-list', getReturnList);
router.post('/request-return', enforceStoreOwnership, requestReturn);
router.post('/approve-return', approveReturn);
router.post('/execute-return', enforceStoreOwnership, executeReturn);
router.post('/inbound', enforceStoreOwnership, inbound);
router.post('/outbound', enforceStoreOwnership, outbound);
router.post('/transfer', enforceStoreOwnership, transfer);
router.get('/transfer-list', getTransferList);
router.get('/transfer/:transferId', getTransferDetail);
router.post('/transfer/confirm-out', enforceStoreOwnership, confirmTransferOut);
router.post('/transfer/confirm-in', enforceStoreOwnership, confirmTransferIn);
router.post('/transfer/revoke', enforceStoreOwnership, revokeTransfer);
router.post('/transfer/reject', enforceStoreOwnership, rejectTransfer);
router.get('/conversion-list', getConversionList);
router.get('/conversion/:conversionId', getConversionDetail);
router.post('/conversion', enforceStoreOwnership, createConversion);
router.post('/conversion/:conversionId/void', enforceStoreOwnership, voidConversion);
router.get('/locations/:storeId', getLocationsByStore);

module.exports = router;
