const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/resourceRights');

const categories = [
  { category_code: 'GOV_SUBSIDY', name: '国补资格', short_name: '国补' },
  { category_code: 'EDU_SUBSIDY', name: '教育补贴资格', short_name: '教育补贴' }
];

test('资源权益导入支持全中文表头、资源名称和状态', () => {
  const [row] = _test.normalizeImportRows([{
    PN: 'PN001', SN: '', 资源类型: '国补', 资源金额: 500,
    状态: '可用', 开始时间: '', 结束时间: '', 备注: '中文模板'
  }]);

  assert.equal(row.pn, 'PN001');
  assert.equal(row.resourceType, '国补');
  assert.equal(row.status, '可用');
  assert.deepEqual(_test.normalizeImportResourceTypes(row.resourceType, categories, 2), ['GOV_SUBSIDY']);
  assert.equal(_test.normalizeImportStatus(row.status, 2), 'AVAILABLE');
});

test('资源权益导入继续兼容旧版英文代码和值', () => {
  const [row] = _test.normalizeImportRows([{
    pn_code: 'PN002', resource_type: 'GOV_SUBSIDY,EDU_SUBSIDY', status: 'NOT_APPLICABLE'
  }]);

  assert.equal(row.pn, 'PN002');
  assert.deepEqual(
    _test.normalizeImportResourceTypes(row.resourceType, categories, 2),
    ['GOV_SUBSIDY', 'EDU_SUBSIDY']
  );
  assert.equal(_test.normalizeImportStatus(row.status, 2), 'NOT_APPLICABLE');
});

test('资源权益导入的无效值提示使用中文可选项', () => {
  assert.throws(
    () => _test.normalizeImportStatus('LOCKED', 3),
    /第3行状态.*无效，请填写可用、不适用或异常/
  );
  assert.throws(
    () => _test.normalizeImportResourceTypes('UNKNOWN_RESOURCE', categories, 4),
    /第4行资源类型.*请填写系统中的中文资源名称/
  );
});
