const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/purchase/controller');

test('采购单据流展示 PR、IN、PRA 及 PRA 到 IN 的行级关联', () => {
  const rows = _test.buildPurchaseDocumentRelations({
    request_id: 'request-id',
    request_no: 'PR202608020258357847',
    status: 'approved',
    total_amount: 77754,
    create_time: '2026-08-02T02:58:35.000Z',
    items: [{ product_id: 'product-id', product_name: '拯救者 Y7000P', quantity: 6 }],
    Inbounds: [
      {
        inbound_id: 'inbound-1', inbound_no: 'IN202608020332134212', status: 'cancelled',
        total_quantity: 0, items: [{ product_name: '拯救者 Y7000P', quantity: 0 }]
      },
      {
        inbound_id: 'inbound-2', inbound_no: 'IN202608020332138894', status: 'cancelled',
        total_quantity: 0, items: [{ product_name: '拯救者 Y7000P', quantity: 0 }]
      }
    ],
    adjustments: [{
      adjustment_id: 'adjustment-id',
      adjustment_no: 'PRA2026082870384',
      total_quantity_delta: -4,
      total_amount_delta: -51836,
      status: 'completed',
      create_user: '郑雪莉',
      items: [
        { item_id: 28, inbound_id: 'inbound-1', product_name: '拯救者 Y7000P', quantity_delta: -2, amount_delta: -25918, remark: 'pending_cancel' },
        { item_id: 29, inbound_id: 'inbound-2', product_name: '拯救者 Y7000P', quantity_delta: -2, amount_delta: -25918, remark: 'pending_cancel' }
      ]
    }]
  });

  const adjustment = rows.find(row => row.document_type === 'purchase_adjustment');
  assert.equal(adjustment.document_no, 'PRA2026082870384');
  assert.equal(adjustment.upstream_no, 'PR202608020258357847');

  const links = rows.filter(row => row.document_type === 'adjustment_inbound_link');
  assert.deepEqual(links.map(row => [row.upstream_no, row.document_no, row.quantity, row.business_action]), [
    ['PRA2026082870384', 'IN202608020332134212', -2, '取消待入库'],
    ['PRA2026082870384', 'IN202608020332138894', -2, '取消待入库']
  ]);
});

test('采购单据流区分取消待入库与已入库后退库', () => {
  assert.deepEqual(_test.purchaseAdjustmentOperation('pending_cancel'), {
    code: 'pending_cancel', name: '取消待入库'
  });
  assert.deepEqual(_test.purchaseAdjustmentOperation('stock_return:RET20260001'), {
    code: 'stock_return', name: '已入库后退库'
  });
});
