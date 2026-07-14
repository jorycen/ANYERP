const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { _test } = require('../src/modules/product/controller');

function excelFile(rows, name = 'import.xlsx') {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '导入');
  return { originalname: name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
}

test('商品导入先校验Excel文件格式并保留数据行', () => {
  const parsed = _test.parseImportWorkbook(excelFile([{ 商品名称: '测试商品', 厂商编码: 'M001' }]), 'product');
  assert.equal(parsed.sheetName, '导入');
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.headers, ['商品名称', '厂商编码']);
});

test('定价导入格式校验拒绝缺少匹配字段的文件', () => {
  assert.throws(
    () => _test.parseImportWorkbook(excelFile([{ 定价: 100, 零售价: 120 }], '定价.xlsx'), 'price'),
    /缺少商品编码或厂商编码列/
  );
});

test('定价导入格式校验拒绝重复表头', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['商品编码', '商品编码', '定价'],
    ['P001', 'P001', 100]
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '定价');
  assert.throws(
    () => _test.parseImportWorkbook({ originalname: '定价.xlsx', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }, 'price'),
    /表头重复/
  );
});
