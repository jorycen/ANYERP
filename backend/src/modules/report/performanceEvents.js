const money = value => Number(Number(value || 0).toFixed(2));

// These orders earned performance before a return was requested/completed.
const PERFORMANCE_SALE_STATUSES = ['已归档', 'completed', 'archived', 'returned', '已退单', 'return_pending'];

function savedItemProfit(item) {
  const quantity = Number(item.quantity || 1);
  const unitCost = money(item.sales_settlement_cost);
  return { source: 'archived', unitCost, costAmount: money(unitCost * quantity), grossProfit: money(item.sales_gross_profit) };
}

function returnEvents(rows) {
  const events = new Map();
  for (const row of rows) {
    const id = String(row.return_id);
    if (!events.has(id)) events.set(id, {
      orderId: `return:${id}`, entryType: 'return', returnId: id,
      orderNo: row.return_no, sourceOrderId: row.order_id, sourceOrderNo: row.order_no,
      orderTime: row.create_time, employeeName: '', storeName: row.order?.Store?.name || '',
      customerName: '', totalAmount: 0, actualPayment: 0, totalCost: 0,
      baseGrossProfit: 0, grossProfit: 0, approvedAdjustment: 0,
      careCreditAdjustment: 0, otherApprovedAdjustment: 0, careCostAmount: 0,
      participantAllocations: [], grossProfitSource: 'sales_return_ledger',
      calculation: { orderFormula: '按原销售毛利及原人员分配冲回', revenueNote: '退单完成日计入业绩，不使用当前定价重新计算', items: [] }
    });
    const event = events.get(id);
    event.totalAmount = money(event.totalAmount + Number(row.returned_sales_amount || 0));
    event.actualPayment = event.totalAmount;
    event.baseGrossProfit = money(event.baseGrossProfit + Number(row.gross_profit_amount || 0));
    event.grossProfit = event.baseGrossProfit;
    event.participantAllocations.push({ staffId: row.staff_id, employeeName: row.employee_name,
      role: row.participant_role, baseGrossProfit: money(row.gross_profit_amount),
      approvedAdjustment: 0, grossProfit: money(row.gross_profit_amount) });
    event.employeeName = event.participantAllocations.map(p => p.employeeName).join('、');
  }
  return [...events.values()];
}

module.exports = { PERFORMANCE_SALE_STATUSES, returnEvents, savedItemProfit };
