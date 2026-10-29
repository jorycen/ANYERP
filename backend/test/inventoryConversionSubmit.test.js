const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const pnMaster = require('../src/utils/productPnMaster');
const balance = require('../src/modules/inventory/serializedInventoryBalance');

function fixture(t, { sourceSn = true, targetSn = true, failTarget = false, sourceCost = 1 } = {}) {
  const state = { committed: false, rolledBack: false, conversions: [], items: [], snLogs: [], newSns: [], inventory: [] };
  const tx = { LOCK: { UPDATE: 'UPDATE' }, async commit() { state.committed = true; }, async rollback() {
    state.rolledBack = true; state.conversions.length = 0; state.items.length = 0;
    state.snLogs.length = 0; state.newSns.length = 0; state.inventory.length = 0;
    Object.assign(source, { inbound_price: sourceCost, status: 'in_stock' });
  } };
  const source = { sn_id: 'SOURCE-SN', sn_code: 'FPT9TX1', pn_code: 'SOURCE-PN', product_id: 'SOURCE',
    store_id: 'STORE', inventory_type: 'normal_qty', inbound_price: sourceCost, status: 'in_stock',
    async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); } };
  const products = {
    SOURCE: { product_id: 'SOURCE', name: '二手一体机', need_sn: sourceSn ? 1 : 0, manufacturer_code: 'SOURCE-PN', status: 1 },
    TARGET: { product_id: 'TARGET', name: 'DDR4内存', need_sn: targetSn ? 1 : 0, manufacturer_code: 'TARGET-PN', status: 1 }
  };
  t.mock.method(M.sequelize, 'transaction', async () => tx);
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    assert.equal(options.transaction, tx);
    if (sql.includes('FROM T_PRODUCT_SN')) return [{ snId: source.sn_id,
      location_id: 'SOURCE-LOCATION', store_id: 'STORE', type: 'normal_qty', status: 1 }];
    if (sql.includes('FROM T_SN_LOG') || sql.includes('FROM T_INVENTORY_BATCH_APPLICATION_ITEM')
      || sql.includes('FROM T_PURCHASE_REQUEST_ITEM')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
  t.mock.method(M.Store, 'findByPk', async () => ({ store_id: 'STORE' }));
  t.mock.method(M.Product, 'findOne', async options => products[options.where.product_id]);
  t.mock.method(M.Product, 'findAll', async () => Object.values(products));
  t.mock.method(M.ProductPn, 'findAll', async options => [{ pn_code: products[options.where.product_id]?.manufacturer_code }]);
  t.mock.method(M.ProductPrice, 'findOne', async () => ({ cost_price: sourceCost }));
  t.mock.method(M.ProductSn, 'findOne', async options => options.where.product_id === 'SOURCE' ? source : null);
  t.mock.method(M.ProductSn, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.newSns.push(value); return value; });
  t.mock.method(pnMaster, 'ensureProductPnMaster', async options => { assert.equal(options.transaction, tx); return { pn_id: 'TARGET-PN-ID' }; });
  t.mock.method(balance, 'syncSerializedInventoryBalance', async options => { assert.equal(options.transaction, tx); });
  t.mock.method(M.InventoryConversion, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.conversions.push(value); return value; });
  t.mock.method(M.InventoryConversionItem, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.items.push(value); return value; });
  t.mock.method(M.SnLog, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.snLogs.push(value); return value; });
  t.mock.method(M.Inventory, 'findAll', async () => [{ normal_qty: 1, async update(patch, options) { assert.equal(options.transaction, tx); state.inventory.push(patch); } }]);
  t.mock.method(M.Location, 'findOne', async () => ({ location_id: 'NORMAL' }));
  t.mock.method(M.Inventory, 'findOne', async () => ({ normal_qty: 1, async update(patch, options) { assert.equal(options.transaction, tx); state.inventory.push(patch); } }));
  if (failTarget) t.mock.method(M.ProductSn, 'create', async () => { throw Object.assign(new Error('测试目标写入失败'), { status: 409 }); });
  // Capture dependency mocks for this controller instance only; no real database access.
  delete require.cache[require.resolve('../src/modules/inventory/controller')];
  const controller = require('../src/modules/inventory/controller');
  const ctx = { state: { user: { name: '测试操作人', staffId: 7, accessibleStoreIds: ['STORE'] } },
    request: { body: { conversionType: 'split', storeId: 'STORE', remark: '故障机，内存拆出来使用',
      sourceItems: [{ productId: 'SOURCE', pnCode: 'SOURCE-PN', snId: sourceSn ? 'SOURCE-SN' : undefined, snCode: sourceSn ? 'FPT9TX1' : '', quantity: 1, unitCost: 1 }],
      targetItems: [{ productId: 'TARGET', pnCode: 'TARGET-PN', snCode: '20261027', quantity: 1, unitCost: 1, totalCost: 1 }] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  return { state, ctx, source, controller, products };
}

test('截图场景：SN整机成本1元拆出SN内存1元，原SN保持在库且剩余成本0，双端日志和单据提交成功', async t => {
  const f = fixture(t);
  await f.controller.createConversion(f.ctx);
  assert.equal(f.ctx.body.code, 0); assert.equal(f.state.committed, true); assert.equal(f.state.rolledBack, false);
  assert.equal(f.source.inbound_price, 0); assert.equal(f.source.status, 'in_stock');
  assert.equal(f.state.conversions[0].total_source_cost, 1); assert.equal(f.state.conversions[0].total_target_cost, 1);
  assert.deepEqual(f.state.snLogs.map(row => row.action), ['inventory_split_source', 'inventory_split_target']);
  assert.ok(f.state.snLogs.every(row => row.create_user === '测试操作人'));
  assert.equal(f.state.newSns[0].inbound_price, 1);
  assert.equal(f.state.newSns[0].location_id, 'NORMAL');
  assert.equal(f.state.items.find(row => row.line_role === 'target').location_id, 'NORMAL');
  assert.equal(f.state.items.find(row => row.line_role === 'target').source_sn_id, 'SOURCE-SN');
});

test('特殊仓来源不能通过拆分绕过采购，整单无副作用', async t => {
  const f = fixture(t);
  f.source.inventory_type = 'rental_demo_qty';
  await assert.rejects(f.controller.createConversion(f.ctx), /须完成采购转换/);
  assert.equal(f.state.committed, false);
  assert.equal(f.state.rolledBack, true);
  assert.equal(f.state.conversions.length, 0);
  assert.equal(f.state.newSns.length, 0);
  assert.equal(f.source.inbound_price, 1);
});

test('目标未传库位时在创建SN前解析本店销售仓，无可用仓位时整单拒绝', async t => {
  const f = fixture(t);
  t.mock.method(M.Location, 'findOne', async options => {
    assert.equal(options.where.store_id, 'STORE');
    assert.equal(options.where.type, 'normal_qty');
    assert.equal(options.where.status, 1);
    return null;
  });
  await assert.rejects(f.controller.createConversion(f.ctx), /本门店的有效库位/);
  assert.equal(f.state.newSns.length, 0);
  assert.equal(f.state.conversions.length, 0);
  assert.equal(f.state.rolledBack, true);
});

test('非SN目标也保存后台确认的库位，明确库位须按本店启用范围校验', async t => {
  const f = fixture(t, { targetSn: false });
  f.ctx.request.body.targetItems[0].locationId = 'EXPLICIT';
  t.mock.method(M.Location, 'findOne', async options => {
    assert.equal(options.where.store_id, 'STORE');
    assert.equal(options.where.status, 1);
    assert.equal(options.where.location_id, 'EXPLICIT');
    return { location_id: 'EXPLICIT' };
  });
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.items.find(row => row.line_role === 'target').location_id, 'EXPLICIT');
  assert.equal(f.state.committed, true);
});
test('非SN来源组装为SN成品时也可记录目标操作人并提交', async t => {
  const f = fixture(t, { sourceSn: false }); f.ctx.request.body.conversionType = 'assemble';
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.committed, true); assert.equal(f.state.snLogs[0].action, 'inventory_assemble_target');
  assert.equal(f.state.snLogs[0].create_user, '测试操作人');
});
test('目标SN写入失败时整单回滚，不留下来源成本变更和已完成拆分单', async t => {
  const f = fixture(t, { failTarget: true });
  await assert.rejects(f.controller.createConversion(f.ctx), /测试目标写入失败/);
  assert.equal(f.state.committed, false); assert.equal(f.state.rolledBack, true);
  assert.equal(f.source.inbound_price, 1); assert.equal(f.state.conversions.length, 0); assert.equal(f.state.snLogs.length, 0);
});
test('拆出金额超过来源成本仍拒绝，修复不放宽原成本守恒校验', async t => {
  const f = fixture(t); Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 2, totalCost: 2 });
  await assert.rejects(f.controller.createConversion(f.ctx), /不能超过/);
  assert.equal(f.state.committed, false); assert.equal(f.state.rolledBack, true); assert.equal(f.source.inbound_price, 1);
});

