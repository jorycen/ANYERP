const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const models = require('../src/models');
const resourceRights = require('../src/modules/inventory/resourceRights');
const rebateController = require('../src/modules/finance/rebateController');

function context({ body = {}, query = {}, params = {}, roles = ['finance'] } = {}) {
  return {
    request: { body },
    query,
    params,
    state: {
      user: {
        staffId: 101,
        name: '财务测试员',
        roles
      }
    },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

test('手工返利新增为不关联SN的待下账记录且不直接写入返利余额', async () => {
  const originals = {
    supplierFindOne: models.Supplier.findOne,
    categoryFindOne: models.ResourceCategory.findOne,
    accountFindOne: models.SettlementAccount.findOne,
    settlementCreate: models.ResourceSettlement.create,
    supplierRebateCreate: models.SupplierRebate.create,
    accountTransactionCreate: models.SettlementAccountTransaction.create
  };
  let created;
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', name: '测试厂商' });
  models.ResourceCategory.findOne = async () => ({ category_code: 'MANUAL_REBATE', status: 1 });
  models.SettlementAccount.findOne = async () => null;
  models.ResourceSettlement.create = async values => {
    created = values;
    return values;
  };
  models.SupplierRebate.create = async () => {
    throw new Error('新增待下账返利时不得写入供应商返利余额');
  };
  models.SettlementAccountTransaction.create = async () => {
    throw new Error('新增待下账返利时不得生成账户流水');
  };

  try {
    const ctx = context({
      body: { supplierId: 'SUP_1', amount: 30000, remark: '暑期活动厂商承诺补贴' }
    });
    await resourceRights.createManualRebateSettlement(ctx);
    assert.equal(created.source_type, 'MANUAL_REBATE');
    assert.equal(created.resource_type, 'MANUAL_REBATE');
    assert.equal(created.sn_id, null);
    assert.equal(created.sn_code, null);
    assert.equal(created.product_id, null);
    assert.equal(created.amount, 30000);
    assert.equal(created.status, 'PENDING');
    assert.equal(created.counterparty_id, 'SUP_1');
    assert.equal(created.remark, '暑期活动厂商承诺补贴');
  } finally {
    models.Supplier.findOne = originals.supplierFindOne;
    models.ResourceCategory.findOne = originals.categoryFindOne;
    models.SettlementAccount.findOne = originals.accountFindOne;
    models.ResourceSettlement.create = originals.settlementCreate;
    models.SupplierRebate.create = originals.supplierRebateCreate;
    models.SettlementAccountTransaction.create = originals.accountTransactionCreate;
  }
});

test('手工返利备注必填', async () => {
  const ctx = context({ body: { supplierId: 'SUP_1', amount: 30000, remark: '   ' } });
  await assert.rejects(
    resourceRights.createManualRebateSettlement(ctx),
    error => error.status === 400 && error.message.includes('必须填写备注')
  );
});

test('返利下账清单支持时间、SN、备注、类型、来源、状态和供应商组合查询', async () => {
  const original = models.ResourceSettlement.findAndCountAll;
  let capturedWhere;
  models.ResourceSettlement.findAndCountAll = async options => {
    capturedWhere = options.where;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = context({
      query: {
        startDate: '2026-07-01',
        endDate: '2026-07-06',
        snCode: 'ABC',
        remark: '暑期活动',
        resourceType: 'MANUAL_REBATE',
        sourceType: 'MANUAL_REBATE',
        status: 'PENDING',
        supplierId: 'SUP_1'
      }
    });
    await resourceRights.listResourceSettlements(ctx);
    assert.equal(capturedWhere.resource_type, 'MANUAL_REBATE');
    assert.equal(capturedWhere.source_type, 'MANUAL_REBATE');
    assert.equal(capturedWhere.status, 'PENDING');
    assert.equal(capturedWhere.counterparty_id, 'SUP_1');
    assert.equal(capturedWhere.sn_code[Op.like], '%ABC%');
    assert.equal(capturedWhere.remark[Op.like], '%暑期活动%');
    assert.ok(capturedWhere.create_time[Op.gte] instanceof Date);
    assert.ok(capturedWhere.create_time[Op.lte] instanceof Date);
  } finally {
    models.ResourceSettlement.findAndCountAll = original;
  }
});

test('返利下账单部分核销上账单且不重复增加返利余额', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    settlementFindByPk: models.ResourceSettlement.findByPk,
    categoryFindOne: models.ResourceCategory.findOne,
    postingFindByPk: models.RebatePostingOrder.findByPk,
    allocationCreate: models.RebateSettlementAllocation.create,
    accountTransactionCreate: models.SettlementAccountTransaction.create,
    supplierRebateCreate: models.SupplierRebate.create
  };
  const settlementUpdates = {};
  const postingUpdates = {};
  const allocations = [];
  const record = {
    settlement_id: 'RST_1',
    settlement_no: 'RST20260706001',
    source_type: 'MANUAL_REBATE',
    source_id: 'SRC_1',
    resource_type: 'MANUAL_REBATE',
    counterparty_id: 'SUP_1',
    counterparty_name: '测试厂商',
    target_account_id: null,
    amount: 30000,
    matched_amount: 0,
    status: 'PENDING',
    update: async values => Object.assign(settlementUpdates, values)
  };
  const posting = {
    posting_id: 'RPO_1',
    posting_no: 'RPO20260706001',
    supplier_id: 'SUP_1',
    amount: 30000,
    matched_amount: 0,
    status: 'UNMATCHED',
    update: async values => Object.assign(postingUpdates, values)
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ResourceSettlement.findByPk = async () => record;
  models.ResourceCategory.findOne = async () => ({ name: '手工返利' });
  models.RebatePostingOrder.findByPk = async () => posting;
  models.RebateSettlementAllocation.create = async values => allocations.push(values);
  models.SettlementAccountTransaction.create = async () => {
    throw new Error('返利下账核销不得重复生成账户流水');
  };
  models.SupplierRebate.create = async () => {
    throw new Error('返利下账核销不得重复增加供应商返利');
  };

  try {
    const ctx = context({
      params: { settlementId: 'RST_1' },
      body: { allocations: [{ postingId: 'RPO_1', amount: 12000 }] }
    });
    await resourceRights.settleResource(ctx);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].amount, 12000);
    assert.equal(postingUpdates.matched_amount, 12000);
    assert.equal(postingUpdates.status, 'PARTIALLY_MATCHED');
    assert.equal(settlementUpdates.matched_amount, 12000);
    assert.equal(settlementUpdates.status, 'PARTIALLY_SETTLED');
    assert.equal(ctx.body.data.matchedAmount, 12000);
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.ResourceSettlement.findByPk = originals.settlementFindByPk;
    models.ResourceCategory.findOne = originals.categoryFindOne;
    models.RebatePostingOrder.findByPk = originals.postingFindByPk;
    models.RebateSettlementAllocation.create = originals.allocationCreate;
    models.SettlementAccountTransaction.create = originals.accountTransactionCreate;
    models.SupplierRebate.create = originals.supplierRebateCreate;
  }
});

