const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnCode, normalizeSnFields } = require('../src/utils/snCode');
const M = require('../src/models');
const { Op } = require('sequelize');

test('SN格式仅大写和去首尾空格，保留内部字符、空值及非SN字段', () => {
  assert.equal(normalizeSnCode('  ab c-12  '), 'AB C-12');
  assert.equal(normalizeSnCode(null), null);
  const body = { snCode: ' ab12 ', sn_id: ' id ', name: 'Li', items: [{ newSnCode: ' cd34 ', pnCode: ' pn ', received_sn_codes: '["ef56 "," gh78"]' }] };
  normalizeSnFields(body);
  assert.deepEqual(body, { snCode: 'AB12', sn_id: ' id ', name: 'Li', items: [{ newSnCode: 'CD34', pnCode: ' pn ', received_sn_codes: '["EF56","GH78"]' }] });
});

test('所有SN模型字段新增、批量构建和收货JSON列表统一保存大写', async () => {
  assert.equal(M.ProductSn.build({ sn_id: 'id', sn_code: ' ab12 ' }).sn_code, 'AB12');
  assert.equal(M.PurchaseRequestItem.build({ direct_inbound_sn_code: ' ab12 ' }).direct_inbound_sn_code, 'AB12');
  assert.equal(M.InboundItem.build({ received_sn_codes: '[" ab12 ","cd34"]' }).received_sn_codes, '["AB12","CD34"]');
  const options = { attributes: { sn_code: ' ef56 ' } };
  await M.ProductSn.runHooks('beforeBulkUpdate', options);
  assert.equal(options.attributes.sn_code, 'EF56');
});

test('ORM查询兼容历史大小写及首尾空格，保留SN ID、权限和逻辑操作符', async () => {
  const options = { where: { sn_id: 'record-id', store_id: 'STORE', [Op.or]: [{ sn_code: ' ab12 ' }, { sn_code: { [Op.like]: '%cd34%' } }] } };
  await M.ProductSn.runHooks('beforeFind', options);
  const sql = M.sequelize.getQueryInterface().queryGenerator.selectQuery(M.ProductSn.getTableName(), { ...options, model: M.ProductSn }, M.ProductSn);
  assert.match(sql, /UPPER\(TRIM/);
  assert.match(sql, /AB12/);
  assert.match(sql, /%CD34%/);
  assert.match(sql, /record-id/);
  assert.match(sql, /STORE/);
});

test('API中间件统一嵌套输入和查询条件，不更改SN ID或PN', async () => {
  const { snNormalization } = require('../src/middleware/snNormalization');
  const ctx = { query: { snCode: ' ab12 ', pnCode: ' pn ' }, request: { body: { items: [{ sn_code: ' cd34 ', sn_id: ' id ' }] } } };
  let called = false;
  await snNormalization(ctx, async () => { called = true; });
  assert.equal(called, true);
  assert.equal(ctx.query.snCode, 'AB12');
  assert.equal(ctx.query.pnCode, ' pn ');
  assert.equal(ctx.request.body.items[0].sn_code, 'CD34');
  assert.equal(ctx.request.body.items[0].sn_id, ' id ');
});
