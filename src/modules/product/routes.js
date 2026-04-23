/**
 * 商品管理路由
 */
const Router = require('koa-router');
const { getProductList, createProduct, updateProduct, getPnList, addPn, getCategory } = require('./controller');

const router = new Router();

router.get('/', getProductList);
router.post('/', createProduct);
router.put('/:productId', updateProduct);
router.get('/pn', getPnList);
router.post('/pn', addPn);
router.get('/category', getCategory);

module.exports = router;
