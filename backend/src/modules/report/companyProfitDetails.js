const crypto = require('node:crypto');
const money = value => Math.round(Number(value) * 100) / 100;
const amount = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : money(value);
const date = value => value instanceof Date ? new Date(value.getTime() + 28800000).toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
function row(event, sales, product, operations, reason = '') {
  const values = [amount(sales), amount(product), amount(operations)];
  const pending = values.some(value => value === null);
  const labels = { sale: '销售', return: '退货', reward_redemption: '会员兑换', policy: '政策收益',
    adjustment: '财务调整', performance_adjustment: '经营纠错', management_pending: '旧快照待核对' };
  const result = { ...event, entryTypeLabel: labels[event.entryType] || event.entryType,
    costState: event.costState || (['sale','return'].includes(event.entryType) ? event.grossProfit === null ? 'pending' : event.grossCost === 0 ? 'confirmed_zero' : 'known' : 'not_applicable'),
    salesGrossProfit: values[0], productGrossProfit: values[1], operationsGrossProfit: values[2],
    companyGrossProfit: pending ? null : money(values.reduce((sum, value) => sum + value, 0)),
    profitStatus: pending ? 'pending' : 'known', profitPendingReason: pending ? reason || '毛利依据不完整，不能以0代替' : '' };
  if (result.costState === 'pending') {
    result.grossCost = null; result.bookCost = null; result.deductibleInputVat = null;
  }
  result.managementSourceHash = crypto.createHash('sha256').update(JSON.stringify({ key: event.eventKey, date: event.businessDate,
    store: event.storeId, values, costState: result.costState })).digest('hex');
  return result;
}
function buildEvents(facts) {
  const events = (facts.items || []).map(event => event.entryType === 'adjustment'
    ? row(event, 0, 0, 0)
    : row(event, event.managementSalesGross, event.managementPending ? null : event.managementProductGross, 0,
      '销售冻结快照或产品端结算尚未完整，待核算'));
  for (const event of facts.policyItems || []) {
    if (event.entryType !== 'policy') continue;
    events.push(row(event, 0, event.productAllocation, 0));
  }
  for (const event of (facts.managementAdjustments || []).filter(event => Number(event.amount) !== 0)) events.push(row({ ...event,
    eventKey: `performance:${event.eventKey}`, entryNo: event.entryNo || String(event.eventKey), entryType: 'performance_adjustment',
    status: 'realized', grossProfit: null, grossCost: null, costState: 'not_applicable' }, event.amount, 0, 0));
  for (const event of facts.rewardEvents || []) events.push(row({
    eventKey: `reward:${event.id}`, entryType: 'reward_redemption', entryNo: event.order_no,
    orderNo: '', storeId: event.store_id, storeName: event.store_name, businessDate: date(event.created_at),
    staffName: event.staff_name || '', status: 'realized', grossRevenue: amount(event.cash_received),
    grossCost: amount(event.cost_amount), costState: amount(event.cost_amount) === null ? 'pending' : Number(event.cost_amount) === 0 ? 'confirmed_zero' : 'known',
    grossProfit: null, pendingCostReason: '', financialNote: '兑换经营分配，未作为财务商品毛利重复计入'
  }, event.sales_profit, 0, event.operations_profit));
  return events;
}
function inScope(event, filters) {
  return filters.storeIds.map(String).includes(String(event.storeId)) && event.businessDate >= filters.startDate && event.businessDate <= filters.endDate;
}
function overlayClosed(events, periods, filters, discrepancies = []) {
  let result = events;
  for (const period of periods || []) {
    const month = String(period.MONTH_KEY);
    if (month < filters.startDate.slice(0,7) || month > filters.endDate.slice(0,7)) continue;
    const saved = parse(period.SNAPSHOT_JSON);
    const live = result.filter(event => event.businessDate.startsWith(month));
    result = result.filter(event => !event.businessDate.startsWith(month));
    if (!Array.isArray(saved.managementEvents)) {
      // Never retrospectively insert live operations into a closed old snapshot.
      const legacy = buildEvents({ items: saved.items || [], policyItems: saved.policyItems || [], managementAdjustments: saved.managementAdjustments || [] });
      result.push(...legacy.filter(event => inScope(event, filters)).map(event => ({ ...event, closed: true })));
      result.push(row({ eventKey: `legacy-management:${month}`, entryType: 'management_pending',
        entryNo: `${month}月结`, businessDate: filters.startDate > `${month}-01` ? filters.startDate : `${month}-01`,
        storeId: null, storeName: '所选范围', closed: true, status: 'snapshot_pending', costState: 'not_applicable'
      }, 0, 0, null, '旧关账快照未冻结运营分配，保持原快照，待有依据的开放月份调整'));
      continue;
    }
    const frozen = saved.managementEvents.filter(event => inScope(event, filters));
    const old = new Map(frozen.map(event => [event.eventKey,event]));
    const liveKeys = new Set(live.map(event => event.eventKey));
    for (const event of live) if (!old.has(event.eventKey) || old.get(event.eventKey).managementSourceHash !== event.managementSourceHash) {
      if (!discrepancies.some(item => item.eventKey === event.eventKey)) discrepancies.push({ eventKey: event.eventKey,
        businessDate: event.businessDate, storeId: event.storeId, entryNo: event.entryNo,
        reason: '已关账经营分配变化，保留三端毛利快照，须按原纠错及开放期间调整规则处理', before: old.get(event.eventKey) || null, after: event });
    }
    for (const event of frozen) if (!liveKeys.has(event.eventKey) && !discrepancies.some(item => item.eventKey === event.eventKey)) {
      discrepancies.push({ eventKey: event.eventKey, businessDate: event.businessDate, storeId: event.storeId, entryNo: event.entryNo,
        reason: '已关账经营分配原记录不再可见，原快照保留', before: event, after: null });
    }
    result.push(...frozen.map(event => ({ ...event, closed: true })));
  }
  return result;
}
function summarize(events) {
  const sums = {};
  for (const key of ['salesGrossProfit','productGrossProfit','operationsGrossProfit','companyGrossProfit']) {
    sums[key] = events.some(event => event[key] === null) ? null : money(events.reduce((sum,event) => sum + Number(event[key] || 0),0));
    sums[`known${key[0].toUpperCase()}${key.slice(1)}`] = money(events.reduce((sum,event) => sum + Number(event[key] || 0),0));
  }
  return { ...sums, profitPendingCount: events.filter(event => event.profitStatus === 'pending').length,
    managementSource: 'COMPANY_OPERATING_EVENTS_V1' };
}
module.exports = { row, buildEvents, overlayClosed, summarize };
