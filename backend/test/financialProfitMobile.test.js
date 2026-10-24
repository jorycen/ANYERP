const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const C = require('../src/modules/report/financialProfitController');

test('小程序年月日筛选与后台显式期间使用相同范围且不扩大门店权限', async t => {
  t.mock.method(sequelize, 'query', async () => []);
  const context = query => ({ query, state: { user: { accessibleStoreIds: ['S'] } } });
  const month = await C.resolveFilters(context({ periodType: 'month', date: '2024-02-20', storeId: 'S' }));
  const web = await C.resolveFilters(context({ startDate: '2024-02-01', endDate: '2024-02-29', storeId: 'S' }));
  assert.deepEqual(month, web);
  const year = await C.resolveFilters(context({ periodType: 'year', date: '2026-10-25' }));
  assert.equal(year.startDate, '2026-01-01');
  assert.equal(year.endDate, '2026-12-31');
  const day = await C.resolveFilters(context({ periodType: 'day', date: '2026-10-25' }));
  assert.equal(day.startDate, day.endDate);
  await assert.rejects(C.resolveFilters(context({ periodType: 'month', date: '2026-10-25', storeId: 'OTHER' })), { status: 403 });
  await assert.rejects(C.resolveFilters(context({ periodType: 'day', date: '2026-02-30' })), { status: 400 });
});

test('公司标签只在完整公司范围显示，空范围金额仍按统一引擎返回', async t => {
  t.mock.method(sequelize, 'query', async sql => sql.includes('SELECT STORE_ID AS storeId FROM T_STORE') ? [{ storeId: 'S' }] : []);
  for (const [query, scope] of [[{}, '公司经营利润'], [{ storeId: 'S' }, '所选范围财务经营利润']]) {
    const ctx = { query: { ...query, startDate: '2026-10-01', endDate: '2026-10-31' }, state: { user: { accessibleStoreIds: ['*'] } } };
    await C.getFinancialProfitOrders(ctx);
    assert.equal(ctx.body.data.scopeLabel, scope);
    assert.equal(ctx.body.data.summary.operatingProfit, 0);
  }
});
