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

test('PN比较统一为字符串并移除空格，且过滤占位值', () => {
  assert.equal(_test.normalizePnCode(' 87 001 7165 '), '870017165');
  assert.deepEqual(_test.splitPnCodes('87 001 7165'), ['87 001 7165']);
  assert.deepEqual(_test.splitPnCodes('PN001, PN002, 无'), ['PN001', 'PN002']);
});

test('异步导入失败清单保留原始列并追加异常原因', () => {
  const rows = _test.importTaskErrorRows({
    error_json: JSON.stringify([{ row: 3, product: { 商品名称: '测试商品', 厂商编码: 'M001' }, message: '厂商编码已存在' }])
  });
  assert.deepEqual(rows, [{ 行号: 3, 商品名称: '测试商品', 厂商编码: 'M001', 异常原因: '厂商编码已存在' }]);
});

test('商品分类层级判断继续兼容历史调用', () => {
  assert.equal(_test.isFourLevelCategory({ level: 4 }), true);
  assert.equal(_test.isFourLevelCategory({ level: 3 }), false);
  assert.equal(_test.isFourLevelCategory(null), false);
});

test('分类字段优先使用当前分类及最近上级配置', () => {
  const lineage = [
    { category_id: 'L4', level: 4 },
    { category_id: 'L3', level: 3 },
    { category_id: 'L2', level: 2 },
    { category_id: 'L1', level: 1 }
  ];
  const fields = [
    { category_id: 'L1', field_key: 'brand' },
    { category_id: 'L1', field_key: 'series' },
    { category_id: 'L3', field_key: 'model' }
  ];

  const resolved = _test.selectNearestCategoryFields(lineage, fields);
  assert.equal(resolved.sourceCategory.category_id, 'L3');
  assert.deepEqual(resolved.sourceFields.map(field => field.field_key), ['model']);
  assert.equal(resolved.ownFields.length, 0);
});

test('商品名称分类前缀使用第2到第4级，不包含第1级', () => {
  const prefix = _test.getCategoryNamePrefix([
    { category_id: 'L4', name: '游戏本' },
    { category_id: 'L3', name: 'ThinkPad' },
    { category_id: 'L2', name: '联想' },
    { category_id: 'L1', name: '笔记本' }
  ]);
  assert.deepEqual(prefix, ['联想', 'ThinkPad', '游戏本']);
});

test('商品默认名称按二级、三级、四级和其他字段使用空格拼接', () => {
  assert.equal(_test.composeProductName(
    { brand: '联想', series: '拯救者', model: 'R9000P' },
    [{ field_key: '内存' }, { field_key: '颜色' }],
    { 内存: '32G', 颜色: '黑色' }
  ), '联想 拯救者 R9000P 32G 黑色');
  assert.equal(_test.composeProductName(
    { brand: '', series: '手工系列', model: '手工型号' },
    [],
    {}
  ), '手工系列 手工型号');
});

test('商品分类树层级映射为分类、品牌、系列、型号', () => {
  const dimensions = _test.categoryDimensionsFromLineage([
    { category_id: 'L4', level: 4, name: 'R9000P' },
    { category_id: 'L3', level: 3, name: '拯救者' },
    { category_id: 'L2', level: 2, name: '联想' },
    { category_id: 'L1', level: 1, name: '笔记本' }
  ]);
  assert.deepEqual(dimensions, {
    category: '笔记本',
    brand: '联想',
    series: '拯救者',
    model: 'R9000P'
  });
});
