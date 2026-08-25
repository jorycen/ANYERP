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