test('SN及非SN零成本组件均允许组装0成本成品，忽略伪造来源成本', async t => {
  for (const sourceSn of [true, false]) await t.test(sourceSn ? 'SN' : '非SN', async sub => {
    const f = fixture(sub, { sourceSn, sourceCost: 0 });
    f.ctx.request.body.conversionType = 'assemble';
    f.ctx.request.body.sourceItems[0].unitCost = 999;
    Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 0, totalCost: 0 });
    await f.controller.createConversion(f.ctx);
    assert.equal(f.state.committed, true);
    assert.equal(f.state.conversions[0].total_source_cost, 0);
    assert.equal(f.state.conversions[0].total_target_cost, 0);
    assert.equal(f.state.items.find(row => row.line_role === 'source').unit_cost, 0);
    assert.equal(f.state.newSns[0].inbound_price, 0);
    if (sourceSn) assert.equal(f.source.status, 'assembled');
  });
});
test('非SN来源成本使用后台保存值，不接受客户端手工更改', async t => {
  const f = fixture(t, { sourceSn: false, sourceCost: 1 });
  f.ctx.request.body.conversionType = 'assemble'; f.ctx.request.body.sourceItems[0].unitCost = 999;
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.conversions[0].total_source_cost, 1);
});
test('成本缺失不能由客户端0元或正值填补，来源及目标数量0不能变成1', async t => {
  for (const sourceSn of [true, false]) await t.test(sourceSn ? 'SN成本缺失' : '非SN成本缺失', async sub => {
    const f = fixture(sub, { sourceSn, sourceCost: null }); f.ctx.request.body.conversionType = 'assemble';
    await assert.rejects(f.controller.createConversion(f.ctx), /成本待补/); assert.equal(f.state.committed, false);
  });
  for (const side of ['sourceItems', 'targetItems']) await t.test(side, async sub => {
    const f = fixture(sub); f.ctx.request.body.conversionType = 'assemble'; f.ctx.request.body[side][0].quantity = 0;
    await assert.rejects(f.controller.createConversion(f.ctx), /数量必须/); assert.equal(f.state.committed, false);
  });
});
test('零成本组件与有价组件混合时按原成本合计校验，不允许增加组装成本', async t => {
  const f = fixture(t, { sourceCost: 0 }); f.ctx.request.body.conversionType = 'assemble';
  f.products.EXTRA = { product_id: 'EXTRA', name: '有价组件', need_sn: 0, status: 1 };
  t.mock.method(M.ProductPrice, 'findOne', async () => ({ cost_price: 25 }));
  f.ctx.request.body.sourceItems.push({ productId: 'EXTRA', quantity: 1, unitCost: 999 });
  Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 25, totalCost: 25 });
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.conversions[0].total_source_cost, 25); assert.equal(f.state.conversions[0].total_target_cost, 25);
});
test('页面添加组装来源时使用API成本，零元可添加、缺失及零数量明确拦截', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const view = fs.readFileSync(path.resolve(__dirname, '../../frontend/web/src/views/Inventory.vue'), 'utf8');
  const formatter = view.slice(view.indexOf('const displayedConversionSourceCost ='), view.indexOf('\n', view.indexOf('const displayedConversionSourceCost =')));
  const add = view.slice(view.indexOf('const addConversionSourceItem ='), view.indexOf('const addConversionTargetItem ='));
  for (const [cost, quantity, expected] of [[0, 1, true], [null, 1, false], [0, 0, false]]) {
    const messages = [], sandbox = { Number, Math, roundMoney: value => Math.round(Number(value) * 100) / 100,
      selectedConversionSourceProduct: { value: { product_id: 'P', need_sn: 0, conversion_source_unit_cost: cost, normal_qty: 5 } },
      conversionForm: { conversionType: 'assemble', sourceItems: [] }, conversionSourceAdd: { productId: 'P', quantity, unitCost: 999 },
      conversionSourceSnOptions: { value: [] }, conversionPicker: { value: '' }, ElMessage: { warning: value => messages.push(value) } };
    vm.runInNewContext(formatter + '\n' + add + '\naddConversionSourceItem();', sandbox);
    assert.equal(sandbox.conversionForm.sourceItems.length, expected ? 1 : 0);
    if (expected) assert.equal(sandbox.conversionForm.sourceItems[0].unitCost, 0);
    else assert.equal(messages.length, 1);
  }
});

