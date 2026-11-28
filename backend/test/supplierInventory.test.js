const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { normalizePn, parseSupplierWorkbook } = require('../src/modules/inventory/supplierInventory');

function workbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name));
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('汇一只移除确认的 -XN 后缀', () => {
  assert.equal(normalizePn(' 83DA0000CD-XN ', 'tianjin'), '83DA0000CD');
  assert.equal(normalizePn('ABC-TEST', 'tianjin'), 'ABC-TEST');
});

test('佳华跨报价表汇总，保留文字库存', () => {
  const buffer = workbookBuffer({
    NB报价单: [
      ['系列', '商品编码', '产品明细', '含税单价', 'SEC', '自有1库', '成都K'],
      ['', 'PN000001', '产品A', 100, 2, 3, '少量']
    ],
    DT报价单: [
      ['系列', 'MTM', '产品明细', '含税单价', 'SEC', '自有1库', '成都K'],
      ['', 'PN000001', '产品A', 100, 1, 0, '']
    ]
  });
  const parsed = parseSupplierWorkbook(buffer, 'changhong');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].quantity, 6);
  assert.equal(parsed.records[0].text, '少量');
});

test('汇一识别双行表头并汇总四个库存列', () => {
  const buffer = workbookBuffer({ 产品: [
    ['系统编码', '配置', '代理价', '库存合计', '', '', ''],
    ['', '', '', '成都SEC', '成都诚义', '重庆诚义', '重庆SEC'],
    ['83DA0000CD-XN', '产品A', 3999, 2, 3, 4, 5]
  ] });
  const parsed = parseSupplierWorkbook(buffer, 'tianjin');
  assert.equal(parsed.records[0].pn, '83DA0000CD');
  assert.equal(parsed.records[0].quantity, 14);
});
