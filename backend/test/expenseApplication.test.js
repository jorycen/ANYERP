const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const A = require('../src/modules/finance/expenseApplication');
const C = require('../src/modules/finance/controller');
const Service = require('../src/modules/finance/expenseService');
const approval = require('../src/modules/approval/service');
const { summarizeAllocatedExpenses } = require('../src/modules/finance/expenseCostAllocation');
const tx = { LOCK: { UPDATE: 'UPDATE' } };
const row = values => ({ ...values, async update(patch) { Object.assign(this, patch); return this; }, toJSON() { return { ...this }; } });
const recipient = { source: 'TEMPORARY', payeeName: '临时收款人', bankName: '测试银行', accountNumber: '001234567890' };
const file = { url: 'cloud://test/expense/receipt.xlsx', name: '费用明细.xlsx' };
const ctx = (body = {}) => ({ request: { body }, state: { user: { staffId: 1, name: '申请员工', roles: ['clerk'], accessibleStoreIds: ['S1'] } }, params: {}, throw(status, message) { throw Object.assign(Error(message), { status }); } });

test('三类付款信息冻结在申请单；员工只显示员工账户，手工账户保留前导零', () => {
  assert.equal(A.recipient(recipient, 'CORPORATE', '员工').mode, 'UNIT');
  assert.equal(A.recipient(recipient, 'CORPORATE_OTHER', '员工').mode, 'OTHER');
  assert.equal(A.recipient(recipient, 'CORPORATE', '员工').accountNumber, '001234567890');
  assert.deepEqual(A.recipient(recipient, 'PERSONAL_ADVANCE', '员工'), { version: 1, mode: 'EMPLOYEE', payeeName: '员工', description: '支付至员工账户' });
  assert.throws(() => A.recipient({}, 'CORPORATE', ''), /完整收款人/);
  assert.throws(() => A.recipient({ ...recipient, source: 'SUPPLIER' }, 'CORPORATE', ''), /请选择已有供应商/);
});

test('提交必须有图片、PDF或Excel附件，草稿可不传，拒绝脚本等文件类型', () => {
  assert.throws(() => A.attachments([]), /至少上传/);
  assert.equal(A.attachments([], true).length, 0);
  assert.equal(A.attachments([file, { url: 'https://example.com/proof.pdf', name: '凭证.pdf' }, 'cloud://test/proof.jpg']).length, 3);
  assert.throws(() => A.attachments([{ url: 'https://example.com/a.html', name: 'a.html' }]), /仅支持/);
  assert.throws(() => A.attachments([{ url: 'javascript:alert(1)', name: 'a.pdf' }]), /地址无效/);
});

test('分摊金额精确到分，拒绝负数、不完整金额与一分钱差额', () => {
  const input = { attributionType: 'STORE', attributionMethod: 'MANUAL', totalAmount: 100, sourceStoreId: 'S1' };
  for (const amount of [-1, 'not money', 99.99, 100.01, 100.001]) {
    assert.throws(() => Service.normalizeAttribution({ ...input, allocationDetails: [{ targetId: 'S1', amount }] }));
  }
});

test('当前审批人可读取本单收款附件，非审批人不能通过更换单号访问', async t => {
  const expense = row({ expense_id: 'E', applicant_staff_id: 2, source_type: 'expense', store_id: 'OTHER', recipient_snapshot_json: JSON.stringify(recipient), attachment_urls: JSON.stringify([file]) });
  t.mock.method(M.Expense, 'findByPk', async () => expense);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => ({ instance_id: 'I' }));
  let assigned = true;
  t.mock.method(M.ApprovalTask, 'findOne', async () => assigned ? { task_id: 'T' } : null);
  const request = ctx(); request.params.id = 'E';
  await C.getExpenseDetail(request);
  assert.equal(request.body.data.recipient_snapshot_json, JSON.stringify(recipient));
  assigned = false;
  await assert.rejects(C.getExpenseDetail(request), error => error.status === 403);
});

