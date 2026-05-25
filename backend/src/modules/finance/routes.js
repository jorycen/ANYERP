/**
 * 财务管理路由
 */
const Router = require('koa-router');
const { getDailyDetails, getDailyStatement, getDailyStatementDetail, batchSettle, getSettlementSummary, createExpense, getExpenseList, submitExpense, payExpense, getSettlementAccountsWithBalance, getAccountTransactions, addAccountTransaction } = require('./controller');
const { getPayableList, getUnpaidBySupplier, createSettlement, getSettlementList, confirmPayment } = require('./payableController');
const { addRebate, getRebateList, getRebateBalance } = require('./rebateController');
const { requireRole } = require('../../middleware/permission');

const router = new Router();

router.use(requireRole('finance'));

router.get('/daily-details', getDailyDetails);
router.get('/daily-statement', getDailyStatement);
router.get('/daily-statement/:id', getDailyStatementDetail);
router.get('/settlement-summary', getSettlementSummary);
router.post('/batch-settle', batchSettle);
router.post('/expense', createExpense);
router.get('/expense-list', getExpenseList);
router.put('/expense/submit/:id', submitExpense);
router.put('/expense/pay/:id', payExpense);

router.get('/payable-list', getPayableList);
router.get('/unpaid-by-supplier', getUnpaidBySupplier);
router.post('/create-settlement', createSettlement);
router.get('/settlement-list', getSettlementList);
router.post('/confirm-payment', confirmPayment);

router.post('/add-rebate', addRebate);
router.get('/rebate-list', getRebateList);
router.get('/rebate-balance', getRebateBalance);

router.get('/settlement-accounts/balance', getSettlementAccountsWithBalance);
router.get('/settlement-account/:accountId/transactions', getAccountTransactions);
router.post('/settlement-account/transaction', addAccountTransaction);

module.exports = router;
