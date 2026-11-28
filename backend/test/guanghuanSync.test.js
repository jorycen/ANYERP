const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reportOrder,
  buildPayload,
  buildRequestData,
  createSignature,
  formatRequestTimestamp,
  formatOrderTime,
  paymentMethodCode,
  parseMallResponse
} = require('../src/modules/sales/guanghuanClient');

const config = {
  storeId: 'D0218911', mallCode: 'MALL', storeCode: 'STORE', tillId: '01', checkCode: 'CHECK',
  appSubId: 'SUB', appToken: 'TOKEN', apiId: 'order.collect', apiVersion: '1.0.0',
  signMethod: 'md5', format: 'json', partnerId: 'PARTNER', sysId: 'SYS', appPubId: 'PUB',
  signKey: 'secret', baseUrl: 'https://example.test/order', timeoutMs: 100
};

const order = {
  order_no: 'ORD001', store_id: 'D0218911', create_staff_id: 12,
  customer_phone: '13800000000', total_amount: '6999.00',
  submit_time: new Date('2026-09-05T16:01:02.000Z'),
  OrderItems: [{ pn_code: 'PN001', sale_price: '6999.00', quantity: 1 }],
  OrderPayments: [
    { payment_method: '微信', amount: '1000.00', payment_time: new Date('2026-09-05T16:02:03.000Z') },
    { payment_method: '国补POS（电脑）-客户实收', amount: '5999.00', payment_time: new Date('2026-09-05T16:03:04.000Z') }
  ]
};

test('光环签名按 ASCII 排序并在密钥前保留 &', () => {
  assert.equal(
    createSignature({ Timestamp: 't', App: 'x' }, { x: '中' }, 'secret'),
    'D54801FE62B76396596FF5F3B85A6CF9'
  );
});

test('时间戳固定使用北京时间，不依赖服务器时区', () => {
  const date = new Date('2026-09-05T16:01:02.345Z');
  assert.equal(formatRequestTimestamp(date), '2026-09-06 00:01:02:345');
  assert.equal(formatOrderTime(date), '20260906000102');
});

test('销售订单映射为光环商品和支付明细', () => {
  const data = buildRequestData(order, config);
  assert.deepEqual(data.itemList, [{ itemCode: 'PN001', price: 6999, quantity: 1 }]);
  assert.deepEqual(data.payList.map(item => [item.paymentMethod, item.payAmt, item.time]), [
    ['WP', 1000, '20260906000203'],
    ['OT', 5999, '20260906000304']
  ]);
  assert.equal(data.time, '20260906000102');
  assert.equal(data.orderId, 'ORD001');
});

test('接口成功响应才会被判定为上报成功', () => {
  assert.equal(parseMallResponse({ RETURN_DATA: { header: { errcode: '0000', errmsg: 'OK' } } }).code, '0000');
  assert.throws(
    () => parseMallResponse({ RETURN_DATA: { header: { errcode: '1001', errmsg: '签名错误' } } }),
    /签名错误/
  );
});

test('网络错误重试一次，业务错误不重试', async () => {
  let networkAttempts = 0;
  const result = await reportOrder(order, {
    config,
    transport: async () => {
      networkAttempts += 1;
      if (networkAttempts === 1) {
        const error = new Error('reset');
        error.retryable = true;
        throw error;
      }
      return { RETURN_DATA: { header: { errcode: '0000' } } };
    }
  });
  assert.equal(result.code, '0000');
  assert.equal(networkAttempts, 2);

  let businessAttempts = 0;
  await assert.rejects(() => reportOrder(order, {
    config,
    transport: async () => {
      businessAttempts += 1;
      return { RETURN_DATA: { header: { errcode: '1001', errmsg: '业务拒绝' } } };
    }
  }), /业务拒绝/);
  assert.equal(businessAttempts, 1);
});

test('请求体包含规范要求的签名且不修改业务数据', () => {
  const payload = buildPayload(order, config, new Date('2026-09-05T16:00:00.000Z'));
  assert.match(payload.REQUEST.HRT_ATTRS.Sign, /^[A-F0-9]{32}$/);
  assert.equal(payload.REQUEST.HRT_ATTRS.Time_Stamp, '2026-09-06 00:00:00:000');
  assert.equal(paymentMethodCode('支付宝'), 'AP');
});
