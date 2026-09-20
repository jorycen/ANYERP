const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const {
  arePurchaseInboundsCompleted,
  createPurchaseReimbursementAfterInbound
} = require('../src/modules/finance/expenseService');

test('个人垫付采购只有全部关联入库单完成后才进入报销', () => {
  assert.equal(arePurchaseInboundsCompleted([]), false);
  assert.equal(arePurchaseInboundsCompleted([{ status: 'completed' }, { status: 'pending' }]), false);
  assert.equal(arePurchaseInboundsCompleted([{ status: 'completed' }, { status: 'returned' }]), true);
});

test('暂缓或部分入库不创建个人垫付报销', async () => {
  const originals = {
    inboundFindAll: models.Inbound.findAll,
    expenseFindOne: models.Expense.findOne
  };
  let expenseLookupCount = 0;
  models.Inbound.findAll = async () => [{ inbound_id: 'IN_1', status: 'pending' }];
  models.Expense.findOne = async () => {
    expenseLookupCount += 1;
    return null;
  };

  try {
    const result = await createPurchaseReimbursementAfterInbound({
      request_id: 'REQ_1',
      payment_method: 'PERSONAL_ADVANCE'
    }, { staffId: 'WAREHOUSE' });
    assert.equal(result, null);
    assert.equal(expenseLookupCount, 0);
  } finally {
    models.Inbound.findAll = originals.inboundFindAll;
    models.Expense.findOne = originals.expenseFindOne;
  }
});

test('最后一张入库单完成后按采购发起人创建一次报销', async () => {
  const originals = {
    inboundFindAll: models.Inbound.findAll,
    expenseFindOne: models.Expense.findOne,
    expenseCreate: models.Expense.create,
    adjustmentSum: models.PurchaseAdjustment.sum,
    supplierFindByPk: models.Supplier.findByPk
  };
  let created = null;
  models.Inbound.findAll = async () => [
    { inbound_id: 'IN_1', status: 'completed' },
    { inbound_id: 'IN_2', status: 'completed' }
  ];
  models.Expense.findOne = async () => null;
  models.Expense.create = async values => {
    created = values;
    return values;
  };
  models.PurchaseAdjustment.sum = async () => -100;
  models.Supplier.findByPk = async () => ({ name: '测试供应商' });

  try {
    const result = await createPurchaseReimbursementAfterInbound({
      request_id: 'REQ_1',
      request_no: 'PR001',
      supplier_id: 'SUP_1',
      store_id: 'STORE_1',
      distributor_id: 'DIST_1',
      payment_method: 'PERSONAL_ADVANCE',
      invoice_type: '专票',
      actual_total: 1000,
      applicant_staff_id: 'PURCHASER_1',
      apply_user: '采购发起人'
    }, { staffId: 'WAREHOUSE_1', name: '入库操作人' });

    assert.equal(result, created);
    assert.equal(created.amount, 900);
    assert.equal(created.applicant_staff_id, 'PURCHASER_1');
    assert.equal(created.applicant_name, '采购发起人');
    assert.equal(created.expense_party, '测试供应商');
    assert.equal(created.source_id, 'REQ_1');
    assert.equal(created.status, 'pending_approval');
  } finally {
    models.Inbound.findAll = originals.inboundFindAll;
    models.Expense.findOne = originals.expenseFindOne;
    models.Expense.create = originals.expenseCreate;
    models.PurchaseAdjustment.sum = originals.adjustmentSum;
    models.Supplier.findByPk = originals.supplierFindByPk;
  }
});

