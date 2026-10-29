const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { resourceRewardDetail } = require('../src/modules/approval/resourceRewardDetail');
function fixture(t, origins) {
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => ({ sn_id: 'sn', sn_code: 'SERIAL', product_id: 'p', related_sale_order_id: 'o' }));
  t.mock.method(M.ProductSn, 'findByPk', async () => ({ pn_code: 'current-pn', supplier_name: 'current supplier' }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'o', order_no: 'SO1', archive_time: '2026-10-01' }));
  t.mock.method(M.OrderItem, 'findAll', async options => {
    assert.equal(options.where.order_id, 'o');
    assert.equal(options.where.product_id, 'p');
    return [{ product_name: 'machine', pn_code: 'frozen-pn', sn_code: 'SERIAL', supplier_name: 'frozen supplier' }];
  });
  t.mock.method(M.Product, 'findByPk', async () => ({ name: 'current name' }));
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    assert.equal(options.replacements.snId, 'sn');
    assert.equal(options.replacements.cutoff, '2026-10-01');
    assert.match(sql, /i.SOURCE_TYPE='purchase'/);
    assert.doesNotMatch(sql, /LIKE/);
    return origins;
  });
}
test('reward approval exposes original purchase source and frozen sale PN without cost amounts', async t => {
  fixture(t, [{ supplierName: 'original supplier', requestNo: 'PO1', inboundNo: 'IN1' }]);
  assert.deepEqual(await resourceRewardDetail('r'), { product_name: 'machine', pn_code: 'frozen-pn', sn_code: 'SERIAL',
    order_no: 'SO1', original_supplier_name: 'original supplier', original_purchase_no: 'PO1', original_inbound_no: 'IN1' });
});
test('missing purchase association keeps numbers unknown and uses order supplier snapshot', async t => {
  fixture(t, []);
  const result = await resourceRewardDetail('r');
  assert.equal(result.original_supplier_name, 'frozen supplier');
  assert.equal(result.original_purchase_no, '');
  assert.equal(result.original_inbound_no, '');
});
