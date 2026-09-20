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

