/**
 * 报表管理路由
 */
const Router = require('koa-router');
const { getSalesReport, getInventoryReport } = require('./controller');

const router = new Router();

router.get('/sales', getSalesReport);
router.get('/inventory', getInventoryReport);

module.exports = router;
