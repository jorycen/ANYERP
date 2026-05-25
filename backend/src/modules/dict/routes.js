/**
 * 字典管理路由
 */
const Router = require('koa-router');
const {
  getCustomerSourceList, getAllCustomerSources, getCustomerSourceTree, createCustomerSource, updateCustomerSource, deleteCustomerSource, sortCustomerSources,
  getPaymentMethodList, getAllPaymentMethods, getPaymentMethodsByStore, createPaymentMethod, updatePaymentMethod, deletePaymentMethod, sortPaymentMethods,
  getSettlementAccountList, getAllSettlementAccounts, createSettlementAccount, updateSettlementAccount, deleteSettlementAccount, sortSettlementAccounts,
  getSupplementItemList, getAllSupplementItems, createSupplementItem, updateSupplementItem, deleteSupplementItem, sortSupplementItems
} = require('./controller');

const router = new Router();

// 客户来源
router.get('/customer-source/list', getCustomerSourceList);
router.get('/customer-source/all', getAllCustomerSources);
router.get('/customer-source/tree', getCustomerSourceTree);
router.post('/customer-source/create', createCustomerSource);
router.put('/customer-source/update/:id', updateCustomerSource);
router.delete('/customer-source/delete/:id', deleteCustomerSource);
router.post('/customer-source/sort', sortCustomerSources);

// 收款方式
router.get('/payment-method/list', getPaymentMethodList);
router.get('/payment-method/all', getAllPaymentMethods);
router.get('/payment-method/by-store', getPaymentMethodsByStore);
router.post('/payment-method/create', createPaymentMethod);
router.put('/payment-method/update/:id', updatePaymentMethod);
router.delete('/payment-method/delete/:id', deletePaymentMethod);
router.post('/payment-method/sort', sortPaymentMethods);

// 结算账号
router.get('/settlement-account/list', getSettlementAccountList);
router.get('/settlement-account/all', getAllSettlementAccounts);
router.post('/settlement-account/create', createSettlementAccount);
router.put('/settlement-account/update/:id', updateSettlementAccount);
router.delete('/settlement-account/delete/:id', deleteSettlementAccount);
router.post('/settlement-account/sort', sortSettlementAccounts);

// 金额补录项目
router.get('/supplement-item/list', getSupplementItemList);
router.get('/supplement-item/all', getAllSupplementItems);
router.post('/supplement-item/create', createSupplementItem);
router.put('/supplement-item/update/:id', updateSupplementItem);
router.delete('/supplement-item/delete/:id', deleteSupplementItem);
router.post('/supplement-item/sort', sortSupplementItems);

module.exports = router;