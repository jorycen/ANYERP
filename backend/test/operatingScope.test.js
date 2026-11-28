const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const scope = require('../src/modules/report/operatingScope');
const dashboardDataSource = require('../src/modules/report/dashboardDataSource');

test('艾诺互调及其二级来源都属于经营统计排除范围', () => {
  assert.equal(scope.isInternalTransferSource('艾诺互调'), true);
  assert.equal(scope.isInternalTransferSource('艾诺互调 / 门店调货'), true);
  assert.equal(scope.isInternalTransferSource('普通零售'), false);
});

test('经营报表ORM条件保留空来源并排除艾诺互调', () => {
  const where = scope.appendOperatingSourceCondition({ is_deleted: 0 });
  const alternatives = where[Op.and][0][Op.or];
  assert.deepEqual(alternatives[0], { customer_source: null });
  assert.equal(alternatives[1].customer_source[Op.notLike], '艾诺互调%');
});

test('经营看板SQL统一排除艾诺互调', () => {
  const query = dashboardDataSource._test.buildSalesWhere(
    { storeIds: ['STORE-1'], archiveScope: 'archived' },
    { startAt: '2026-09-01', endAt: '2026-09-30' }
  );
  assert.match(query.sql, /CUSTOMER_SOURCE/);
  assert.match(query.sql, /NOT LIKE :internalTransferSource/);
  assert.equal(query.replacements.internalTransferSource, '艾诺互调%');
});

test('财务利润表不套用经营来源排除条件', () => {
  const financial = fs.readFileSync(path.resolve(__dirname, '../src/modules/report/financialProfitController.js'), 'utf8');
  assert.doesNotMatch(financial, /internalTransferSource|艾诺互调/);
});
