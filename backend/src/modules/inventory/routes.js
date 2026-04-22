/**
 * 库房管理路由
 */
const Router = require('koa-router');
const { getSnList, inbound, outbound, transfer } = require('./controller');

const router = new Router();

router.get('/sn', getSnList);
router.post('/inbound', inbound);
router.post('/outbound', outbound);
router.post('/transfer', transfer);

module.exports = router;