test('单一组装成品自动承接100元主机与1元组件成本，忽略手工成品成本', async t => {
  const f = fixture(t, { sourceSn: false, targetSn: false, sourceCost: 100 });
  f.ctx.request.body.conversionType = 'assemble';
  f.products.EXTRA = { product_id: 'EXTRA', name: '内存组件', need_sn: 0, status: 1 };
  t.mock.method(M.ProductPrice, 'findOne', async options => ({ cost_price: options.where.product_id === 'EXTRA' ? 1 : 100 }));
  f.ctx.request.body.sourceItems.push({ productId: 'EXTRA', quantity: 1 });
  Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 0, totalCost: 0 });
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.conversions[0].total_source_cost, 101);
  assert.equal(f.state.conversions[0].total_target_cost, 101);
  const target = f.state.items.find(row => row.line_role === 'target');
  assert.equal(target.unit_cost, 101);
  assert.equal(target.total_cost, 101);
});

test('预览无业务写入，正式提交重新读取当前成本并加上服务成本', async t => {
  const f = fixture(t, { sourceCost: 100 });
  f.ctx.request.body.conversionType = 'assemble';
  f.ctx.request.body.serviceCost = 20;
  Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 9999, totalCost: 9999 });
  await f.controller.previewConversion(f.ctx);
  assert.equal(f.ctx.body.data.targetTotal, 120);
  assert.equal(f.state.committed, false);
  assert.equal(f.state.conversions.length, 0);
  assert.equal(f.source.inbound_price, 100);
  f.source.inbound_price = 105;
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.conversions[0].total_target_cost, 125);
  assert.equal(f.state.newSns[0].inbound_price, 125);
});

