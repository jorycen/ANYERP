/**
 * 门店管理路由
 */
const Router = require('koa-router');
const { getStoreList, createStore, updateStore, deleteStore, getRegionList, getAllStores } = require('./controller');

const router = new Router();

router.get('/list', getStoreList);
router.get('/all', getAllStores);
router.post('/create', createStore);
router.put('/update/:id', updateStore);
router.delete('/delete/:id', deleteStore);
router.get('/regions', getRegionList);

module.exports = router;
