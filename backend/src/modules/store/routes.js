/**
 * 门店管理路由
 */
const Router = require('koa-router');
const { getStoreList } = require('./controller');

const router = new Router();

router.get('/', getStoreList);

module.exports = router;
