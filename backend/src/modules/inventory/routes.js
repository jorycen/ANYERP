/**
 * 库房管理路由
 */
const Router = require('koa-router');
const { getList, getSnList, getInboundList, getInboundDetail, executeInbound, getReturnList, requestReturn, approveReturn, executeReturn, inbound, outbound, transfer, getTransferList, confirmTransferOut, confirmTransferIn, getConversionList, getConversionDetail, createConversion, voidConversion, getLocationsByStore, updateSn, snTrace } = require('./controller');
const { enforceStoreOwnership } = require('../../middleware/permission');
const resourceRights = require('./resourceRights');

const router = new Router();

router.get('/list', getList);
router.get('/sn-list', getSnList);
router.put('/sn/:snId', updateSn);
router.get('/sn-trace/:snCode', snTrace);
router.get('/resource-rights', resourceRights.listRights);
router.get('/resource-rights/changes', resourceRights.listChanges);
router.get('/resource-rights/cost-configs', resourceRights.listCostConfigs);
router.get('/resource-rights/cost-adjustments', resourceRights.listCostAdjustments);
router.post('/resource-rights/cost-configs', resourceRights.saveCostConfig);
router.post('/resource-rights/batch-adjust', resourceRights.batchAdjustRights);
router.post('/resource-rights/batch-refresh', resourceRights.batchRefreshRights);
router.get('/resource-categories', resourceRights.listResourceCategories);
router.post('/resource-categories', resourceRights.saveResourceCategory);
router.get('/resource-settlements', resourceRights.listResourceSettlements);
router.post('/resource-settlements/:settlementId/settle', resourceRights.settleResource);
router.post('/resource-rights/claim', resourceRights.submitClaim);
router.post('/resource-rights/claim/:changeId/review', resourceRights.reviewClaim);
router.get('/sn/:snId/resource-rights', resourceRights.snRights);
router.put('/sn/:snId/resource-rights', resourceRights.saveSnRights);
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
router.post('/transfer/confirm-out', enforceStoreOwnership, confirmTransferOut);
router.post('/transfer/confirm-in', enforceStoreOwnership, confirmTransferIn);
router.get('/conversion-list', getConversionList);
router.get('/conversion/:conversionId', getConversionDetail);
router.post('/conversion', enforceStoreOwnership, createConversion);
router.post('/conversion/:conversionId/void', enforceStoreOwnership, voidConversion);
router.get('/locations/:storeId', getLocationsByStore);

module.exports = router;
