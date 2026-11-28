const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/batchMaintenance');

test('批量维护导入可以还原 multipart 中按 latin1 传递的中文文件名', () => {
  const filename = '批量入库_非SN商品模板.xlsx';
  const mojibake = Buffer.from(filename, 'utf8').toString('latin1');

  assert.equal(_test.normalizeUploadedFilename(mojibake), filename);
  assert.equal(_test.normalizeUploadedFilename(filename), filename);
  assert.equal(_test.normalizeUploadedFilename('batch.xlsx'), 'batch.xlsx');
});

test('批量维护错误快照只保存行号和原因，避免 raw 行数据撑爆申请单字段', () => {
  const errors = _test.compactBatchErrors([
    { rowNo: 2, message: '商品不存在', raw: { 商品编码: 'P001', 备注: '原始行' } },
    { rowNo: 3, message: '数量必须大于0', raw: { 数量: 0 } }
  ]);

  assert.deepEqual(errors, [
    { rowNo: 2, message: '商品不存在' },
    { rowNo: 3, message: '数量必须大于0' }
  ]);
});

test('批量出库强制忽略资源权益和结算触发参数', () => {
  assert.deepEqual(
    _test.normalizeOperationResources('OUTBOUND', ['REBATE', 'POSTING'], true),
    { resourceTypes: [], triggerResourceRights: false }
  );
});

test('批量入库继续保留资源权益配置', () => {
  assert.deepEqual(
    _test.normalizeOperationResources('INBOUND', ['REBATE'], true),
    { resourceTypes: ['REBATE'], triggerResourceRights: false }
  );
});

test('批量维护支持租赁样机仓', () => {
  assert.equal(_test.isValidInventoryType('rental_demo_qty'), true);
  assert.equal(_test.isValidInventoryType('unknown_qty'), false);
});

test('已出库或已销售的历史SN允许重新入库，当前在库状态仍需拦截', () => {
  assert.equal(_test.isReusableInboundSnStatus('out_stock'), true);
  assert.equal(_test.isReusableInboundSnStatus('sold'), true);
  assert.equal(_test.isReusableInboundSnStatus('in_stock'), false);
  assert.equal(_test.isReusableInboundSnStatus('transferring'), false);
});

test('历史SN唯一身份匹配兼容PN大小写和内部空格差异', () => {
  assert.equal(_test.normalizeSnIdentityValue(' 83QF 0003CD '), '83qf0003cd');
  assert.equal(_test.normalizeSnIdentityValue('BH02A3XS'), 'bh02a3xs');
});

test('SN批量导入兼容机器号和序列号表头', () => {
  assert.equal(_test.getCell({ 机器号: 'MPVMGKR' }, ['SN', '机器号', '序列号']), 'MPVMGKR');
  assert.equal(_test.getCell({ 序列号: 'PF2DNRA4' }, ['SN', '机器号', '序列号']), 'PF2DNRA4');
  assert.equal(_test.getCell({ SN: 'YX030S5F' }, ['SN', '机器号', '序列号']), 'YX030S5F');
});

test('批量执行唯一约束错误转换为可操作提示', () => {
  assert.equal(
    _test.formatExecutionError({ name: 'SequelizeUniqueConstraintError', message: 'Validation error' }),
    '数据唯一性校验失败，请检查SN、PN或其他唯一字段是否已存在'
  );
  assert.equal(_test.formatExecutionError(new Error('第 2 行SN已存在')), '第 2 行SN已存在');
});

test('批量执行按明细汇总为全部成功、部分执行或全部失败', () => {
  assert.equal(_test.summarizeBatchExecution([{ execute_status: 'success' }, { execute_status: 'success' }]).status, 'executed');
  assert.equal(_test.summarizeBatchExecution([{ execute_status: 'success' }, { execute_status: 'failed' }]).status, 'partially_executed');
  assert.equal(_test.summarizeBatchExecution([{ execute_status: 'failed' }, { execute_status: 'failed' }]).status, 'execute_failed');
  assert.equal(_test.summarizeBatchExecution([{ execute_status: 'success' }, { execute_status: 'pending' }]).status, 'executing');
});

test('Excel 票种按真实行号读取，预览更改覆盖原单元格且不能跨行', () => {
  const XLSX = require('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['商品编码', '采购票种'], ['A', ' 专票13% '], [], ['B', '收据']
  ]), '批量入库');
  const rows = _test.parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(rows.map(_test.batchRowNumber), [2, 4]);
  assert.equal(_test.batchInvoice(rows[0], new Map(), 2), '专票13%');
  const reject = () => { throw new Error('invalid overrides'); };
  const overrides = _test.parseInvoiceOverrides('[{"rowNo":2,"invoiceType":"收据"}]', rows, reject);
  assert.equal(_test.batchInvoice(rows[0], overrides, 2), '收据');
  assert.throws(() => _test.parseInvoiceOverrides('[{"rowNo":3,"invoiceType":"收据"}]', rows, reject));
  assert.throws(() => _test.parseInvoiceOverrides('[{"rowNo":2,"invoiceType":"普通发票"}]', rows, reject));
  assert.throws(() => _test.parseInvoiceOverrides('[{"rowNo":2,"invoiceType":"收据"},{"rowNo":2,"invoiceType":"专票13%"}]', rows, reject));
});

