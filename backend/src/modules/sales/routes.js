/**
 * 销售管理路由
 */
const Router = require('koa-router');
const {
  list,
  create,
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
  updateSupplements
} = require('./controller');
const { enforceStoreOwnership } = require('../../middleware/permission');

const router = new Router();

function normalizeDepositId(ctx, next) {
  ctx.params.depositId = ctx.params.depositId
    || ctx.request.body?.depositId
    || ctx.request.body?.deposit_id
    || ctx.query?.depositId
    || ctx.query?.deposit_id;
  return next();
}

router.get('/list', list);
router.get('/stats', stats);
router.get('/auxiliary-staff', auxiliaryStaff);
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
router.put('/order-items', enforceStoreOwnership, updateOrderItems);
router.post('/order-items', enforceStoreOwnership, updateOrderItems);
router.get('/:orderId/gross-profit', getGrossProfit);
router.put('/:orderId/supplements', enforceStoreOwnership, updateSupplements);
router.get('/:orderId', detail);
router.put('/:orderId', enforceStoreOwnership, update);
router.post('/:orderId/approve', approve);
router.post('/:orderId/reject', reject);
router.post('/:orderId/recalculate-settlement-cost', recalculateSettlementCost);

module.exports = router;