test('返利下账支持批量选择并按下账单顺序勾稽同一上账单', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    settlementFindAll: models.ResourceSettlement.findAll,
    postingFindByPk: models.RebatePostingOrder.findByPk,
    allocationCreate: models.RebateSettlementAllocation.create
  };
  const settlementUpdates = {};
  const postingUpdates = {};
  const allocations = [];
  const records = [
    {
      settlement_id: 'RST_1', settlement_no: 'RST20260706001', source_type: 'MANUAL_REBATE',
      counterparty_id: 'SUP_1', counterparty_name: '测试厂商', amount: 10000, matched_amount: 0, status: 'PENDING',
      update: async values => Object.assign(settlementUpdates.RST_1 || (settlementUpdates.RST_1 = {}), values)
    },
    {
      settlement_id: 'RST_2', settlement_no: 'RST20260706002', source_type: 'REBATE_RECEIPT',
      counterparty_id: 'SUP_1', counterparty_name: '测试厂商', amount: 10000, matched_amount: 0, status: 'PENDING',
      update: async values => Object.assign(settlementUpdates.RST_2 || (settlementUpdates.RST_2 = {}), values)
    }
  ];
  const posting = {
    posting_id: 'RPO_1', posting_no: 'RPO20260706001', supplier_id: 'SUP_1', amount: 30000,
    matched_amount: 0, status: 'UNMATCHED', update: async values => {
      Object.assign(posting, values);
      Object.assign(postingUpdates, values);
    }
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ResourceSettlement.findAll = async () => records;
  models.RebatePostingOrder.findByPk = async () => posting;
  models.RebateSettlementAllocation.create = async values => allocations.push(values);
  try {
    const ctx = context({
      body: {
        items: [
          { settlementId: 'RST_1', allocations: [{ postingId: 'RPO_1', amount: 10000 }] },
          { settlementId: 'RST_2', allocations: [{ postingId: 'RPO_1', amount: 5000 }] }
        ]
      }
    });
    await resourceRights.batchSettleRebateResources(ctx);
    assert.equal(allocations.length, 2);
    assert.equal(settlementUpdates.RST_1.status, 'SETTLED');
    assert.equal(settlementUpdates.RST_2.status, 'PARTIALLY_SETTLED');
    assert.equal(postingUpdates.matched_amount, 15000);
    assert.equal(postingUpdates.status, 'PARTIALLY_MATCHED');
    assert.equal(ctx.body.data.items.length, 2);
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.ResourceSettlement.findAll = originals.settlementFindAll;
    models.RebatePostingOrder.findByPk = originals.postingFindByPk;
    models.RebateSettlementAllocation.create = originals.allocationCreate;
  }
});

