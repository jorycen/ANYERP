/**
 * 报表管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const {
  getSalesReport,
  getCustomerSourceAnalysis,
  getInventoryReport,
  getEmployeePerformanceReport,
  getDashboardFilters,
  getDashboardOverview
} = require('./controller');
const {
  createProfitAdjustment,
  listProfitAdjustments,
  approveProfitAdjustment,
  rejectProfitAdjustment,
  downloadProfitAdjustmentAttachment
} = require('./profitAdjustmentController');
const {
  getFinanceOverview,
  getProductSettlementOrders,
  exportProductSettlementOrders
} = require('./financeOverviewController');
const { getMonthlyTaskAchievement } = require('./monthlyTaskAchievement');
const {
  getFinancialProfitOrders,
  exportFinancialProfitOrders
} = require('./financialProfitController');
const { getSalesStatement } = require('./salesStatementController');
const { requireDistributorAccount } = require('../../middleware/permission');

const router = new Router();
const productCostSupplement = require('./productCostSupplement');
const financialProfitControl = require('./financialProfitControl');
const upload = multer({
  limits: { files: 5, fileSize: 10 * 1024 * 1024 }
});

router.get('/sales', getSalesReport);
router.get('/sales-statement', getSalesStatement);
router.get('/customer-source-analysis', getCustomerSourceAnalysis);
router.get('/inventory', getInventoryReport);
router.get('/employee-performance', ctx => getEmployeePerformanceReport(ctx, false));
router.get('/employee-performance/export', ctx => getEmployeePerformanceReport(ctx, true));
router.get('/dashboard/filters', getDashboardFilters);
router.get('/dashboard/overview', getDashboardOverview);
router.get('/operating-profit', require('./operatingProfit').getOperatingProfit);
router.get('/finance-overview', requireDistributorAccount(), getFinanceOverview);
router.get('/product-settlement-orders/export', requireDistributorAccount(), exportProductSettlementOrders);
router.get('/product-settlement-orders', requireDistributorAccount(), getProductSettlementOrders);
router.post('/product-settlement-orders/:settlementId/cost-preview', requireDistributorAccount(), productCostSupplement.preview);
router.post('/product-settlement-orders/:settlementId/cost-supplement', requireDistributorAccount(), productCostSupplement.apply);
router.get('/product-settlement-orders/:settlementId/cost-history', requireDistributorAccount(), productCostSupplement.history);
router.get('/financial-profit-orders/export', requireDistributorAccount(), exportFinancialProfitOrders);
router.get('/financial-profit-orders', requireDistributorAccount(), getFinancialProfitOrders);
router.get('/financial-profit-history', requireDistributorAccount(), financialProfitControl.history);
router.post('/financial-profit-review', requireDistributorAccount(), financialProfitControl.review);
router.post('/financial-profit-close-preview', requireDistributorAccount(), financialProfitControl.previewClose);
router.post('/financial-profit-close', requireDistributorAccount(), financialProfitControl.close);
router.post('/financial-profit-adjustments', requireDistributorAccount(), financialProfitControl.adjust);
router.get('/monthly-task-achievement', getMonthlyTaskAchievement);
router.get('/profit-adjustments', listProfitAdjustments);
router.post('/profit-adjustments', upload.array('files', 5), createProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/approve', approveProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/reject', rejectProfitAdjustment);
router.get('/profit-adjustment-attachments/:attachmentId/download', downloadProfitAdjustmentAttachment);

module.exports = router;
