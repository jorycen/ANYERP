const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SubsidyAccountRoute,
  SubsidyReceipt,
  SubsidyReceiptAllocation,
  SubsidyReceivableAdjustment
} = require('../src/models');

const migrationSource = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '../src/modules/finance/controller.js'), 'utf8');

test('国补到账、核销和差额审批表均由自动迁移创建', () => {
  const tables = [
    'T_SUBSIDY_ACCOUNT_ROUTE',
    'T_SUBSIDY_RECEIPT',
    'T_SUBSIDY_RECEIPT_ALLOCATION',
    'T_SUBSIDY_RECEIVABLE_ADJUSTMENT'
  ];
  for (const table of tables) {
    assert.match(migrationSource, new RegExp(`checkAndCreateTable\\('${table}'`));
  }
  assert.equal(SubsidyAccountRoute.tableName, 'T_SUBSIDY_ACCOUNT_ROUTE');
  assert.equal(SubsidyReceipt.tableName, 'T_SUBSIDY_RECEIPT');
  assert.equal(SubsidyReceiptAllocation.tableName, 'T_SUBSIDY_RECEIPT_ALLOCATION');
  assert.equal(SubsidyReceivableAdjustment.tableName, 'T_SUBSIDY_RECEIVABLE_ADJUSTMENT');
});

test('国补到账限制区域兜底、超额核销和差额自审', () => {
  assert.match(controllerSource, /该区域尚未配置国补到账资金账户/);
  assert.match(controllerSource, /分配金额不得超过银行实际到账金额/);
  assert.match(controllerSource, /核销金额超过剩余应收/);
  assert.match(controllerSource, /申请人不得审批自己的差额申请/);
  assert.match(controllerSource, /只有 admin 或 BOSS 可以审批国补差额/);
});
