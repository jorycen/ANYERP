const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDecisionInsights, buildAiAdvisor } = require('../src/modules/report/decisionEngine');

test('decision engine raises explainable sales and inventory warnings', () => {
  const insights = buildDecisionInsights({
    kpis: {
      salesAmount: { value: 900, periodCompare: -12 },
      grossMargin: { value: 6 }
    },
    inventory: { staleProducts: [{ quantity: 3 }] },
    storeRanking: []
  });

  assert.deepEqual(insights.map(item => item.code), ['SALES_DECLINE', 'GROSS_MARGIN_LOW', 'STALE_INVENTORY']);
  assert.equal(insights[0].level, 'warning');
  assert.match(insights[0].action, /门店/);
});

test('AI advisor exposes a transparent rule fallback instead of pretending to call a model', () => {
  const advisor = buildAiAdvisor({
    kpis: { salesAmount: { value: 100, periodCompare: 0 }, grossMargin: { value: 20 } },
    inventory: { staleProducts: [] },
    storeRanking: []
  });

  assert.equal(advisor.aiAvailable, false);
  assert.equal(advisor.provider, 'rule_engine_fallback');
  assert.equal(advisor.recommendations[0].code, 'NO_EXCEPTION');
});
