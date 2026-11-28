const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('费用菜单统一为费用报销管理并停用独立报销结算菜单', () => {
  const migration = read('backend/src/utils/dbMigration.js');
  const financeView = read('frontend/web/src/views/Finance.vue');
  const layout = read('frontend/web/src/views/Layout.vue');
  const router = read('frontend/web/src/router/index.js');
  const miniPage = read('pages/expense-manage/expense-manage.json');

  assert.match(migration, /\['finance_expense', '费用\/报销管理'/);
  assert.doesNotMatch(migration, /\['finance_reimbursement', '报销结算'/);
  assert.match(migration, /'paymentManagement', 'finance_reimbursement'/);
  assert.match(financeView, /label="费用\/报销管理" name="expense"/);
  assert.doesNotMatch(financeView, /<el-tab-pane label="报销结算"/);
  assert.match(layout, /'\/finance\/expense': '费用\/报销管理'/);
  assert.match(router, /path: 'finance\/reimbursement'[\s\S]*redirect: '\/finance\/expense'/);
  assert.match(miniPage, /费用\/报销管理/);
});
