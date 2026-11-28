const { Op } = require('sequelize');
const { PerformanceProfitAdjustment, SalesReturnGrossProfitLedger } = require('../../models');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function loadProfitAdjustments(orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const [approved, returns] = await Promise.all([
    PerformanceProfitAdjustment.findAll({
      where: { order_id: { [Op.in]: ids }, status: 'approved' },
      attributes: ['order_id', 'adjustment_no', 'signed_amount'], raw: true
    }),
    SalesReturnGrossProfitLedger.findAll({
      where: { order_id: { [Op.in]: ids } },
      attributes: ['order_id', 'gross_profit_amount'], raw: true
    })
  ]);
  const result = new Map(ids.map(id => [id, {
    careCreditAdjustmentAmount: 0,
    otherApprovedAdjustmentAmount: 0,
    returnAdjustmentAmount: 0,
    approvedAdjustmentAmount: 0
  }]));
  approved.forEach(row => {
    const item = result.get(row.order_id);
    if (!item) return;
    const key = String(row.adjustment_no || '').startsWith('AUTO-CARE-')
      ? 'careCreditAdjustmentAmount' : 'otherApprovedAdjustmentAmount';
    item[key] = money(item[key] + Number(row.signed_amount || 0));
    item.approvedAdjustmentAmount = money(item.approvedAdjustmentAmount + Number(row.signed_amount || 0));
  });
  returns.forEach(row => {
    const item = result.get(row.order_id);
    if (!item) return;
    item.returnAdjustmentAmount = money(item.returnAdjustmentAmount + Number(row.gross_profit_amount || 0));
    item.approvedAdjustmentAmount = money(item.approvedAdjustmentAmount + Number(row.gross_profit_amount || 0));
  });
  return result;
}

function presentProfit(baseAmount, adjustments = {}) {
  const base = baseAmount === null || baseAmount === undefined ? null : money(baseAmount);
  return {
    ...adjustments,
    performanceGrossProfitAmount: base === null ? null : money(base + Number(adjustments.approvedAdjustmentAmount || 0))
  };
}

module.exports = { loadProfitAdjustments, presentProfit };