test('返利下账单没有关联上账单时不允许直接增加余额', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    settlementFindByPk: models.ResourceSettlement.findByPk,
    categoryFindOne: models.ResourceCategory.findOne
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ResourceSettlement.findByPk = async () => ({
    settlement_id: 'RST_1',
    source_type: 'MANUAL_REBATE',
    counterparty_id: 'SUP_1',
    amount: 30000,
    matched_amount: 0,
    status: 'PENDING'
  });
  models.ResourceCategory.findOne = async () => ({ name: '手工返利' });

  try {
    const ctx = context({ params: { settlementId: 'RST_1' }, body: {} });
    await assert.rejects(
      resourceRights.settleResource(ctx),
      error => error.status === 400 && error.message.includes('请选择返利上账单')
    );
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.ResourceSettlement.findByPk = originals.settlementFindByPk;
    models.ResourceCategory.findOne = originals.categoryFindOne;
  }
});

test('返利上账生成上账单、可用余额和账户流水', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    supplierFindOne: models.Supplier.findOne,
    supplierFindByPk: models.Supplier.findByPk,
    accountFindOne: models.SettlementAccount.findOne,
    postingCreate: models.RebatePostingOrder.create,
    rebateFindOne: models.SupplierRebate.findOne,
    rebateCreate: models.SupplierRebate.create,
    accountSum: models.SettlementAccountTransaction.sum,
    accountCreate: models.SettlementAccountTransaction.create
  };
  const postingRows = [];
  const rebateRows = [];
  const accountRows = [];
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', name: '测试厂商' });
  models.Supplier.findByPk = async () => ({ supplier_id: 'SUP_1', name: '测试厂商' });
  models.SettlementAccount.findOne = async () => ({
    account_id: 'ACC_SUP_1',
    account_type: 'SUPPLIER_REBATE',
    supplier_id: 'SUP_1'
  });
  models.RebatePostingOrder.create = async values => {
    postingRows.push(values);
    return values;
  };
  models.SupplierRebate.findOne = async () => ({ balance: 5000 });
  models.SupplierRebate.create = async values => rebateRows.push(values);
  models.SettlementAccountTransaction.sum = async (field, options) => (
    options.where.type === 'income' ? 5000 : 0
  );
  models.SettlementAccountTransaction.create = async values => accountRows.push(values);

  try {
    const ctx = context({
      body: {
        supplierId: 'SUP_1',
        postingDate: '2026-07-06',
        amount: 30000,
        remark: '暑期活动预上账'
      }
    });
    await rebateController.addRebate(ctx);
    assert.equal(postingRows.length, 1);
    assert.equal(postingRows[0].status, 'UNMATCHED');
    assert.equal(postingRows[0].matched_amount, 0);
    assert.equal(rebateRows.length, 1);
    assert.equal(rebateRows[0].source_type, 'posting_order');
    assert.equal(rebateRows[0].balance, 35000);
    assert.equal(accountRows.length, 1);
    assert.equal(accountRows[0].type, 'income');
    assert.equal(accountRows[0].amount, 30000);
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.Supplier.findOne = originals.supplierFindOne;
    models.Supplier.findByPk = originals.supplierFindByPk;
    models.SettlementAccount.findOne = originals.accountFindOne;
    models.RebatePostingOrder.create = originals.postingCreate;
    models.SupplierRebate.findOne = originals.rebateFindOne;
    models.SupplierRebate.create = originals.rebateCreate;
    models.SettlementAccountTransaction.sum = originals.accountSum;
    models.SettlementAccountTransaction.create = originals.accountCreate;
  }
});

