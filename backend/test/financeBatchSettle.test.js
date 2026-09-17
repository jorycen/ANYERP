const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const financeController = require('../src/modules/finance/controller');

function context(body) {
  return {
    request: { body },
    state: { user: { name: '财务测试员' } },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

test('日结单批量下账超过3条时使用固定长度批次关联号并汇总金额', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    detailFindAll: models.DailyStatementDetail.findAll,
    statementFindByPk: models.DailyStatement.findByPk,
    accountFindByPk: models.SettlementAccount.findByPk,
    transactionSum: models.SettlementAccountTransaction.sum,
    transactionCreate: models.SettlementAccountTransaction.create
  };
  const details = [120, 80, 60, 40].map((amount, index) => ({
    detail_id: `DETAIL_${index + 1}`,
    statement_id: 'STATEMENT_1',
    settlement_account_id: 'ACCOUNT_1',
    amount,
    settled: 0,
    update: async values => Object.assign(details[index], values)
  }));
  const statementUpdates = {};
  let accountTransaction;

  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.DailyStatementDetail.findAll = async () => details;
  models.DailyStatement.findByPk = async () => ({
    total_settled: 0,
    total_revenue: 300,
    update: async values => Object.assign(statementUpdates, values)
  });
  models.SettlementAccount.findByPk = async () => ({ account_id: 'ACCOUNT_1' });
  models.SettlementAccountTransaction.sum = async () => 0;
  models.SettlementAccountTransaction.create = async values => {
    accountTransaction = values;
  };

  try {
    const ctx = context({ detailIds: details.map(detail => detail.detail_id) });
    await financeController.batchSettle(ctx);

    assert.equal(accountTransaction.amount, 300);
    assert.ok(accountTransaction.related_ref.length <= 128);
    assert.match(accountTransaction.related_ref, /^DAILY_SETTLE_[a-f0-9]{32}$/);
    assert.equal(statementUpdates.total_settled, 300);
    assert.equal(ctx.body.message, '下账成功，共 4 笔，金额: ¥300.00');
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.DailyStatementDetail.findAll = originals.detailFindAll;
    models.DailyStatement.findByPk = originals.statementFindByPk;
    models.SettlementAccount.findByPk = originals.accountFindByPk;
    models.SettlementAccountTransaction.sum = originals.transactionSum;
    models.SettlementAccountTransaction.create = originals.transactionCreate;
  }
});

test('日结单负数流水下账后以非零 settled 作为已下账状态', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    detailFindAll: models.DailyStatementDetail.findAll,
    statementFindByPk: models.DailyStatement.findByPk,
    accountFindByPk: models.SettlementAccount.findByPk,
    transactionSum: models.SettlementAccountTransaction.sum,
    transactionCreate: models.SettlementAccountTransaction.create
  };
  const detail = {
    detail_id: 'NEGATIVE_DETAIL', statement_id: 'NEGATIVE_STATEMENT', settlement_account_id: 'ACCOUNT_1',
    amount: -88.5, settled: 0,
    update: async values => Object.assign(detail, values)
  };
  const statementUpdates = {};
  let accountTransaction;

  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.DailyStatementDetail.findAll = async () => [detail];
  models.DailyStatement.findByPk = async () => ({
    total_settled: 0,
    total_revenue: -88.5,
    update: async values => Object.assign(statementUpdates, values)
  });
  models.SettlementAccount.findByPk = async () => ({ account_id: 'ACCOUNT_1' });
  models.SettlementAccountTransaction.sum = async () => 0;
  models.SettlementAccountTransaction.create = async values => { accountTransaction = values; };

  try {
    const ctx = context({ detailIds: [detail.detail_id] });
    await financeController.batchSettle(ctx);

    assert.equal(detail.settled, -88.5);
    assert.ok(detail.settled_at instanceof Date);
    assert.equal(statementUpdates.status, 'settled');
    assert.equal(accountTransaction.type, 'expense');
    assert.equal(accountTransaction.amount, 88.5);
    assert.equal(accountTransaction.balance_after, -88.5);
    assert.equal(ctx.body.message, '下账成功，共 1 笔，金额: ¥-88.50');
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.DailyStatementDetail.findAll = originals.detailFindAll;
    models.DailyStatement.findByPk = originals.statementFindByPk;
    models.SettlementAccount.findByPk = originals.accountFindByPk;
    models.SettlementAccountTransaction.sum = originals.transactionSum;
    models.SettlementAccountTransaction.create = originals.transactionCreate;
  }
});

test('日结单下账会用当前门店收款配置补齐历史缺失的结算账号', async () => {
  const originals = {
    transaction: models.sequelize.transaction,
    detailFindAll: models.DailyStatementDetail.findAll,
    statementFindAll: models.DailyStatement.findAll,
    statementFindByPk: models.DailyStatement.findByPk,
    paymentMethodFindAll: models.PaymentMethod.findAll,
    paymentMethodStoreFindAll: models.PaymentMethodStore.findAll,
    accountFindByPk: models.SettlementAccount.findByPk,
    transactionSum: models.SettlementAccountTransaction.sum,
    transactionCreate: models.SettlementAccountTransaction.create
  };
  const detail = {
    detail_id: 'HISTORICAL_NEGATIVE_DETAIL', statement_id: 'STATEMENT_2', settlement_account_id: null,
    payment_method: '门店二维码', amount: -3500, settled: 0,
    update: async values => Object.assign(detail, values)
  };
  let accountTransaction;
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.DailyStatementDetail.findAll = async () => [detail];
  models.DailyStatement.findAll = async () => [{ statement_id: 'STATEMENT_2', store_id: 'STORE_1' }];
  models.DailyStatement.findByPk = async () => ({ total_settled: 0, total_revenue: -3500, update: async () => {} });
  models.PaymentMethod.findAll = async () => [{ method_id: 'METHOD_1', name: '门店二维码', is_global: 0, settlement_account_id: null }];
  models.PaymentMethodStore.findAll = async () => [{ method_id: 'METHOD_1', store_id: 'STORE_1', settlement_account_id: 'ACCOUNT_1' }];
  models.SettlementAccount.findByPk = async () => ({ account_id: 'ACCOUNT_1' });
  models.SettlementAccountTransaction.sum = async () => 0;
  models.SettlementAccountTransaction.create = async values => { accountTransaction = values; };

  try {
    const ctx = context({ detailIds: [detail.detail_id] });
    await financeController.batchSettle(ctx);
    assert.equal(detail.settlement_account_id, 'ACCOUNT_1');
    assert.equal(detail.settled, -3500);
    assert.equal(accountTransaction.account_id, 'ACCOUNT_1');
    assert.equal(accountTransaction.type, 'expense');
    assert.equal(accountTransaction.amount, 3500);
  } finally {
    models.sequelize.transaction = originals.transaction;
    models.DailyStatementDetail.findAll = originals.detailFindAll;
    models.DailyStatement.findAll = originals.statementFindAll;
    models.DailyStatement.findByPk = originals.statementFindByPk;
    models.PaymentMethod.findAll = originals.paymentMethodFindAll;
    models.PaymentMethodStore.findAll = originals.paymentMethodStoreFindAll;
    models.SettlementAccount.findByPk = originals.accountFindByPk;
    models.SettlementAccountTransaction.sum = originals.transactionSum;
    models.SettlementAccountTransaction.create = originals.transactionCreate;
  }
});
