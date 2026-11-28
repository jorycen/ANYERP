const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../src/models');
const purchase = require('../src/modules/purchase/controller');
const payable = require('../src/modules/finance/payableController');
function ctx(params) {
  return { params, query: {}, state: { user: { staffId: 7, roles: ['boss'], accessibleStoreIds: ['S'] } }, request: { body: {} },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
}
test('采购创建备注从reason带入详情，保存和清空后重新打开仍一致', async t => {
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('不可访问真实数据库'); });
  const data = { request_id: 'P', store_id: 'S', reason: '新建采购时填写的备注', status: 'pending', total_amount: 100, items: [], adjustments: [] };
  const row = { ...data, toJSON() { return { ...this }; }, async update(values) { Object.assign(this, values); } };
  t.mock.method(M.PurchaseRequest, 'findOne', async () => row);
  t.mock.method(M.PurchaseRequest, 'findByPk', async () => row);
  for (const model of [M.Payable, M.Expense, M.ReturnStock, M.BusinessActionLog]) t.mock.method(model, 'findAll', async () => []);
  const request = ctx({ requestId: 'P' });
  await purchase.getRequestDetail(request);
  assert.equal(request.body.data.remark, data.reason);
  for (const value of ['再次编辑备注', '']) {
    request.request.body = { remark: value };
    await purchase.updateRequestRemark(request);
    await purchase.getRequestDetail(request);
    assert.equal(request.body.data.remark, value);
    assert.equal(request.body.data.reason, value);
    assert.equal(row.total_amount, 100); assert.equal(row.status, 'pending');
  }
});
test('结算详情带出新建备注，保存后重新读取不改变金额和状态', async t => {
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('不可访问真实数据库'); });
  const row = { settlement_id: 'SET', distributor_id: 'D1', remark: '新建结算备注', status: 'draft', total_amount: 100, items: [],
    toJSON() { return { ...this }; }, async update(values) { Object.assign(this, values); } };
  t.mock.method(M.Settlement, 'findByPk', async () => row);
  t.mock.method(M.Distributor, 'findAll', async () => [{ distributor_id: 'D1', name: '测试经销商' }]);
  t.mock.method(M.Settlement, 'findOne', async () => row);
  t.mock.method(M.sequelize, 'transaction', async run => run({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(M.BusinessActionLog, 'create', async values => values);
  const request = ctx({ id: 'SET' });
  await payable.getSettlementDetail(request);
  assert.equal(request.body.data.remark, '新建结算备注');
  request.request.body = { remark: '编辑后的结算备注' };
  await payable.updateSettlementRemark(request);
  await payable.getSettlementDetail(request);
  assert.equal(request.body.data.remark, '编辑后的结算备注');
  assert.equal(row.total_amount, 100); assert.equal(row.status, 'draft');
});
function editor(update) {
  const props = { kind: 'purchase', documentId: 'P', value: '原备注' }, events = [], errors = [];
  const script = fs.readFileSync(path.join(__dirname, '../../frontend/web/src/components/DocumentRemarkEditor.vue'), 'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/gm, '');
  const sandbox = { defineProps: () => props, defineEmits: () => (...args) => events.push(args), ref: value => ({ value }),
    watch: (_, callback) => callback(), api: { updatePurchaseRequestRemark: update, updateSettlementRemark: update }, ElMessage: { success() {}, error(message) { errors.push(message); } } };
  vm.runInNewContext(script + '\nglobalThis.editor = { draft, saving, save };', sandbox);
  return { ...sandbox.editor, props, events, errors };
}
test('详情编辑器带出原备注，只在成功保存后通知详情更新', async () => {
  const calls = [];
  const f = editor(async (id, body) => { calls.push([id, body.remark]); return { code: 0, data: { remark: '新备注' } }; });
  assert.equal(f.draft.value, '原备注');
  f.draft.value = '新备注'; await f.save();
  assert.deepEqual(calls, [['P', '新备注']]);
  assert.equal(f.events[0][0], 'saved'); assert.equal(f.events[0][1], '新备注');
});
test('保存失败保留输入以便重试，不覆盖已存备注', async () => {
  const f = editor(async () => { throw new Error('保存失败'); });
  f.draft.value = '未保存'; await f.save();
  assert.equal(f.draft.value, '未保存'); assert.equal(f.events.length, 0); assert.equal(f.saving.value, false);
  assert.equal(f.errors[0], '保存失败');
});
test('保存未返回时切换单据，旧响应不得写入另一单详情', async () => {
  let finish;
  const f = editor(() => new Promise(resolve => { finish = resolve; }));
  f.draft.value = 'P的新备注'; const running = f.save();
  f.props.documentId = 'P2'; finish({ code: 0, data: { remark: 'P的新备注' } });
  await running;
  assert.equal(f.events.length, 0);
});
