/**
 * 库房管理路由
 */
const Router = require('koa-router');
const { getList, getSnList, getInboundList, getInboundDetail, executeInbound, getReturnList, requestReturn, approveReturn, executeReturn, inbound, outbound, transfer, getTransferList, confirmTransferOut, confirmTransferIn, getConversionList, getConversionDetail, createConversion, voidConversion, getLocationsByStore, updateSn, snTrace } = require('./controller');
const { enforceStoreOwnership } = require('../../middleware/permission');

const router = new Router();

router.get('/list', getList);
router.get('/sn-list', getSnList);
router.put('/sn/:snId', updateSn);
router.get('/sn-trace/:snCode', snTrace);
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
