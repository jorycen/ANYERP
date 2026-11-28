const money = value => Math.round(Number(value || 0) * 100) / 100;
// Credit is settlement consideration, not a second discount on goods cost.
// Current quantities/amounts already reflect approved purchase adjustments.
function purchaseBreakdown(request) {
  const goodsCostBasis = money(request.current_total_amount ?? request.total_amount);
  const rebateCreditUsed = money(request.current_rebate_deduction ?? request.rebate_deduction);
  return { goodsCostBasis, rebateCreditUsed, cashOrPayable: money(goodsCostBasis - rebateCreditUsed),
    note: '返利抵扣属于既有额度支付。商品成本保留原采购价；核销已确认的政策收益，不在本次采购抵扣时再确认。金额已按已批准的采购调整更新，运费单独核算。' };
}
module.exports = { purchaseBreakdown };
