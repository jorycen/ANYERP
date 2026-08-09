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
