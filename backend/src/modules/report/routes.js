/**
 * 报表管理路由
 */
const Router = require('koa-router');
const { getSalesReport, getInventoryReport, getEmployeePerformanceReport } = require('./controller');

const router = new Router();

router.get('/sales', getSalesReport);
router.get('/inventory', getInventoryReport);
router.get('/employee-performance', getEmployeePerformanceReport);

module.exports = router;
