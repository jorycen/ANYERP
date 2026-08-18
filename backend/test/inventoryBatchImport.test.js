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
