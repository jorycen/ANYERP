/**
 * 报表管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const { getSalesReport, getInventoryReport, getEmployeePerformanceReport } = require('./controller');
const {
  createProfitAdjustment,
  listProfitAdjustments,
  approveProfitAdjustment,
  rejectProfitAdjustment,
  downloadProfitAdjustmentAttachment
} = require('./profitAdjustmentController');

const router = new Router();
const upload = multer({
  limits: { files: 5, fileSize: 10 * 1024 * 1024 }
});

router.get('/sales', getSalesReport);
router.get('/inventory', getInventoryReport);
router.get('/employee-performance', getEmployeePerformanceReport);
router.get('/profit-adjustments', listProfitAdjustments);
router.post('/profit-adjustments', upload.array('files', 5), createProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/approve', approveProfitAdjustment);
router.post('/profit-adjustments/:adjustmentId/reject', rejectProfitAdjustment);
router.get('/profit-adjustment-attachments/:attachmentId/download', downloadProfitAdjustmentAttachment);

module.exports = router;