test('返利上账时后台自动创建供应商返利内部账户', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    supplierFindOne: models.Supplier.findOne,
    supplierFindByPk: models.Supplier.findByPk,
    accountFindOne: models.SettlementAccount.findOne,
    accountCreate: models.SettlementAccount.create,
    postingCreate: models.RebatePostingOrder.create,
    rebateFindOne: models.SupplierRebate.findOne,
    rebateCreate: models.SupplierRebate.create,
    accountSum: models.SettlementAccountTransaction.sum,
    accountTransactionCreate: models.SettlementAccountTransaction.create
  };
  let internalAccount = null;
  const accountTransactions = [];
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.Supplier.findOne = async () => ({ supplier_id: 'SUP_1', name: '测试厂商' });
  models.Supplier.findByPk = async () => ({ supplier_id: 'SUP_1', name: '测试厂商' });
  models.SettlementAccount.findOne = async () => internalAccount;
  models.SettlementAccount.create = async values => {
    internalAccount = values;
    return values;
  };
  models.RebatePostingOrder.create = async values => values;
  models.SupplierRebate.findOne = async () => null;
  models.SupplierRebate.create = async () => {};
  models.SettlementAccountTransaction.sum = async () => 0;
  models.SettlementAccountTransaction.create = async values => accountTransactions.push(values);

  try {
    const ctx = context({
      body: {
        supplierId: 'SUP_1',
        postingDate: '2026-07-06',
        amount: 30000,
        remark: '自动账户测试'
      }
    });
    await rebateController.addRebate(ctx);
    assert.equal(internalAccount.account_type, 'SUPPLIER_REBATE');
    assert.equal(internalAccount.supplier_id, 'SUP_1');
    assert.match(internalAccount.account_name, /测试厂商返利内部账户/);
    assert.equal(accountTransactions.length, 1);
    assert.equal(accountTransactions[0].amount, 30000);
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.Supplier.findOne = originals.supplierFindOne;
    models.Supplier.findByPk = originals.supplierFindByPk;
    models.SettlementAccount.findOne = originals.accountFindOne;
    models.SettlementAccount.create = originals.accountCreate;
    models.RebatePostingOrder.create = originals.postingCreate;
    models.SupplierRebate.findOne = originals.rebateFindOne;
    models.SupplierRebate.create = originals.rebateCreate;
    models.SettlementAccountTransaction.sum = originals.accountSum;
    models.SettlementAccountTransaction.create = originals.accountTransactionCreate;
  }
});

