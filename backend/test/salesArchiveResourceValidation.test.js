const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const salesController = require('../src/modules/sales/controller');

function buildTransaction() {
  return { LOCK: { UPDATE: 'UPDATE' } };
}

function buildItem(overrides = {}) {
  return {
    item_id: 1,
    sn_id: 'SN_1',
    sn_code: 'SN001',
    product_id: 'PRODUCT_1',
    product_name: '测试商品',
    use_gov_subsidy: 1,
    selected_resource_types: '["GOV_SUBSIDY"]',
    ...overrides
  };
}

test('归档前缺少已选择的国补资格时直接阻止锁定和审批', async () => {
  const originals = {
    categoryFindOne: models.ResourceCategory.findOne,
    rightFindOne: models.InventoryResourceRight.findOne
  };
  models.ResourceCategory.findOne = async () => ({
    category_code: 'GOV_SUBSIDY',
    name: '国补资格',
    supports_sale_use: 1
  });
  models.InventoryResourceRight.findOne = async () => null;

  try {
    await assert.rejects(
      salesController._test.lockSaleRights(
        { order_id: 'ORDER_1', order_no: 'SO001', create_user: '测试员' },
        [buildItem()],
        buildTransaction()
      ),
      error => error.status === 409 && error.message === 'SN SN001 的国补资格不可用'
    );
  } finally {
    models.ResourceCategory.findOne = originals.categoryFindOne;
    models.InventoryResourceRight.findOne = originals.rightFindOne;
  }
});

test('归档前校验通过后锁定国补资格，审批期间保持占用', async () => {
  const originals = {
    categoryFindOne: models.ResourceCategory.findOne,
    rightFindOne: models.InventoryResourceRight.findOne,
    changeCreate: models.ResourceRightChangeOrder.create
  };
  const right = {
    current_status: 'AVAILABLE',
    locked_source_type: null,
    locked_source_id: null,
    version: 0,
    amount: 479.85,
    update: async values => Object.assign(right, values)
  };
  let changeRow = null;
  models.ResourceCategory.findOne = async () => ({
    category_code: 'GOV_SUBSIDY',
    name: '国补资格',
    supports_sale_use: 1
  });
  models.InventoryResourceRight.findOne = async () => right;
  models.ResourceRightChangeOrder.create = async values => {
    changeRow = values;
    return values;
  };

  try {
    await salesController._test.lockSaleRights(
      { order_id: 'ORDER_1', order_no: 'SO001', create_user: '测试员' },
      [buildItem()],
      buildTransaction()
    );
    assert.equal(right.current_status, 'LOCKED');
    assert.equal(right.locked_source_type, 'SALE_ORDER');
    assert.equal(right.locked_source_id, 'ORDER_1');
    assert.equal(changeRow.before_status, 'AVAILABLE');
    assert.equal(changeRow.after_status, 'LOCKED');
    assert.equal(changeRow.related_sale_order_id, 'ORDER_1');
  } finally {
    models.ResourceCategory.findOne = originals.categoryFindOne;
    models.InventoryResourceRight.findOne = originals.rightFindOne;
    models.ResourceRightChangeOrder.create = originals.changeCreate;
  }
});

test('国补误挂在非SN商品时自动迁移到全单唯一有效SN商品', async () => {
  const invalidItem = buildItem({
    item_id: 1,
    sn_id: null,
    sn_code: '',
    product_name: 'Legion Y960 白色',
    update: async values => Object.assign(invalidItem, values)
  });
  const snItem = buildItem({
    item_id: 2,
    sn_id: 'SN_2',
    sn_code: 'PF5WZXGE',
    product_name: 'Legion Y9000P',
    use_gov_subsidy: 0,
    selected_resource_types: [],
    update: async values => Object.assign(snItem, values)
  });

  await salesController._test.alignOrderSubsidyRights(
    { national_subsidy: 1000, education_subsidy: 0 },
    [invalidItem, snItem],
    buildTransaction()
  );

  assert.equal(invalidItem.use_gov_subsidy, 0);
  assert.equal(invalidItem.selected_resource_types, '[]');
  assert.equal(snItem.use_gov_subsidy, 1);
  assert.equal(snItem.selected_resource_types, '["GOV_SUBSIDY"]');
});

test('国补误挂且存在多个有效SN时要求明确选择，不进行猜测', async () => {
  const invalidItem = buildItem({
    sn_id: null,
    sn_code: '',
    update: async values => Object.assign(invalidItem, values)
  });
  const snItems = ['SN_1', 'SN_2'].map((snId, index) => ({
    ...buildItem({ item_id: index + 2, sn_id: snId, sn_code: `CODE_${index + 1}`, use_gov_subsidy: 0, selected_resource_types: [] }),
    update: async () => {}
  }));

  await assert.rejects(
    salesController._test.alignOrderSubsidyRights(
      { national_subsidy: 1000, education_subsidy: 0 },
      [invalidItem, ...snItems],
      buildTransaction()
    ),
    error => error.status === 409 && error.message.includes('请明确选择使用资格的SN')
  );
});

test('非SN商品残留资源标记时锁定阶段给出明确错误', async () => {
  await assert.rejects(
    salesController._test.lockSaleRights(
      { order_id: 'ORDER_1', order_no: 'SO001' },
      [buildItem({ sn_id: null, sn_code: '', product_name: 'Legion Y960 白色' })],
      buildTransaction()
    ),
    error => error.status === 409 && error.message.includes('Legion Y960 白色') && error.message.includes('未绑定有效SN')
  );
});
