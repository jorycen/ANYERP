const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/modules/report/companyProfitDetails');
const base = { eventKey: 'sale:1', entryType: 'sale', storeId: 's', businessDate: '2026-09-10', grossProfit: 80, grossCost: 0, managementSalesGross: 30, managementProductGross: 20 };
test('company allocation adds three components once and reverses returns', () => {
  const rows = P.buildEvents({ items: [base, { ...base, eventKey: 'return:1', entryType: 'return', managementSalesGross: -10, managementProductGross: -5 }],
    rewardEvents: [{ id: 'r', store_id: 's', created_at: '2026-09-10', cash_received: 40, cost_amount: 12, sales_profit: 20, operations_profit: 8 }],
    policyItems: [{ entryType: 'policy', eventKey: 'p', productAllocation: 7 }] });
  const summary = P.summarize(rows);
  assert.equal(summary.salesGrossProfit, 40);
  assert.equal(summary.productGrossProfit, 22);
  assert.equal(summary.operationsGrossProfit, 8);
  assert.equal(summary.companyGrossProfit, 70);
  assert.equal(rows[0].costState, 'confirmed_zero');
});
test('unknown costs are not displayed as zero or complete company profit', () => {
  const [row] = P.buildEvents({ items: [{ ...base, grossProfit: null, managementSalesGross: null }] });
  assert.equal(row.grossCost, null);
  assert.equal(row.companyGrossProfit, null);
  assert.equal(P.summarize([row]).companyGrossProfit, null);
  assert.equal(row.productGrossProfit, 20);
});
test('closed allocations stay frozen and report changed or deleted facts', () => {
  const frozen = P.buildEvents({ items: [base] });
  const live = P.buildEvents({ items: [{ ...base, managementSalesGross: 999 }] });
  const filters = { storeIds: ['s'], startDate: '2026-09-01', endDate: '2026-09-30' };
  const periods = [{ MONTH_KEY: '2026-09', SNAPSHOT_JSON: { managementEvents: frozen } }];
  const differences = [];
  assert.equal(P.overlayClosed(live, periods, filters, differences)[0].salesGrossProfit, 30);
  assert.equal(differences.length, 1);
  const removed = [];
  assert.equal(P.overlayClosed([], periods, filters, removed).length, 1);
  assert.equal(removed.length, 1);
});
test('legacy closed period never invents zero operations profit', () => {
  const rows = P.overlayClosed([], [{ MONTH_KEY: '2026-09', SNAPSHOT_JSON: { items: [base] } }],
    { storeIds: ['s'], startDate: '2026-09-01', endDate: '2026-09-30' });
  assert.equal(P.summarize(rows).operationsGrossProfit, null);
  assert.equal(P.summarize(rows).companyGrossProfit, null);
});
