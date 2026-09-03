/**
 * 财务管理路由
 */
const Router = require('koa-router');
const {
  getPlatforms,
  createPlatform,
  updatePlatform,
  deletePlatform,
  getRecords: getFreightRecords,
  exportRecords: exportFreightRecords
} = require('./freightController');
const {
  getDailyDetails, getNationalSubsidyReceivables, exportDailyDetails, exportNationalSubsidyReceivables, getDailyStatement, getDailyStatementDetail,
  batchSettle, settleNationalSubsidyReceivables, getSettlementSummary, createExpense, saveExpenseDraft, updateExpenseDraft, deleteExpenseDraft, getExpenseList, exportExpenseList, getExpenseDetail,
  submitExpense, payExpense, reviewExpense, cancelExpense, getSettlementAccountsWithBalance, getAccountTransactions, addAccountTransaction,
  getSubsidyAccountRoutes, saveSubsidyAccountRoute, createSubsidyReceipt, getSubsidyReceipts,
  allocateSubsidyReceipt, refundSubsidyReceipt, reverseSubsidyReceipt, submitSubsidyAdjustment,
  getSubsidyAdjustments, reviewSubsidyAdjustment, reverseSubsidyAdjustment
} = require('./controller');
const {
  getPayableList, exportPayableList,
  getUnpaidBySupplier,
  getPayableSettlementItems,
  createSettlement,
  createExpenseSettlement,
  getSettlementList, exportSettlementList,
  getSettlementDetail,
  updateSettlementRemark,
  deleteSettlementDraft,
  submitSettlement,
  confirmSettlement,
  rejectSettlement,
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
  getRebatePostingOrders,
  reverseRebatePostingOrder,
  createManufacturerPolicy,
  updateManufacturerPolicy,
  getManufacturerPolicyList,
  importManufacturerPrices,
  getManufacturerPriceHistory,
  getRebateEstimateList,
  getCostAdjustmentList
} = require('./rebateController');
const { requireRole } = require('../../middleware/permission');
const {
  listExpensePerformanceAllocations,
  listExpensePerformanceStaffOptions,
  createExpensePerformanceAllocations,
  reviewExpensePerformanceAllocation,
  listExpenseAccountingPeriods,
  closeExpenseAccountingPeriod,
  reopenExpenseAccountingPeriod
} = require('./expenseAccountingController');

const router = new Router();

// 员工费用入口：创建及查看本人/授权门店费用不要求财务角色。
router.post('/expense', createExpense);
router.post('/expense-draft', saveExpenseDraft);
router.put('/expense-draft/:id', updateExpenseDraft);
router.delete('/expense-draft/:id', deleteExpenseDraft);
router.put('/expense-draft/:id/submit', submitExpense);
router.get('/expense-list', getExpenseList);
router.get('/expense-list/export', exportExpenseList);
router.get('/expense/:id', getExpenseDetail);
router.post('/expense/:id/review', requireRole('admin'), reviewExpense);
router.post('/expense/:id/cancel', cancelExpense);
router.get('/expense/:id/performance-allocations', requireRole('finance'), listExpensePerformanceAllocations);
router.get('/expense/:id/performance-staff-options', requireRole('finance'), listExpensePerformanceStaffOptions);
router.post('/expense/:id/performance-allocations', requireRole('finance'), createExpensePerformanceAllocations);

// 采购及调拨录单需要读取启用中的配送平台，配置和记录维护仍受财务角色保护。
router.get('/freight/platforms', getPlatforms);

router.use(requireRole('finance'));

router.get('/expense-performance-allocations', listExpensePerformanceAllocations);
router.post('/expense-performance-allocations/:allocationId/review', reviewExpensePerformanceAllocation);
router.get('/expense-accounting-periods', listExpenseAccountingPeriods);
router.post('/expense-accounting-periods/:monthKey/close', closeExpenseAccountingPeriod);
router.post('/expense-accounting-periods/:monthKey/reopen', reopenExpenseAccountingPeriod);

// 运费管理
router.post('/freight/platforms', createPlatform);
router.put('/freight/platforms/:id', updatePlatform);
router.delete('/freight/platforms/:id', deletePlatform);
router.get('/freight/records', getFreightRecords);
router.get('/freight/records/export', exportFreightRecords);

router.get('/daily-details', getDailyDetails);
router.get('/daily-details/export', exportDailyDetails);
router.get('/national-subsidy-receivables', getNationalSubsidyReceivables);
router.get('/national-subsidy-receivables/export', exportNationalSubsidyReceivables);
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
router.put('/expense/submit/:id', submitExpense);
router.put('/expense/pay/:id', payExpense);

router.get('/payable-list', getPayableList);
router.get('/payable-list/export', exportPayableList);
router.get('/payable-settlement-items', getPayableSettlementItems);
router.get('/unpaid-by-supplier', getUnpaidBySupplier);
router.post('/create-settlement', createSettlement);
router.post('/create-expense-settlement', createExpenseSettlement);
router.get('/settlement-list', getSettlementList);
router.get('/settlement-list/export', exportSettlementList);
router.get('/settlement/:id', getSettlementDetail);
router.put('/settlement/:id/remark', updateSettlementRemark);
router.delete('/settlement/:id', deleteSettlementDraft);
router.post('/settlement/submit', submitSettlement);
router.post('/settlement/confirm', confirmSettlement);
router.post('/settlement/reject', rejectSettlement);
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
router.get('/rebate-posting-orders', getRebatePostingOrders);
router.post('/rebate-posting-orders/:postingId/reverse', reverseRebatePostingOrder);
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
