const test = require('node:test');
const assert = require('node:assert/strict');
const financeRouter = require('../src/modules/finance/routes');
const financeController = require('../src/modules/finance/controller');

test('日结筛选国补 POS 主名称时兼容客户实收明细', () => {
  const condition = financeController.buildDailyPaymentMethodWhere('国补POS（电脑）');

  assert.deepEqual(condition, {
    [require('sequelize').Op.or]: ['国补POS（电脑）', '国补POS（电脑）-客户实收']
  });
  assert.equal(financeController.buildDailyPaymentMethodWhere('现金'), '现金');
  assert.equal(financeController.buildDailyPaymentMethodWhere('国补POS（电脑）-客户实收'), '国补POS（电脑）-客户实收');
});

test('费用单草稿提供保存、编辑、提交和删除接口', () => {
  const saveRoute = financeRouter.stack.find(layer => layer.path === '/expense-draft' && layer.methods.includes('POST'));
  const updateRoute = financeRouter.stack.find(layer => layer.path === '/expense-draft/:id' && layer.methods.includes('PUT'));
  const submitRoute = financeRouter.stack.find(layer => layer.path === '/expense-draft/:id/submit' && layer.methods.includes('PUT'));
  const deleteRoute = financeRouter.stack.find(layer => layer.path === '/expense-draft/:id' && layer.methods.includes('DELETE'));

  assert.ok(saveRoute);
  assert.ok(updateRoute);
  assert.ok(submitRoute);
  assert.ok(deleteRoute);
  assert.equal(typeof financeController.saveExpenseDraft, 'function');
  assert.equal(typeof financeController.updateExpenseDraft, 'function');
  assert.equal(typeof financeController.deleteExpenseDraft, 'function');
});
