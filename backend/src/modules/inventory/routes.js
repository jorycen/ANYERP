/**
 * 库房管理路由
 */
const Router = require('koa-router');
const { getList, getSnList, getInboundList, getInboundDetail, executeInbound, executeReturn, inbound, outbound, transfer, getTransferList, confirmTransferOut, confirmTransferIn, getLocationsByStore, updateSn, snTrace } = require('./controller');
const { enforceStoreOwnership } = require('../../middleware/permission');

const router = new Router();

router.get('/list', getList);
router.get('/sn-list', getSnList);
router.put('/sn/:snId', updateSn);
router.get('/sn-trace/:snCode', snTrace);
router.get('/inbound-list', getInboundList);
router.get('/inbound-detail/:inboundId', getInboundDetail);
router.post('/execute-inbound', enforceStoreOwnership, executeInbound);
router.post('/execute-return', enforceStoreOwnership, executeReturn);
router.post('/inbound', enforceStoreOwnership, inbound);
router.post('/outbound', enforceStoreOwnership, outbound);
router.post('/transfer', enforceStoreOwnership, transfer);
router.get('/transfer-list', getTransferList);
router.post('/transfer/confirm-out', enforceStoreOwnership, confirmTransferOut);
router.post('/transfer/confirm-in', enforceStoreOwnership, confirmTransferIn);
router.get('/locations/:storeId', getLocationsByStore);

module.exports = router;
