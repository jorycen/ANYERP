/**
 * 销售管理路由
 */
const Router = require('koa-router');
const { list, create, detail, update, updateOrderItems, stats, approve, reject, paymentMethods, getProductPns, getProductSns } = require('./controller');
const { enforceStoreOwnership } = require('../../middleware/permission');

const router = new Router();

router.get('/list', list);
router.get('/stats', stats);
router.get('/payment-methods', paymentMethods);
router.get('/product-pns/:storeId/:productId', getProductPns);
router.get('/product-sns/:storeId/:productId', getProductSns);
router.post('/create', enforceStoreOwnership, create);
router.put('/order-items', enforceStoreOwnership, updateOrderItems);
router.post('/order-items', enforceStoreOwnership, updateOrderItems);
router.get('/:orderId', detail);
router.put('/:orderId', enforceStoreOwnership, update);
router.post('/:orderId/approve', approve);
router.post('/:orderId/reject', reject);

module.exports = router;
