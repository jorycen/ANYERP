const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { snTrace } = require('../src/modules/inventory/controller');

test('SN追踪统一匹配当前码、历史旧码及入库JSON明细，保留原单据权限', async t => {
  const hex = value => Buffer.from(value).toString('hex').toUpperCase();
  t.mock.method(sequelize, 'query', async (sql, options) => {
    const r = options.replacements;
    if (r.snCodeHex) {
      assert.equal(r.snCodeHex, hex('MP2TN2T4'));
      assert.match(sql, /UPPER\(TRIM\(sn_code\)\)/);
      assert.match(sql, /UPPER\(TRIM\(old_sn_code\)\)/);
      return [{ sn_id: 'SN-ID', sn_code: 'new-code', old_sn_code: 'mp2tn2t4' }];
    }
    if (sql.includes('FROM T_PURCHASE_REQUEST pr')) return [{ request_id: 'PR', request_no: 'PR001', store_id: 'STORE', apply_user: '甲', create_time: '2026-10-26 10:30:48' }];
    assert.ok(r.snCodesHex.includes(hex('MP2TN2T4')));
    assert.ok(r.snCodesHex.includes(hex('NEW-CODE')));
    assert.ok(r.snIdsHex.includes(hex('SN-ID')));
    if (sql.includes('FROM T_PRODUCT_SN sn')) {
      assert.match(sql, /UPPER\(TRIM\(sn.SN_CODE\)\)/);
      return [{ sn_id: 'SN-ID', sn_code: 'NEW-code', status: 'sold', store_id: 'STORE', product_name: '电脑' }];
    }
    if (sql.includes('FROM T_SN_LOG')) {
      assert.match(sql, /UPPER\(TRIM\(old_sn_code\)\)/);
      return [];
    }
    if (sql.includes('FROM T_INBOUND_ITEM ii')) {
      assert.match(sql, /UPPER\(TRIM\(ii.sn_code\)\)/);
      assert.match(sql, /JSON_TABLE/);
      assert.match(sql, /UPPER\(TRIM\(received_sn.sn_code\)\)/);
      return [{ inbound_id: 'IN', inbound_no: 'IN001', store_id: 'STORE', source_type: 'purchase', purchase_request_id: 'PR', create_user: '甲', receive_time: '2026-10-26 18:01:30' }];
    }
    if (sql.includes('FROM T_ORDER_ITEM oi')) {
      assert.match(sql, /UPPER\(TRIM\(oi.sn_code\)\)/);
      return [{ order_id: 'ORDER', order_no: 'ORD001', store_id: 'STORE', create_user: '甲', create_time: '2026-10-26 18:07:42' }];
    }
    if (sql.includes('FROM T_RETURN_STOCK_ITEM ri') || sql.includes('FROM T_TRANSFER_ITEM ti')) return [];
    throw new Error('Unexpected trace query');
  });
  for (const code of ['MP2TN2T4', 'mp2tn2t4', '  Mp2tN2t4  ']) {
    const ctx = { params: { snCode: code }, query: {}, state: { user: { roleCode: 'boss' } }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
    await snTrace(ctx);
    assert.equal(ctx.body.data.currentStatus, 'sold');
    assert.deepEqual(ctx.body.data.timeline.map(row=>row.ref_no), ['ORD001', 'IN001', 'PR001']);
    ctx.state.user = { roleCode: 'finance', accessibleStoreIds: ['OTHER'] };
    await snTrace(ctx);
    assert.deepEqual(ctx.body.data.timeline, []);
  }
});