function fixtures(t) {
  const periods = [], created = [], instances = [];
  t.mock.method(M.sequelize, 'query', async () => { throw Error('Unexpected database access'); });
  t.mock.method(M.sequelize, 'transaction', async callback => callback(tx));
  t.mock.method(M.ExpenseType, 'findOne', async () => ({ type_id: 'TYPE', name: '经营费用' }));
  t.mock.method(M.Store, 'findByPk', async () => ({ store_id: 'S1', name: '源门店', distributor_id: 'D1' }));
  t.mock.method(M.Store, 'findAll', async options => ['S1', 'S2'].filter(id => options.where.store_id.includes(id)).map(id => ({ store_id: id, name: id === 'S1' ? '源门店' : '跨经销商门店', distributor_id: id === 'S1' ? 'D1' : 'D2' })));
  t.mock.method(M.ExpenseAccountingPeriod, 'findOne', async options => { periods.push(options.where.distributor_id); return null; });
  t.mock.method(M.Expense, 'create', async values => { const result = row(values); created.push(result); return result; });
  t.mock.method(M.ApprovalFlowDefinition, 'findOne', async () => ({ status: 'published' }));
  t.mock.method(approval, 'startInstance', async values => { instances.push(values); return {}; });
  return { periods, created, instances };
}

test('员工垫付和经营承担方相互独立；跨经销商平均分摊校验两边月份且不扩大付款来源', async t => {
  const fixture = fixtures(t);
  t.mock.method(M.ExpensePerformanceAllocation, 'create', async () => { throw Error('Must not deduct employee performance'); });
  const request = ctx({ storeId: 'S1', expenseTypeId: 'TYPE', expenseParty: '费用单位', amount: 100.01, paymentMethod: 'PERSONAL_ADVANCE',
    expenseDate: '2026-10-21', attributionType: 'STORE', attributionMethod: 'AVERAGE', attachmentUrls: [file],
    allocationDetails: [{ targetId: 'S1' }, { targetId: 'S2' }] });
  await C.createExpense(request);
  assert.equal(fixture.created[0].distributor_id, 'D1');
  assert.equal(fixture.created[0].status, 'pending_approval');
  const allocations = JSON.parse(fixture.created[0].attribution_details_json);
  assert.equal(allocations.reduce((sum, item) => Math.round((sum + item.amount) * 100) / 100, 0), 100.01);
  assert.equal(allocations[1].target_name, '跨经销商门店');
  assert.ok(fixture.periods.includes('D2'));
  assert.equal(JSON.parse(fixture.created[0].recipient_snapshot_json).mode, 'EMPLOYEE');
  assert.equal(fixture.instances[0].payload.attachmentUrls[0].name, '费用明细.xlsx');
});

test('公司其他账户申请保留单据快照，不修改供应商档案；缺附件及个人自动绩效归属被阻止', async t => {
  const fixture = fixtures(t);
  t.mock.method(M.Supplier, 'update', async () => { throw Error('Must not change master data'); });
  const body = { storeId: 'S1', expenseTypeId: 'TYPE', expenseParty: '费用收款方', amount: 200, paymentMethod: 'CORPORATE_OTHER',
    recipient, attachmentUrls: [file], attributionType: 'PRODUCT_SIDE', expenseDate: '2026-10-21' };
  await C.createExpense(ctx(body));
  assert.equal(JSON.parse(fixture.created[0].recipient_snapshot_json).mode, 'OTHER');
  assert.equal(fixture.created[0].payment_method, 'CORPORATE');
  assert.equal(fixture.created[0].attribution_type, 'PRODUCT_SIDE');
  await assert.rejects(C.createExpense(ctx({ ...body, attachmentUrls: [] })), /至少上传/);
  await assert.rejects(C.createExpense(ctx({ ...body, attributionType: 'PERSONAL' })), /不能自动扣减员工绩效/);
  assert.equal(fixture.created.length, 1);
});

