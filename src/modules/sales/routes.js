/**
 * 销售管理路由
 */
const Router = require('koa-router');
const { list, create, detail, update, stats } = require('./controller');

const router = new Router();

router.get('/orders', list);
router.post('/orders', create);
router.get('/orders/:orderId', detail);
router.put('/orders/:orderId', update);
router.get('/stats', stats);

module.exports = router;
