/**
 * 财务管理路由
 */
const Router = require('koa-router');
const { getDailyStatement, createExpense, getExpenseList } = require('./controller');

const router = new Router();

router.get('/daily', getDailyStatement);
router.post('/expense', createExpense);
router.get('/expense', getExpenseList);

module.exports = router;
