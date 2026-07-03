const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const salesController = require('../src/modules/sales/controller');

const {
  normalizeOrderExtendedFields,
  isCancelStatus,
  reserveDepositForOrder,
  redeemReservedDepositsForOrder,
  releaseDepositRedemptionForOrder
} = salesController._test;

test('order extension fields preserve detail metadata from camelCase payloads', () => {
  const payload = normalizeOrderExtendedFields({
    customerSourceDetail: '短视频',
    auxiliarySalesList: [{ selected: '销售甲', staffId: 'STAFF_1' }],
    invoiceInfo: 'CLOUD_PAY_001',
    invoiceAmount: '1999.00',
    subsidyPhotos: [{ name: '产品及包装盒', url: 'cloud://subsidy.jpg' }],
    productPhotoUrls: ['cloud://product.jpg'],
    educationSubsidyPhotoUrl: 'cloud://education.jpg',
    personalInfoPhoto: { name: '个人资料', url: 'cloud://personal.jpg' }
  });

  assert.equal(payload.customer_source_detail, '短视频');
  assert.equal(payload.auxiliary_sales_list[0].staffId, 'STAFF_1');
  assert.equal(payload.invoice_info, 'CLOUD_PAY_001');
  assert.equal(payload.invoice_amount, 1999);
  assert.equal(payload.subsidy_photos[0].url, 'cloud://subsidy.jpg');
  assert.deepEqual(payload.product_photo_urls, ['cloud://product.jpg']);
  assert.equal(payload.education_subsidy_photo_url, 'cloud://education.jpg');
  assert.equal(payload.personal_info_photo.url, 'cloud://personal.jpg');
});

test('frontend void status is recognized', () => {
  assert.equal(isCancelStatus('已作废'), true);
  assert.equal(isCancelStatus('voided'), true);
});

test('deposit changes from available to occupied, redeemed, then available after void', async () => {
  const originals = {
    redemptionCreate: models.DepositRedemption.create,
    redemptionFindAll: models.DepositRedemption.findAll,
    depositFindByPk: models.DepositOrder.findByPk
  };
  const deposit = {
    deposit_id: 'DEP_1',
    status: 'available',
    redeemed_amount: 0,
    related_order_id: null,
    related_order_no: null,
    async update(values) {
      Object.assign(this, values);
    }
  };
  const reservation = {
    redemption_id: 'RED_1',
    deposit_id: 'DEP_1',
    order_id: 'ORDER_1',
    order_no: 'SO001',
    amount: 500,
    status: 'reserved',
    async update(values) {
      Object.assign(this, values);
    }
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };

  models.DepositRedemption.create = async values => {
    Object.assign(reservation, values);
    return reservation;
  };
  models.DepositRedemption.findAll = async () => [reservation];
  models.DepositOrder.findByPk = async () => deposit;

  try {
    await reserveDepositForOrder({
      deposit,
      orderId: 'ORDER_1',
      orderNo: 'SO001',
      amount: 500,
      user: { staffId: 'STAFF_1', name: '销售甲' },
      transaction
    });
    assert.equal(deposit.status, 'occupied');
    assert.equal(deposit.redeemed_amount, 0);
    assert.equal(reservation.status, 'reserved');

    await redeemReservedDepositsForOrder({
      order_id: 'ORDER_1',
      order_no: 'SO001'
    }, transaction);
    assert.equal(deposit.status, 'redeemed');
    assert.equal(deposit.redeemed_amount, 500);
    assert.equal(reservation.status, 'redeemed');

    await releaseDepositRedemptionForOrder({
      order_id: 'ORDER_1',
      order_no: 'SO001'
    }, transaction, '订单作废');
    assert.equal(deposit.status, 'available');
    assert.equal(deposit.redeemed_amount, 0);
    assert.equal(deposit.related_order_id, null);
    assert.equal(reservation.status, 'voided');
  } finally {
    models.DepositRedemption.create = originals.redemptionCreate;
    models.DepositRedemption.findAll = originals.redemptionFindAll;
    models.DepositOrder.findByPk = originals.depositFindByPk;
  }
});
