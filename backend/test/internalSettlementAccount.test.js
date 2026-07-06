const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
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

test('用户不能手工创建供应商返利内部账户', async () => {
  const ctx = context({
    body: {
      accountName: '测试供应商返利账户',
      accountType: 'SUPPLIER_REBATE',
      supplierId: 'SUP_1'
    }
  });
  await assert.rejects(
    dictController.createSettlementAccount(ctx),
    error => error.status === 400 && error.message.includes('系统自动维护')
  );
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

test('用户结算账号接口隐藏供应商返利内部账户', async () => {
  const original = models.SettlementAccount.findAll;
  let capturedWhere;
  models.SettlementAccount.findAll = async options => {
    capturedWhere = options.where;
    return [];
  };
  try {
    const ctx = context();
    await dictController.getAllSettlementAccounts(ctx);
    assert.equal(capturedWhere.account_type[Op.ne], 'SUPPLIER_REBATE');
  } finally {
    models.SettlementAccount.findAll = original;
  }
});

test('账户中心在数据库查询层排除供应商返利内部账户', async () => {
  const original = models.SettlementAccount.findAndCountAll;
  let capturedWhere;
  models.SettlementAccount.findAndCountAll = async options => {
    capturedWhere = options.where;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = context({ query: { page: 1, pageSize: 20 } });
    await financeController.getSettlementAccountsWithBalance(ctx);
    assert.equal(capturedWhere.account_type[Op.ne], 'SUPPLIER_REBATE');
  } finally {
    models.SettlementAccount.findAndCountAll = original;
  }
});
