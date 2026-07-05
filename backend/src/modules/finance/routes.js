/**
 * 财务管理路由
 */
const Router = require('koa-router');
const {
  getDailyDetails, getNationalSubsidyReceivables, getDailyStatement, getDailyStatementDetail,
  batchSettle, settleNationalSubsidyReceivables, getSettlementSummary, createExpense, getExpenseList,
  submitExpense, payExpense, getSettlementAccountsWithBalance, getAccountTransactions, addAccountTransaction,
  getSubsidyAccountRoutes, saveSubsidyAccountRoute, createSubsidyReceipt, getSubsidyReceipts,
  allocateSubsidyReceipt, refundSubsidyReceipt, reverseSubsidyReceipt, submitSubsidyAdjustment,
  getSubsidyAdjustments, reviewSubsidyAdjustment, reverseSubsidyAdjustment
} = require('./controller');
const {
  getPayableList,
  getUnpaidBySupplier,
  createSettlement,
  getSettlementList,
  getSettlementDetail,
  submitSettlement,
  confirmSettlement,
  voidSettlement,
  getPaymentCandidates,
  exportPaymentCandidates,
  validatePaymentImport,
  commitPaymentImport,
  createDirectPayment,
  getPaymentBatches,
  getPaymentBatchDetail,
  voidPaymentBatch,
  confirmPayment,
  cancelPayment
} = require('./payableController');
const {
  addRebate,
  getRebateList,
  getRebateBalance,
  getRebateSummary,
  reverseRebate,
  createManufacturerPolicy,
  updateManufacturerPolicy,
  getManufacturerPolicyList,
  importManufacturerPrices,
  getManufacturerPriceHistory,
  getRebateEstimateList,
  getCostAdjustmentList
} = require('./rebateController');
const { requireRole } = require('../../middleware/permission');

const router = new Router();

router.use(requireRole('finance'));

router.get('/daily-details', getDailyDetails);
router.get('/national-subsidy-receivables', getNationalSubsidyReceivables);
router.get('/national-subsidy-account-routes', getSubsidyAccountRoutes);
router.put('/national-subsidy-account-routes', saveSubsidyAccountRoute);
router.get('/national-subsidy-receipts', getSubsidyReceipts);
router.post('/national-subsidy-receipts', createSubsidyReceipt);
router.post('/national-subsidy-receipts/:id/allocate', allocateSubsidyReceipt);
router.post('/national-subsidy-receipts/:id/refund', refundSubsidyReceipt);
router.post('/national-subsidy-receipts/:id/reverse', reverseSubsidyReceipt);
router.get('/national-subsidy-adjustments', getSubsidyAdjustments);
router.post('/national-subsidy-adjustments', submitSubsidyAdjustment);
router.post('/national-subsidy-adjustments/:id/review', reviewSubsidyAdjustment);
router.post('/national-subsidy-adjustments/:id/reverse', reverseSubsidyAdjustment);
router.get('/daily-statement', getDailyStatement);
router.get('/daily-statement/:id', getDailyStatementDetail);
router.get('/settlement-summary', getSettlementSummary);
router.post('/batch-settle', batchSettle);
router.post('/national-subsidy-receivables/settle', settleNationalSubsidyReceivables);
router.post('/expense', createExpense);
router.get('/expense-list', getExpenseList);
router.put('/expense/submit/:id', submitExpense);
router.put('/expense/pay/:id', payExpense);

router.get('/payable-list', getPayableList);
router.get('/unpaid-by-supplier', getUnpaidBySupplier);
router.post('/create-settlement', createSettlement);
router.get('/settlement-list', getSettlementList);
router.get('/settlement/:id', getSettlementDetail);
router.post('/settlement/submit', submitSettlement);
router.post('/settlement/confirm', confirmSettlement);
router.post('/settlement/void', voidSettlement);
router.get('/settlement-payment/candidates', getPaymentCandidates);
router.get('/settlement-payment/export', exportPaymentCandidates);
router.post('/settlement-payment/import/validate', validatePaymentImport);
router.post('/settlement-payment/import/commit', commitPaymentImport);
router.post('/settlement-payment/direct', createDirectPayment);
router.get('/settlement-payment/batches', getPaymentBatches);
router.get('/settlement-payment/batch/:id', getPaymentBatchDetail);
router.post('/settlement-payment/batch/void', voidPaymentBatch);
router.post('/confirm-payment', confirmPayment);
router.post('/cancel-payment', cancelPayment);

router.post('/add-rebate', addRebate);
router.get('/rebate-list', getRebateList);
router.get('/rebate-balance', getRebateBalance);
router.get('/rebate-summary', getRebateSummary);
router.post('/rebate/:rebateId/reverse', reverseRebate);
router.post('/manufacturer-policy', createManufacturerPolicy);
router.put('/manufacturer-policy/:policyId', updateManufacturerPolicy);
router.get('/manufacturer-policy-list', getManufacturerPolicyList);
router.post('/manufacturer-price/import', importManufacturerPrices);
router.get('/manufacturer-price-history', getManufacturerPriceHistory);
router.get('/rebate-estimate-list', getRebateEstimateList);
router.get('/sales-cost-adjustment-list', getCostAdjustmentList);

router.get('/settlement-accounts/balance', getSettlementAccountsWithBalance);
router.get('/settlement-account/:accountId/transactions', getAccountTransactions);
router.post('/settlement-account/transaction', addAccountTransaction);

module.exports = router;