test('当前审批人可切换产品端或跨经销商分摊，保存前重查节点，保留收款及附件快照', async t => {
  fixtures(t);
  const expense = row({ expense_id: 'E', source_type: 'expense', status: 'pending_approval', amount: 100, store_id: 'S1', distributor_id: 'D1', accounting_month: '2026-10', attribution_type: 'STORE', attribution_details_json: '[]', recipient_snapshot_json: JSON.stringify(recipient) });
  const instance = row({ instance_id: 'I', payload_json: JSON.stringify({ attachmentUrls: [file], recipient }) });
  let logs = [];
  t.mock.method(M.Expense, 'findByPk', async () => expense);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => instance);
  t.mock.method(M.ApprovalTask, 'findOne', async () => ({ node_name: '最终审核' }));
  t.mock.method(M.BusinessActionLog, 'create', async values => { logs.push(values); });
  const request = ctx({ attributionType: 'PRODUCT_SIDE', attributionMethod: 'AVERAGE' }); request.params.id = 'E';
  await C.updateExpenseAttribution(request);
  assert.equal(expense.attribution_type, 'PRODUCT_SIDE');
  assert.equal(JSON.parse(instance.payload_json).attachmentUrls[0].name, file.name);
  assert.equal(logs.length, 1);
  t.mock.method(M.ApprovalTask, 'findOne', async () => null);
  await assert.rejects(C.updateExpenseAttribution(request), error => error.status === 403);
});

test('经营统计计入来自其他经销商的门店分摊，合并查询不重复计整笔费用', async t => {
  let index = 0;
  t.mock.method(M.sequelize, 'query', async sql => {
    index++;
    if (index === 1 || index === 2) return [{ storeId: 'S2', storeName: '门店二', distributorId: 'D2' }];
    assert.match(sql, /JSON_TABLE/);
    return [{ expenseId: 'E', expenseType: '费用', amount: 100, sourceStoreId: 'S1', distributorId: 'D1', attributionType: 'STORE', attributionDetails: JSON.stringify([
      { target_type: 'store', target_id: 'S1', amount: 40 }, { target_type: 'store', target_id: 'S2', amount: 60 }
    ]) }];
  });
  const result = await summarizeAllocatedExpenses({ storeIds: ['S2'], startDate: '2026-10-01', endDate: '2026-10-31' });
  assert.equal(result.amount, 60);
  assert.equal(result.expenseCount, 1);
});

test('最终审批付款使用本单冻结账户，不使用当前供应商账户；经营费用不生成员工绩效扣减', async t => {
  fixtures(t);
  const expense = row({ expense_id: 'E', expense_no: 'EXP1', source_type: 'expense', status: 'pending_approval', payment_method: 'CORPORATE',
    amount: 200, store_id: 'S1', distributor_id: 'D1', accounting_month: '2026-10', applicant_name: '申请员工', expense_party: '费用单位',
    recipient_snapshot_json: JSON.stringify({ ...recipient, supplierName: '已选供应商', supplierId: 'SUPPLIER', mode: 'OTHER' }), attachment_urls: JSON.stringify([file]),
    attribution_type: 'PRODUCT_SIDE', attribution_details_json: JSON.stringify([{ target_type: 'product_side', target_id: 'PRODUCT_SIDE', amount: 200 }]) });
  let settlement;
  const payable = row({ payable_id: 'PAYABLE', total_amount: 200 });
  t.mock.method(M.Expense, 'findByPk', async () => expense);
  t.mock.method(M.Payable, 'findOne', async () => payable);
  t.mock.method(M.Payable, 'findByPk', async () => payable);
  t.mock.method(M.Settlement, 'findOne', async () => null);
  t.mock.method(M.Settlement, 'create', async values => { settlement = values; return values; });
  t.mock.method(M.SettlementItem, 'create', async () => ({}));
  t.mock.method(M.SettlementItem, 'findAll', async () => []);
  t.mock.method(M.SupplierPaymentAccount, 'findAll', async () => { throw Error('Must not reload current supplier bank'); });
  t.mock.method(M.ExpensePerformanceAllocation, 'create', async () => { throw Error('Must not deduct employee performance'); });
  await Service.applyExpenseApproval({ business_id: 'E' }, tx, { staffId: 9, name: '最终审核人' }, 'approved');
  assert.equal(settlement.distributor_id, 'D1');
  assert.equal(settlement.payee_name, '临时收款人');
  assert.equal(JSON.parse(settlement.supplier_account_snapshot).accountNumber, '001234567890');
  assert.equal(payable.payee_name, '临时收款人');
});
