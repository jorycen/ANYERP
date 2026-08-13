const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const {
  buildRanges,
  comparisonRate,
  buildEmployeePerformance,
  canViewProfit
} = require('../src/modules/report/dashboardService');

test('经营看板默认日期使用中国时区本周并生成等长环比周期', () => {
  const ranges = buildRanges({}, new Date('2026-07-05T03:00:00.000Z'));
  assert.equal(ranges.current.startDate, '2026-06-29');
  assert.equal(ranges.current.endDate, '2026-07-05');
  assert.equal(ranges.previous.startDate, '2026-06-22');
  assert.equal(ranges.previous.endDate, '2026-06-28');
  assert.equal(ranges.yoy.startDate, '2025-06-29');
  assert.equal(ranges.yoy.endDate, '2025-07-05');
});

test('退单负向毛利只记到对应个人，普通调整仍按参与人均分', () => {
  const result = buildEmployeePerformance([{
    order_id: 'ORDER_RETURN_1',
    order_no: 'SO-RETURN-1',
    create_time: '2026-08-13T02:00:00.000Z',
    store_name: '测试门店',
    create_staff_id: 1,
    create_user: '主销售',
    auxiliary_sales_list: [{ staffId: 2, selected: '辅助销售' }],
    sales_amount: 1000,
    base_gross_profit: 200
  }], [{
    orderId: 'ORDER_RETURN_1',
    participantKey: 'id:1',
    signedAmount: -50,
    reason: '销售退单 RET001 完成，冲减原订单毛利',
    adjustmentType: 'return',
    adjustmentNo: 'RET001'
  }], '', true);

  const primary = result.ranking.find(row => row.staffId === '1');
  const auxiliary = result.ranking.find(row => row.staffId === '2');
  assert.equal(primary.grossProfit, 50);
  assert.equal(primary.approvedAdjustment, -50);
  assert.equal(auxiliary.grossProfit, 100);
  assert.equal(auxiliary.approvedAdjustment, 0);
  assert.equal(result.details.find(row => row.staffId === '1').reasons[0].adjustmentType, 'return');
});

test('同比和环比在基数为零时返回 null', () => {
  assert.equal(comparisonRate(100, 0), null);
  assert.equal(comparisonRate(120, 100), 20);
  assert.equal(comparisonRate(80, 100), -20);
});

test('辅助销售参与人去重并保留主销售和辅助销售角色', () => {
  const participants = normalizeParticipants({
    create_staff_id: 1,
    create_user: '主销售',
    auxiliary_sales_list: [
      { staffId: 2, selected: '辅助甲' },
      { staffId: 2, selected: '辅助甲' },
      { staff_id: 3, name: '辅助乙' }
    ]
  });
  assert.deepEqual(participants.map(row => [row.staffId, row.role]), [
    ['1', 'primary'],
    ['2', 'auxiliary'],
    ['3', 'auxiliary']
  ]);
});

test('订单销售额、基础毛利和审批调整在参与人之间平均拆分', () => {
  const result = buildEmployeePerformance([
    {
      order_id: 'ORDER_1',
      order_no: 'SO001',
      create_time: '2026-07-05T02:00:00.000Z',
      store_name: '测试门店',
      create_staff_id: 1,
      create_user: '主销售',
      auxiliary_sales_list: [{ staffId: 2, selected: '辅助销售' }],
      sales_amount: 1000,
      base_gross_profit: 200
    }
  ], [
    {
      orderId: 'ORDER_1',
      signedAmount: 40,
      reason: '重点产品奖励',
      adjustmentType: 'increase',
      adjustmentNo: 'PPA001'
    }
  ], '', true);

  assert.equal(result.ranking.length, 2);
  assert.equal(result.ranking[0].salesAmount, 500);
  assert.equal(result.ranking[0].baseGrossProfit, 100);
  assert.equal(result.ranking[0].approvedAdjustment, 20);
  assert.equal(result.ranking[0].grossProfit, 120);
  assert.equal(result.details[0].participantCount, 2);
  assert.equal(result.details[0].reasons[0].reason, '重点产品奖励');
});

test('毛利权限只开放给已确认角色', () => {
  assert.equal(canViewProfit({ roles: ['boss'] }), true);
  assert.equal(canViewProfit({ roles: ['manager'] }), true);
  assert.equal(canViewProfit({ roles: ['clerk'] }), false);
  assert.equal(canViewProfit({ roles: ['purchaser'] }), false);
});