test('自动迁移允许待下账返利不关联SN并初始化手工返利类型', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  assert.match(migration, /checkAndMakeColumnNullable\('T_RESOURCE_SETTLEMENT', 'SN_ID'/);
  assert.match(migration, /checkAndMakeColumnNullable\('T_RESOURCE_SETTLEMENT', 'SN_CODE'/);
  assert.match(migration, /checkAndMakeColumnNullable\('T_RESOURCE_SETTLEMENT', 'PRODUCT_ID'/);
  assert.match(migration, /'RC_MANUAL_REBATE', 'MANUAL_REBATE', '手工返利'/);
  assert.match(migration, /checkAndCreateTable\('T_REBATE_POSTING_ORDER'/);
  assert.match(migration, /checkAndCreateTable\('T_REBATE_SETTLEMENT_ALLOCATION'/);
  assert.match(migration, /'MATCHED_AMOUNT', 'DECIMAL\(12,2\) DEFAULT 0 COMMENT "已核销金额"'/);
});

test('手工待下账返利可以由admin填写原因后取消', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    settlementFindByPk: models.ResourceSettlement.findByPk
  };
  const updates = {};
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ResourceSettlement.findByPk = async () => ({
    source_type: 'MANUAL_REBATE',
    status: 'PENDING',
    update: async values => Object.assign(updates, values)
  });

  try {
    const ctx = context({
      params: { settlementId: 'RST_1' },
      body: { reason: '厂商取消活动' },
      roles: ['admin']
    });
    await resourceRights.cancelResourceSettlement(ctx);
    assert.equal(updates.status, 'CANCELLED');
    assert.equal(updates.correction_reason, '厂商取消活动');
    assert.equal(updates.cancelled_by_name, '财务测试员');
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.ResourceSettlement.findByPk = originals.settlementFindByPk;
  }
});

test('撤销返利下账核销时退回上账单待核销金额且不改变返利余额', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    settlementFindByPk: models.ResourceSettlement.findByPk,
    allocationFindAll: models.RebateSettlementAllocation.findAll,
    postingFindByPk: models.RebatePostingOrder.findByPk,
    accountTransactionCreate: models.SettlementAccountTransaction.create,
    supplierRebateCreate: models.SupplierRebate.create
  };
  const settlementUpdates = {};
  const allocationUpdates = {};
  const postingUpdates = {};
  const record = {
    settlement_id: 'RST_1',
    settlement_no: 'RST20260706001',
    source_type: 'MANUAL_REBATE',
    source_id: 'SRC_1',
    counterparty_name: '测试厂商',
    amount: 30000,
    matched_amount: 30000,
    status: 'SETTLED',
    update: async values => Object.assign(settlementUpdates, values)
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ResourceSettlement.findByPk = async () => record;
  models.RebateSettlementAllocation.findAll = async () => [{
    posting_id: 'RPO_1',
    amount: 30000,
    update: async values => Object.assign(allocationUpdates, values)
  }];
  models.RebatePostingOrder.findByPk = async () => ({
    posting_id: 'RPO_1',
    amount: 30000,
    matched_amount: 30000,
    update: async values => Object.assign(postingUpdates, values)
  });
  models.SettlementAccountTransaction.create = async () => {
    throw new Error('撤销核销不得生成账户流水');
  };
  models.SupplierRebate.create = async () => {
    throw new Error('撤销核销不得改变供应商返利余额');
  };

  try {
    const ctx = context({
      params: { settlementId: 'RST_1' },
      body: { reason: '银行退回款项' },
      roles: ['boss']
    });
    await resourceRights.reverseResourceSettlement(ctx);
    assert.equal(allocationUpdates.status, 'REVERSED');
    assert.equal(postingUpdates.matched_amount, 0);
    assert.equal(postingUpdates.status, 'UNMATCHED');
    assert.equal(settlementUpdates.status, 'PENDING');
    assert.equal(settlementUpdates.matched_amount, 0);
    assert.equal(settlementUpdates.correction_reason, '银行退回款项');
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.ResourceSettlement.findByPk = originals.settlementFindByPk;
    models.RebateSettlementAllocation.findAll = originals.allocationFindAll;
    models.RebatePostingOrder.findByPk = originals.postingFindByPk;
    models.SettlementAccountTransaction.create = originals.accountTransactionCreate;
    models.SupplierRebate.create = originals.supplierRebateCreate;
  }
});

test('返利上账单已被采购占用时必须先采购退单才能冲销', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    postingFindByPk: models.RebatePostingOrder.findByPk,
    postingSum: models.RebatePostingOrder.sum,
    rebateFindOne: models.SupplierRebate.findOne
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.RebatePostingOrder.findByPk = async () => ({
    posting_id: 'RPO_1',
    posting_no: 'RPO20260706001',
    supplier_id: 'SUP_1',
    amount: 30000,
    matched_amount: 0,
    status: 'UNMATCHED'
  });
  models.RebatePostingOrder.sum = async () => 30000;
  models.SupplierRebate.findOne = async () => ({ balance: 10000 });

  try {
    const ctx = context({
      params: { postingId: 'RPO_1' },
      body: { reason: '录入错误' }
    });
    await assert.rejects(
      rebateController.reverseRebatePostingOrder(ctx),
      error => error.status === 409 && error.message.includes('请先完成采购退单')
    );
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.RebatePostingOrder.findByPk = originals.postingFindByPk;
    models.RebatePostingOrder.sum = originals.postingSum;
    models.SupplierRebate.findOne = originals.rebateFindOne;
  }
});
