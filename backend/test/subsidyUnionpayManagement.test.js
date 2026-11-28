const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('国补应收支持云闪付订单号展示查询和导出', () => {
  const controller = read('backend/src/modules/finance/controller.js');
  const view = read('frontend/web/src/views/Finance.vue');
  const model = read('backend/src/models/index.js');
  const migration = read('backend/src/utils/dbMigration.js');
  assert.match(controller, /unionpayOrderNo/);
  assert.match(controller, /unionpay_order_no/);
  assert.match(controller, /云闪付订单号: row\.unionpay_order_no/);
  assert.match(view, /prop="unionpay_order_no" label="云闪付订单号"/);
  assert.match(view, /params\.unionpayOrderNo = subsidyQuery\.unionpayOrderNo\.trim\(\)/);
  assert.match(model, /unionpay_order_no: \{ type: DataTypes\.STRING\(128\)/);
  assert.match(migration, /idx_daily_unionpay_order_no/);
});

test('国补应收支持手工登记并按云闪付订单号批量下账', () => {
  const controller = read('backend/src/modules/finance/controller.js');
  const routes = read('backend/src/modules/finance/routes.js');
  const view = read('frontend/web/src/views/Finance.vue');
  assert.match(controller, /async function createManualNationalSubsidyReceivable/);
  assert.match(controller, /source_type: 'manual'/);
  assert.match(controller, /normalizeUnionpayOrderNos/);
  assert.match(controller, /以下云闪付订单号未找到国补应收记录/);
  assert.match(routes, /national-subsidy-receivables\/manual/);
  assert.match(view, /手工登记国补数据/);
  assert.match(view, /按云闪付订单号批量下账/);
});
