// Read-only integration check: does not save commission settings or alter orders.
const assert = require('node:assert/strict');
const M = require('../src/models');
const R = require('../src/modules/report/employeeProfitSummary');
(async () => {
  const user = { staffId: 9, roles: ['boss'], accessibleStoreIds: ['*'] };
  const query = { startDate: '2026-11-01', endDate: '2026-11-01', storeId: 'D0215790' };
  const result = await R.load(user, query);
  const exported = R.exportRows(result.rows);
  assert.equal(result.rows.length, exported.length);
  result.rows.forEach((r,i) => {
    assert.equal(exported[i].毛利, r.grossProfit);
    assert.equal(exported[i].绩效预估, r.performanceEstimate ?? (r.status === 'pending' ? '待核算' : '待配置'));
  });
  if (result.rows.length) {
    const person = result.rows[0];
    const filtered = await R.load(user, { ...query, employeeId: String(person.staffId) });
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].grossProfit, person.grossProfit);
    assert.equal(filtered.rows[0].storeCommission, person.storeCommission);
  }
  console.log(JSON.stringify({ verified: true, rows: result.rows.length, panels: result.panels }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
