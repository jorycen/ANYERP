const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { assertSingleSnProductPn } = require('../src/utils/productPn');
const models = require('../src/models');
const {
  syncProductPnsMaster,
  syncCurrentSnPnCode
} = require('../src/utils/productPnMaster');

test('SN商品只能绑定一个PN，并拒绝不一致的入库PN', () => {
  assert.equal(
    assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD'],
      requestedCode: '83f40007cd'
    }),
    '83F40007CD'
  );

  assert.throws(
    () => assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD'],
      requestedCode: '83F60002CD'
    }),
    error => error.code === 'SN_PRODUCT_PN_MISMATCH'
  );

  assert.throws(
    () => assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD', '83F60002CD']
    }),
    error => error.code === 'SN_PRODUCT_PN_NOT_UNIQUE'
  );
});

test('非SN商品允许同一商品编码维护多个PN', () => {
  assert.equal(
    assertSingleSnProductPn({
      needSn: 0,
      productCode: 'SP00001',
      configuredCodes: ['PN-A', 'PN-B'],
      requestedCode: 'PN-C'
    }),
    'PN-C'
  );
});

test('商品PN修改时沿用pn_id并同步当前SN的PN缓存', async () => {
  const originals = {
    productFindByPk: models.Product.findByPk,
    productPnFindAll: models.ProductPn.findAll,
    productPnUpdate: models.ProductPn.update,
    productSnFindAll: models.ProductSn.findAll,
    snLogCreate: models.SnLog.create
  };
  const pnRecord = {
    pn_id: 'PN_1',
    product_id: 'PRODUCT_1',
    pn_code: 'OLD-PN',
    status: 1,
    is_deleted: 0,
    is_primary: 1,
    update: async values => Object.assign(pnRecord, values)
  };
  const snRecord = {
    sn_id: 'SN_1',
    sn_code: 'SN_1',
    pn_id: 'PN_1',
    pn_code: 'OLD-PN',
    product_id: 'PRODUCT_1',
    status: 'in_stock',
    store_id: 'STORE_1',
    update: async values => Object.assign(snRecord, values)
  };
  const logs = [];
  let pnFindAllCalls = 0;

  models.Product.findByPk = async () => ({
    product_id: 'PRODUCT_1',
    product_code: 'SP00001',
    name: '测试商品',
    need_sn: 1
  });
  models.ProductPn.findAll = async () => {
    pnFindAllCalls += 1;
    return pnFindAllCalls === 1 ? [pnRecord] : [];
  };
  models.ProductPn.update = async () => [0];
  models.ProductSn.findAll = async () => [snRecord];
  models.SnLog.create = async log => {
    logs.push(log);
    return log;
  };

  try {
    const synced = await syncProductPnsMaster({
      productId: 'PRODUCT_1',
      pns: [{ pnId: 'PN_1', pnCode: 'NEW-PN', isPrimary: true }],
      operatorName: '测试人员'
    });

    assert.equal(synced[0], pnRecord);
    assert.equal(pnRecord.pn_id, 'PN_1');
    assert.equal(pnRecord.pn_code, 'NEW-PN');
    assert.equal(snRecord.pn_code, 'NEW-PN');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'pn_updated');
    assert.equal(logs[0].remark, '商品PN由 OLD-PN 修改为 NEW-PN');
    assert.equal(logs[0].create_user, '测试人员');
  } finally {
    models.Product.findByPk = originals.productFindByPk;
    models.ProductPn.findAll = originals.productPnFindAll;
    models.ProductPn.update = originals.productPnUpdate;
    models.ProductSn.findAll = originals.productSnFindAll;
    models.SnLog.create = originals.snLogCreate;
  }
});

test('商品PN修改不改写已销售SN的历史PN快照', async () => {
  const originals = {
    productFindByPk: models.Product.findByPk,
    productSnFindAll: models.ProductSn.findAll,
    snLogCreate: models.SnLog.create
  };
  const soldSn = {
    sn_id: 'SN_SOLD',
    sn_code: 'SN_SOLD',
    pn_code: 'OLD-PN',
    status: 'sold',
    update: async () => { throw new Error('已销售SN不应被同步'); }
  };
  let logCount = 0;
  models.Product.findByPk = async () => ({ name: '测试商品' });
  models.ProductSn.findAll = async options => {
    assert.deepEqual(options.where.status[Op.in], ['in_stock', 'reserved', 'occupied']);
    return [];
  };
  models.SnLog.create = async () => { logCount += 1; };

  try {
    const changed = await syncCurrentSnPnCode({
      productId: 'PRODUCT_1',
      pnId: 'PN_1',
      pnCode: 'NEW-PN'
    });
    assert.equal(changed, 0);
    assert.equal(soldSn.pn_code, 'OLD-PN');
    assert.equal(logCount, 0);
  } finally {
    models.Product.findByPk = originals.productFindByPk;
    models.ProductSn.findAll = originals.productSnFindAll;
    models.SnLog.create = originals.snLogCreate;
  }
});