test('单一非SN成品多件时保留合计并按数量换算单价，多成品仍须分配守恒', async t => {
  const f = fixture(t, { sourceCost: 100, targetSn: false });
  f.ctx.request.body.conversionType = 'assemble';
  Object.assign(f.ctx.request.body.targetItems[0], { quantity: 3, unitCost: 0, totalCost: 0 });
  await f.controller.createConversion(f.ctx);
  const target = f.state.items.find(row=>row.line_role==='target');
  assert.equal(target.unit_cost, 33.33);
  assert.equal(target.total_cost, 100);
  f.ctx.request.body.targetItems.push({ ...f.ctx.request.body.targetItems[0] });
  await assert.rejects(f.controller.createConversion(f.ctx), /成本不守恒/);
});

test('页面成本核算忽略过期响应，失败明确阻止提交且可重新核算', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const view = fs.readFileSync(path.resolve(__dirname, '../../frontend/web/src/views/Inventory.vue'), 'utf8');
  const start = view.indexOf('watch(() => JSON.stringify({');
  const code = view.slice(start, view.indexOf('onMounted(async', start));
  const requests = [];
  let callback;
  const ctx = { conversionDialogVisible: { value: true }, conversionAutomaticTarget: { value: true },
    conversionPreviewRefresh: { value: 0 }, conversionForm: { storeId: 'STORE', serviceCost: 0, sourceItems: [{}], targetItems: [{}] },
    conversionCostPreview: { value: null }, conversionPreviewError: { value: '' }, conversionPreviewLoading: { value: false },
    conversionPreviewSequence: 0, watch: (_, cb) => { callback = cb; },
    api: { previewConversion: () => new Promise((resolve, reject) => requests.push({resolve,reject})) } };
  vm.runInNewContext(code, ctx);
  let cleanup;
  const first = callback('', '', fn=>{cleanup=fn;});
  assert.equal(ctx.conversionPreviewLoading.value, true);
  assert.equal(ctx.conversionCostPreview.value, null);
  cleanup();
  const second = callback('', '', () => {});
  const result = cost => ({code:0,data:{automaticTargetCost:true,targetTotal:cost,sourceItems:[{unitCost:cost,totalCost:cost}],targetItems:[{unitCost:cost,totalCost:cost}]}});
  requests[1].resolve(result(120)); await second;
  requests[0].resolve(result(101)); await first;
  assert.equal(ctx.conversionForm.targetItems[0].totalCost, 120);
  const failed = callback('', '', () => {});
  requests[2].reject(new Error('成本核算失败')); await failed;
  assert.equal(ctx.conversionCostPreview.value, null);
  assert.equal(ctx.conversionPreviewError.value, '成本核算失败');
  assert.match(view, /conversionPreviewRefresh \+= 1/);
});
