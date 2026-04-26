/**
 * 门店管理路由
 */
const Router = require('koa-router');
const { getStoreList, createStore, updateStore } = require('./controller');

const router = new Router();

router.get('/', getStoreList);
router.post('/create', createStore);
router.put('/update/:id', updateStore);

module.exports = router;
