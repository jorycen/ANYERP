const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const dictController = require('../src/modules/dict/controller');
const financeController = require('../src/modules/finance/controller');

function context({ body = {}, query = {}, params = {} } = {}) {
  return {
    request: { body },
    query,
    params,
    state: { user: { staffId: 101, name: '财务测试员', roles: ['finance'] } },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

test('用户可以手工创建返利账户并绑定唯一供应商', async () => {
  const originals = {
    supplierFindOne: models.Supplier.findOne,
    accountFindOne: models.SettlementAccount.findOne,
    accountCreate: models.SettlementAccount.create,
    transaction: models.sequelize.transaction
  };
  let created;
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', name: '测试供应商', status: 1, is_deleted: 0 });
  models.SettlementAccount.findOne = async () => null;
  models.SettlementAccount.create = async values => { created = values; return values; };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  const ctx = context({
    body: {
      accountName: '测试供应商返利账户',
      accountType: 'SUPPLIER_REBATE',
      supplierId: 'SUP_1',
      openingAmount: 0
    }
  });
  try {
    await dictController.createSettlementAccount(ctx);
    assert.equal(created.account_type, 'SUPPLIER_REBATE');
    assert.equal(created.supplier_id, 'SUP_1');
  } finally {
    models.Supplier.findOne = originals.supplierFindOne;
    models.SettlementAccount.findOne = originals.accountFindOne;
    models.SettlementAccount.create = originals.accountCreate;
    models.sequelize.transaction = originals.transaction;
  }
});

test('手工创建返利账户的新增金额进入返利池并生成返利收款待下账单', async () => {
  const originals = {
    supplierFindOne: models.Supplier.findOne,
    accountFindOne: models.SettlementAccount.findOne,
    accountCreate: models.SettlementAccount.create,
    rebateFindOne: models.SupplierRebate.findOne,
    rebateCreate: models.SupplierRebate.create,
    postingCreate: models.RebatePostingOrder.create,
    transactionCreate: models.SettlementAccountTransaction.create,
    settlementCreate: models.ResourceSettlement.create,
    transaction: models.sequelize.transaction
  };
  const created = { account: null, rebate: null, posting: null, transaction: null, settlement: null };
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', name: '测试供应商', status: 1, is_deleted: 0 });
  models.SettlementAccount.findOne = async () => null;
  models.SettlementAccount.create = async values => { created.account = values; return values; };
  models.SupplierRebate.findOne = async () => ({ balance: 100 });
  models.SupplierRebate.create = async values => { created.rebate = values; return values; };
  models.RebatePostingOrder.create = async values => { created.posting = values; return values; };
  models.SettlementAccountTransaction.create = async values => { created.transaction = values; return values; };
  models.ResourceSettlement.create = async values => { created.settlement = values; return values; };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  try {
    await dictController.createSettlementAccount(context({
      body: {
        accountName: '测试返利账户', accountType: 'SUPPLIER_REBATE', supplierId: 'SUP_1', openingAmount: 300
      }
    }));
    assert.equal(created.account.supplier_id, 'SUP_1');
    assert.equal(created.rebate.amount, 300);
    assert.equal(created.rebate.balance, 400);
    assert.equal(created.posting.amount, 300);
    assert.equal(created.posting.source_type, 'ACCOUNT_OPENING');
    assert.equal(created.transaction.type, 'income');
    assert.equal(created.transaction.amount, 300);
    assert.equal(created.settlement.source_type, 'REBATE_RECEIPT');
    assert.equal(created.settlement.resource_type, 'MANUAL_REBATE');
    assert.equal(created.settlement.status, 'PENDING');
  } finally {
    models.Supplier.findOne = originals.supplierFindOne;
    models.SettlementAccount.findOne = originals.accountFindOne;
    models.SettlementAccount.create = originals.accountCreate;
    models.SupplierRebate.findOne = originals.rebateFindOne;
    models.SupplierRebate.create = originals.rebateCreate;
    models.RebatePostingOrder.create = originals.postingCreate;
    models.SettlementAccountTransaction.create = originals.transactionCreate;
    models.ResourceSettlement.create = originals.settlementCreate;
    models.sequelize.transaction = originals.transaction;
  }
});

test('收款方式只能绑定资金账户并排除Care可用金', async () => {
  const original = models.SettlementAccount.findAll;
  models.SettlementAccount.findAll = async () => [{
    account_id: 'ACC_CARE',
    account_type: 'CARE_CREDIT'
  }];
  try {
    const ctx = context({
      body: {
        name: '测试收款方式',
        isGlobal: true,
        settlementAccountId: 'ACC_CARE',
        defaultTaxRate: 0
      }
    });
    await assert.rejects(
      dictController.createPaymentMethod(ctx),
      error => error.status === 400 && error.message.includes('只能绑定启用的资金账户')
    );
  } finally {
    models.SettlementAccount.findAll = original;
  }
});

test('用户结算账号接口包含供应商返利账户', async () => {
  const original = models.SettlementAccount.findAll;
  let capturedWhere;
  models.SettlementAccount.findAll = async options => {
    capturedWhere = options.where;
    return [];
  };
  try {
    const ctx = context();
    await dictController.getAllSettlementAccounts(ctx);
    assert.equal(capturedWhere.account_type, undefined);
  } finally {
    models.SettlementAccount.findAll = original;
  }
});

test('账户中心在数据库查询层包含供应商返利账户', async () => {
  const original = models.SettlementAccount.findAndCountAll;
  let capturedWhere;
  models.SettlementAccount.findAndCountAll = async options => {
    capturedWhere = options.where;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = context({ query: { page: 1, pageSize: 20 } });
    await financeController.getSettlementAccountsWithBalance(ctx);
    assert.equal(capturedWhere.status, 1);
    assert.equal(capturedWhere.account_type, undefined);
  } finally {
    models.SettlementAccount.findAndCountAll = original;
  }
});

test('账户中心允许将账户修改为厂商返利并关联厂商', async () => {
  const originalFindByPk = models.SettlementAccount.findByPk;
  const originalFindOne = models.SettlementAccount.findOne;
  const originalSupplierFindOne = models.Supplier.findOne;
  const updates = [];
  models.SettlementAccount.findByPk = async () => ({
    account_id: 'ACC_1',
    account_type: 'FUND',
    supplier_id: null,
    update: async values => updates.push(values)
  });
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', status: 1, is_deleted: 0 });
  models.SettlementAccount.findOne = async () => null;
  try {
    const ctx = context({
      params: { id: 'ACC_1' },
      body: { accountType: 'SUPPLIER_REBATE', supplierId: 'SUP_1' }
    });
    await dictController.updateSettlementAccount(ctx);
    assert.deepEqual(updates, [{ account_type: 'SUPPLIER_REBATE', supplier_id: 'SUP_1' }]);
  } finally {
    models.SettlementAccount.findByPk = originalFindByPk;
    models.SettlementAccount.findOne = originalFindOne;
    models.Supplier.findOne = originalSupplierFindOne;
  }
});
