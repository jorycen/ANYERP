const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const sales = require('../src/modules/sales/controller');
const router = require('../src/modules/sales/routes');
const { storeAccessMiddleware } = require('../src/middleware/auth');
function context(query = {}, roles = ['mall_report_viewer']) {
  return { query, params: { orderId: 'ORDER-1' }, state: { user: { roles, accessibleStoreIds: ['STORE-1'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
}
test('查询列表和跨页汇总使用相同已上报门店范围，不能用参数取消限制', async t => {
  t.mock.method(models.Store, 'findAll', async options => {
    assert.deepEqual(options.where.store_id, ['STORE-1']);
    return [{ store_id: 'STORE-1', name: '门店一' }];
  });
  t.mock.method(models.Order, 'findAll', async options => {
    assert.equal(options.where.mall_report_status, 'reported');
    assert.deepEqual(options.where.store_id, ['STORE-1']);
    assert.equal(options.where.is_deleted, 0);
    return [{ order_id: '1', total_amount: '100.10', actual_payment: '90.10' },
      { order_id: '2', total_amount: '200.20', actual_payment: '180.20' }];
  });
  const ctx = context({ onlyReportedToMall: 'false', page: 2, pageSize: 1 });
  await sales.list(ctx);
  assert.equal(ctx.body.list.length, 1);
  assert.equal(ctx.body.list[0].order_id, '2');
  assert.deepEqual(ctx.body.summary, { orderCount: 2, totalAmount: 300.3, actualPayment: 270.3 });
  assert.equal(ctx.body.storeOptions[0].store_id, 'STORE-1');
  const mixed = context({}, ['mall_report_viewer', 'finance']);
  await sales.list(mixed);
});
test('未授权门店和空门店范围不能查询订单', async t => {
  t.mock.method(models.Order, 'findAll', () => { throw new Error('不应访问订单'); });
  await assert.rejects(() => sales.list(context({ storeId: 'STORE-2' })), { status: 403 });
  const ctx = context();
  ctx.state.user.accessibleStoreIds = [];
  await sales.list(ctx);
  assert.deepEqual(ctx.body.list, []);
  assert.equal(ctx.body.total, 0);
});
test('详情与追踪入口拒绝未上报、其他门店和已删除订单，包括混合角色', async t => {
  for (const roles of [['mall_report_viewer'], ['mall_report_viewer', 'finance']]) {
    for (const [order, status] of [
      [{ store_id: 'STORE-1', mall_report_status: null }, 404],
      [{ store_id: 'STORE-2', mall_report_status: 'reported' }, 403],
      [{ store_id: 'STORE-1', mall_report_status: 'reported', is_deleted: 1 }, 404]
    ]) {
      const mock = t.mock.method(models.Order, 'findByPk', async () => order);
      await assert.rejects(() => sales.detail(context({ trace: '1' }, roles)), { status });
      mock.mock.restore();
    }
  }
});
test('所有非列表/详情销售路由均拒绝查询账号，普通店长不受影响', async () => {
  for (const layer of router.stack) {
    if (layer.stack.includes(sales.list) || layer.stack.includes(sales.detail)) continue;
    await assert.rejects(() => layer.stack[0](context(), () => assert.fail(layer.path)), { status: 403 });
    let passed = false;
    await layer.stack[0](context({}, ['manager']), () => { passed = true; });
    assert.equal(passed, true, layer.path);
  }
});
test('查询账号不能写入业务或访问普通报表、库存', async () => {
  for (const [method, path] of [['PUT', '/api/v1/sales/ORDER-1'], ['POST', '/api/v1/sales/create'],
    ['DELETE', '/api/v1/sales/draft/ORDER-1'], ['GET', '/api/v1/report/sales'], ['GET', '/api/v1/inventory/list']]) {
    const ctx = Object.assign(context(), { method, path });
    await assert.rejects(() => storeAccessMiddleware(ctx, () => assert.fail(path)), { status: 403 });
  }
});