test('直接调用导入接口缺一行票种时拒绝整单，旧 Excel 可进入只读预览', async t => {
  const XLSX = require('xlsx');
  const M = require('../src/models');
  const { createBatchApplication } = require('../src/modules/inventory/batchMaintenance');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 商品编码: 'A', 采购票种: '' }]), '库存');
  const payload = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const ctx = {
    state: { user: {} },
    request: { body: { operationType: 'INBOUND', importMode: 'NON_SN' } },
    file: { buffer: payload },
    throw(status, message) { throw Object.assign(new Error(message), { status }); }
  };
  const transaction = { rollback: t.mock.fn(async () => {}) };
  const open = t.mock.method(M.sequelize, 'transaction', async options => {
    assert.equal(options.readOnly, true);
    return transaction;
  });
  t.mock.method(M.InventoryBatchApplication,'create',async()=>assert.fail('预览不得生成申请'));
  t.mock.method(M.Product,'findAll',async()=>[]);
  t.mock.method(M.Product,'findOne',async()=>null);
  t.mock.method(M.Store,'findAll',async()=>[]);
  t.mock.method(M.Store,'findOne',async()=>null);
  await createBatchApplication(ctx);
  assert.equal(ctx.status,400);
  assert.equal(open.mock.callCount(),0);
  ctx.request.body.previewOnly='1';
  await createBatchApplication(ctx);
  assert.equal(ctx.body.rows[0].invoiceType,null);
  assert.equal(ctx.body.rows[0].rowNo,2);
  assert.equal(transaction.rollback.mock.callCount(),1);
});

test('已审批明细为 SN 与非 SN 提供独立票种，历史票种为空时继续标记缺依据', () => {
  const header = { application_no: 'IBM-TEST' };
  const item = { product_id: 'P', unit_price: '12.00', row_no: 2, item_id: 88 };
  assert.equal(_test.batchFoundationReceipt({ ...item, invoice_type:'收据' },header).invoiceType,'收据');
  assert.equal(_test.batchFoundationReceipt({ ...item, invoice_type:'专票13%' },header).invoiceType,'专票13%');
  assert.equal(_test.batchFoundationReceipt(item,header).invoiceType,null);
});

test('提交两种票种后保存逐行选择，审批执行把该票种传到库存档案入口', async t => {
  const XLSX = require('xlsx');
  const M = require('../src/models');
  const { createBatchApplication } = require('../src/modules/inventory/batchMaintenance');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 商品编码: 'A', 门店ID: 'S', 数量: 2, 采购票种: '专票13%', 提货价: 12 },
    { 商品编码: 'B', 门店ID: 'S', 数量: 3, 采购票种: '专票13%', 提货价: 13 }
  ]), '库存');
  const transaction = { LOCK: { UPDATE:'UPDATE' }, commit: t.mock.fn(async () => {}), rollback: async () => {} };
  t.mock.method(M.sequelize,'transaction',async()=>transaction);
  const product={product_id:'P',product_code:'A',name:'配件',need_sn:0,status:1,gross_profit_cost_mode:'PURCHASE_PRICE'};
  t.mock.method(M.Product,'findOne',async()=>product);
  t.mock.method(M.Product,'findByPk',async()=>product);
  t.mock.method(M.ProductPn,'findAll',async()=>[{pn_code:'PN-P',status:1,is_deleted:0}]);
  t.mock.method(M.Store,'findOne',async()=>({store_id:'S',name:'门店'}));
  const location={location_id:'L',store_id:'S',status:1,type:'normal_qty'};
  t.mock.method(M.Location,'findOne',async()=>location);
  t.mock.method(M.Location,'findByPk',async()=>location);
  const seen=[];
  const inv={normal_qty:1,async update(patch,options){seen.push(options.foundationReceipt);Object.assign(this,patch);}};
  t.mock.method(M.Inventory,'findOne',async()=>inv);
  t.mock.method(M.InventoryBatchApplication,'create',async payload=>payload);
  const saved=[];
  t.mock.method(M.InventoryBatchApplicationItem,'create',async row=>saved.push(row));
  const ctx={
    state:{user:{accessibleStoreIds:['S']}},
    request:{body:{operationType:'INBOUND',importMode:'NON_SN',inventoryType:'normal_qty',resourceTypes:'REBATE',
      invoiceOverrides:'[{"rowNo":2,"invoiceType":"收据"}]'}},
    file:{buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),originalname:'入库.xlsx'},
    throw(status,message){throw Object.assign(new Error(message),{status});}
  };
  await createBatchApplication(ctx);
  assert.deepEqual(saved.map(row=>row.invoice_type),['收据','专票13%']);
  assert.equal(transaction.commit.mock.callCount(),1);
  for(const [idx,row] of saved.entries()){
    row.item_id=idx+1;
    row.resource_types='[]';
    row.update=async patch=>Object.assign(row,patch);
    await _test.executeApplicationItem(row,{application_no:'IBM-TEST'},transaction);
  }
  assert.deepEqual(seen.map(receipt=>[receipt.invoiceType,receipt.unitCost]),[['收据',12],['专票13%',13]]);
  assert.equal(inv.normal_qty,6);
});
