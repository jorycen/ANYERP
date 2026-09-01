/**
 * 报表管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const {
  getSalesReport,
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
const { requireDistributorAccount } = require('../../middleware/permission');

const router = new Router();
const upload = multer({
  limits: { files: 5, fileSize: 10 * 1024 * 1024 }
});

router.get('/sales', getSalesReport);
router.get('/inventory', getInventoryReport);
router.get('/employee-performance', getEmployeePerformanceReport);
router.get('/dashboard/filters', getDashboardFilters);
router.get('/dashboard/overview', getDashboardOverview);
router.get('/finance-overview', requireDistributorAccount(), getFinanceOverview);
router.get('/product-settlement-orders/export', requireDistributorAccount(), exportProductSettlementOrders);
router.get('/product-settlement-orders', requireDistributorAccount(), getProductSettlementOrders);
router.get('/monthly-task-achievement', getMonthlyTaskAchievement);
router.get('/profit-adjustments', listProfitAdjustments);
router.post('/profit-adjustments', upload.array('files', 5), createProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/approve', approveProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/reject', rejectProfitAdjustment);
router.get('/profit-adjustment-attachments/:attachmentId/download', downloadProfitAdjustmentAttachment);

module.exports = router;
