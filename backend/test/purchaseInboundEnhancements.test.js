const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatChinaDate, normalizeResponseDates } = require('../src/middleware/responseFormatter');

const root = path.join(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('API 日期统一序列化为北京时间且不会重复加八小时', () => {
  assert.equal(formatChinaDate(new Date('2026-09-20T00:00:00.000Z')), '2026-09-20 08:00:00');
  const body = { data: [{ create_time: new Date('2026-09-20T01:02:03.000Z') }] };
  normalizeResponseDates(body);
  assert.equal(body.data[0].create_time, '2026-09-20 09:02:03');
});

test('采购申请只允许13%含税和未税并保存快递单号及二手商品建档信息', () => {
  const source = read('backend/src/modules/purchase/controller.js');
  assert.match(source, /new Set\(\['未税', '13%含税'\]\)/);
  assert.match(source, /express_no:\s*String\(expressNo/);
  assert.match(source, /new_product_payload:\s*isUsedProduct/);
  assert.match(source, /JSON\.parse\(item\.new_product_payload/);
});

test('手机采购入库强制校验并保存SN、IMEI1、IMEI2', () => {
  const source = read('backend/src/modules/inventory/controller.js');
  assert.match(source, /入库必须填写 SN、IMEI1、IMEI2/);
  assert.match(source, /imei1:\s*submittedImei1/);
  assert.match(source, /imei2:\s*submittedImei2/);
});

test('应付结算单列表返回当前审批节点和审批人', () => {
  const source = read('backend/src/modules/finance/payableController.js');
  const view = read('frontend/web/src/views/PayableSettlementManagement.vue');
  assert.match(source, /approval_stage_name\s*=\s*nodeName/);
  assert.match(source, /approval_progress_text\s*=\s*approverNames\.length/);
  assert.match(source, /await enrichSettlementApprovalProgress\(rows\)/);
  assert.match(view, /当前审批环节/);
  assert.match(view, /row\.approval_progress_text/);
});

test('审批中心不重复展示需要在调拨管理处理的人工调拨任务', () => {
  const runtime = read('backend/src/modules/approval/businessRuntime.js');
  const view = read('frontend/web/src/views/Approval.vue');
  assert.match(runtime, /if \(!onlyType && d\.manual\) continue/);
  assert.match(view, /inventory_transfer_receipt/);
  assert.match(view, /!item\.manual_path/);
});

test('我的申请只返回本人发起的审批并展示当前审批进度', () => {
  const controller = read('backend/src/modules/approval/controller.js');
  const view = read('frontend/web/src/views/Approval.vue');
  assert.match(controller, /return \{ applicant_staff_id: user\.staffId \}/);
  assert.match(controller, /current_progress_text/);
  assert.match(controller, /await enrichInstanceProgress\(rows\)/);
  assert.match(view, /label="当前进度"/);
  assert.match(view, /row\.current_progress_text/);
});
