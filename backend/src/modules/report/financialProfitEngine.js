const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const M = require('../../models');
const { summarizeAllocatedExpenses } = require('../finance/expenseCostAllocation');
const money = value => Math.round(Number(value || 0) * 100) / 100;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const date = value => value instanceof Date ? new Date(value.getTime() + 28800000).toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const amountFields = ['grossRevenue','netRevenue','outputVat','grossCost','bookCost','deductibleInputVat','grossProfit'];
function sourceHash(event) {
  return hash({ key: event.eventKey, date: event.businessDate, store: event.storeId, revenue: event.grossRevenue, cost: event.grossCost,
    category: event.category, invoiceEvidence: event.invoiceEvidence, scopeStoreIds: event.scopeStoreIds?.map(String).sort(), missingCost: event.grossProfit === null, policyAmount: event.policyAmount, originalTaxBasis: event.originalTaxBasis,
    items: event.detailItems?.map(item => ({ id: item.itemId, quantity: item.quantity, unitCost: item.unitCost, costSource: item.costSource, revenue: item.grossRevenue })) });
}
function finish(event) {
  event.businessDate = date(event.businessDate);
  event.sourceHash = sourceHash(event);
  event.taxStatus = 'estimated';
  event.estimatedOutputVat = event.outputVat || 0;
  event.estimatedInputVat = event.deductibleInputVat || 0;
  event.confirmedOutputVat = null;
  event.confirmedInputVat = null;
  return event;
}
async function select(sql, replacements = {}, transaction) {
  return M.sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
}
function applyReview(event, review) {
  if (!review) return event;
  const saved = parse(review.REVIEW_JSON);
  if (review.SOURCE_HASH !== event.sourceHash || review.INVALID_INVOICE) return { ...event, status: 'source_changed', taxStatus: 'source_changed', review: saved,
    reviewRevision: Number(review.REVISION), reviewedBusinessDate: date(review.BUSINESS_DATE), pendingCostReason: '成本、收入或原始依据发生变化，请重新核实；原确认值保留在操作历史' };
  return { ...event, ...saved.amounts, status: event.entryType === 'policy_pending' ? 'policy_pending' : 'confirmed', taxStatus: 'confirmed',
    confirmedOutputVat: saved.amounts.outputVat || 0, confirmedInputVat: saved.amounts.deductibleInputVat || 0,
    review: saved, reviewRevision: Number(review.REVISION), reviewedBusinessDate: date(review.BUSINESS_DATE), pendingCostReason: '' };
}
function allocate(total, items, key) {
  let allocated = 0; const weight = items.reduce((n,item) => n + Math.abs(item[key] || 0), 0);
  return items.map((item,index) => { const amount = index === items.length - 1 ? money(total - allocated) : money(total * Math.abs(item[key] || 0) / (weight || 1)); allocated = money(allocated + amount); return amount; });
}
function returnEvent(rows, original, calculateOrder) {
  const first = rows[0];
  const byId = new Map(original.detailItems.map(item => [String(item.itemId), item]));
  const originalInput = original.review && original.status === 'confirmed' ? Number(original.review.amounts.deductibleInputVat || 0) : original.deductibleInputVat;
  const originalOutput = original.review && original.status === 'confirmed' ? Number(original.review.amounts.outputVat || 0) : original.outputVat;
  const outputs = allocate(originalOutput, original.detailItems, 'grossRevenue');
  const inputs = allocate(originalInput, original.detailItems, 'grossCost');
  let missing = false;
  const detailItems = rows.map(row => {
    const item = byId.get(String(row.itemId));
    const grossRevenue = -Math.abs(Number(row.returnedReceivable));
    const quantity = -Math.abs(Number(row.returnedQuantity));
    const unitCost = item?.unitCost ?? null;
    if (Math.abs(quantity) > 0 && unitCost === null) missing = true;
    const grossCost = money((unitCost || 0) * quantity);
    // A reviewed sale's tax evidence survives in its original source-period snapshot.
    const itemIndex = original.detailItems.findIndex(value => String(value.itemId) === String(row.itemId));
    const cumulativeRevenue = Math.abs(Number(row.cumulativeRevenue ?? row.returnedReceivable));
    const cumulativeQuantity = Math.abs(Number(row.cumulativeQuantity ?? row.returnedQuantity));
    const delta = (total, cumulative, current, originalAmount) => -(money(total * Math.min(1, cumulative / (originalAmount || 1))) - money(total * Math.min(1, Math.max(0, cumulative - current) / (originalAmount || 1))));
    const confirmedLine = original.status === 'confirmed' ? original.review?.itemTaxes?.find(value => String(value.itemId) === String(row.itemId)) : undefined;
    const outputVat = money(delta(confirmedLine?.outputVat ?? outputs[itemIndex] ?? 0, cumulativeRevenue, Math.abs(grossRevenue), Math.abs(item?.grossRevenue || 0)));
    const inputVat = money(delta(confirmedLine?.inputVat ?? inputs[itemIndex] ?? 0, cumulativeQuantity, Math.abs(quantity), Math.abs(item?.quantity || 0)));
    return { itemId: row.itemId, productName: row.productName, quantity, unitCost, costSource: item?.costSource || 'missing_inventory_cost', grossRevenue,
      outputVat, netRevenue: money(grossRevenue - outputVat), grossCost, estimatedInputVat: inputVat, bookCost: money(grossCost - inputVat) };
  });
  const result = { entryType: 'return', eventKey: `return:${first.returnId}`, entryNo: first.returnNo,
    orderId: first.orderId, orderNo: first.orderNo, storeId: first.storeId, storeName: first.storeName, businessDate: first.returnDate,
    status: missing ? 'cost_pending' : 'estimated', detailItems, originalTaxBasis: original.review && original.status === 'confirmed' ? hash({ amounts: original.review.amounts, itemTaxes: original.review.itemTaxes }) : null,
    pendingCostReason: missing ? '原销售商品缺少可确认成本，无法确认退回成本' : '', itemCount: detailItems.length };
  for (const key of ['grossRevenue','netRevenue','outputVat','grossCost','bookCost']) result[key] = money(detailItems.reduce((n, item) => n + Number(item[key] || 0), 0));
  result.deductibleInputVat = money(detailItems.reduce((n, item) => n + item.estimatedInputVat, 0));
  result.grossProfit = missing ? null : money(result.netRevenue - result.bookCost);
  result.grossMargin = result.grossProfit === null || !result.netRevenue ? null : money(result.grossProfit / result.netRevenue * 100);
  return finish(result);
}
function group(rows, key) { const map = new Map(); for (const row of rows) { const id = String(row[key]); if (!map.has(id)) map.set(id, []); map.get(id).push(row); } return map; }
function expensesForScope(entries, storeIds, start, end) {
  const ids = storeIds.map(String);
  return entries.filter(row => date(row.businessDate) >= start && date(row.businessDate) <= end &&
    (row.storeId ? ids.includes(String(row.storeId)) : row.scopeStoreIds?.length && row.scopeStoreIds.every(id => ids.includes(String(id)))));
}
function summarize(items, operatingExpense = 0) {
  const ready = items.filter(item => item.grossProfit !== null && item.status !== 'source_changed');
  const sum = (list, key) => money(list.reduce((n, item) => n + Number(item[key] || 0), 0));
  const netRevenue = sum(items, 'netRevenue'), completeRevenue = sum(ready, 'netRevenue'), grossProfit = sum(ready, 'grossProfit');
  const totalAbs = items.reduce((n, item) => n + Math.abs(item.netRevenue), 0);
  const readyAbs = ready.reduce((n, item) => n + Math.abs(item.netRevenue), 0);
  return { orderCount: items.length, pendingOrderCount: items.length - ready.length,
    grossRevenue: sum(items, 'grossRevenue'), netRevenue, completeRevenue, pendingRevenue: sum(items.filter(item => !ready.includes(item)), 'netRevenue'),
    outputVat: sum(items, 'outputVat'), grossCost: sum(items, 'grossCost'), deductibleInputVat: sum(items, 'deductibleInputVat'), bookCost: sum(ready, 'bookCost'), knownBookCost: sum(items, 'bookCost'), completeBookCost: sum(ready, 'bookCost'),
    grossProfit, grossMargin: completeRevenue > 0 ? money(grossProfit / completeRevenue * 100) : null,
    overallGrossMargin: ready.length === items.length && netRevenue > 0 ? money(grossProfit / netRevenue * 100) : null,
    costCompleteness: totalAbs ? money(readyAbs / totalAbs * 100) : 100,
    taxPendingCount: items.filter(item => item.taxStatus !== 'confirmed').length,
    confirmedOutputVat: sum(items.filter(item => item.taxStatus === 'confirmed'), 'outputVat'),
    confirmedInputVat: sum(items.filter(item => item.taxStatus === 'confirmed'), 'deductibleInputVat'),
    operatingExpense, operatingProfit: items.length === ready.length && operatingExpense !== null ? money(grossProfit - operatingExpense) : null };
}
async function loadFacts(filters, calculateOrder, transaction) {
  const ids = filters.storeIds.length ? filters.storeIds : ['__NO_STORE__'];
  const p = { storeIds: ids, start: filters.startDate, end: filters.endDate };
  const returns = await select(`SELECT * FROM (SELECT sr.RETURN_ID returnId, sr.RETURN_NO returnNo, sr.ORDER_ID orderId, sr.ORDER_NO orderNo,
      sr.STORE_ID storeId, s.NAME storeName, DATE(sr.CREATE_TIME) returnDate, sri.ORDER_ITEM_ID itemId, sri.PRODUCT_NAME productName,
      sri.QUANTITY returnedQuantity, sri.USER_RECEIVABLE_AMOUNT returnedReceivable,
      SUM(ABS(sri.QUANTITY)) OVER (PARTITION BY sri.ORDER_ITEM_ID ORDER BY sr.CREATE_TIME,sr.RETURN_ID ROWS UNBOUNDED PRECEDING) cumulativeQuantity,
      SUM(ABS(sri.USER_RECEIVABLE_AMOUNT)) OVER (PARTITION BY sri.ORDER_ITEM_ID ORDER BY sr.CREATE_TIME,sr.RETURN_ID ROWS UNBOUNDED PRECEDING) cumulativeRevenue
    FROM T_SALES_RETURN_SETTLEMENT sr JOIN T_SALES_RETURN_SETTLEMENT_ITEM sri ON sri.SETTLEMENT_ID = sr.SETTLEMENT_ID
    JOIN T_STORE s ON s.STORE_ID = sr.STORE_ID JOIN T_SALES_RETURN_REQUEST rr ON rr.RETURN_ID = sr.RETURN_ID
    WHERE sr.STORE_ID IN (:storeIds) AND sr.SETTLEMENT_STATUS <> 'cancelled' AND rr.STATUS IN ('approved','completed')) return_facts
    WHERE returnDate BETWEEN :start AND :end`, p, transaction);
  const returnOrders = [...new Set(returns.map(row => row.orderId))];
  const rows = await select(`SELECT o.ORDER_ID orderId, o.ORDER_NO orderNo, DATE(COALESCE(o.ARCHIVE_TIME,o.CREATE_TIME)) businessDate,
      o.STORE_ID storeId, s.NAME storeName, o.CUSTOMER_NAME customerName, o.TOTAL_AMOUNT totalAmount, o.DISCOUNT_AMOUNT discountAmount,
      oi.ITEM_ID itemId, oi.PRODUCT_NAME productName, oi.QUANTITY quantity, oi.SUBTOTAL subtotal, oi.ORIGINAL_INVENTORY_COST originalInventoryCost,
      psi.PURCHASE_UNIT_COST AS purchaseUnitCost, psi.COST_STATUS AS purchaseCostStatus, psi.COST_SOURCE AS purchaseCostSource, gp.PRODUCT_PRICING_DETAILS AS frozenPricingDetails,
      pp.OUTPUT_TAX_RATE outputTaxRate, pp.INPUT_TAX_RATE inputTaxRate, pp.INPUT_TAX_DEDUCTIBLE inputTaxDeductible,
      pp.COST_PRICE estimatedCurrentCost, gp.GROSS_PROFIT_AMOUNT managementSalesGross,
      pso.GROSS_PROFIT_AMOUNT managementProductBase, pso.STATUS managementProductStatus,
      CASE WHEN gp.FORMULA_VERSION IN ('ORDER_GP_V9_FREIGHT_SEPARATE','ORDER_GP_V11_PRODUCT_COST_MODE') THEN GREATEST(0,ROUND(gp.RECEIVABLE_AMOUNT-gp.PRODUCT_PRICING_AMOUNT-gp.PAYMENT_FEE_AMOUNT-gp.VAT_AMOUNT+gp.SUPPLEMENT_AMOUNT-gp.FREIGHT_COST_AMOUNT-gp.GROSS_PROFIT_AMOUNT,2)) ELSE 0 END managementExternal
    FROM T_ORDER o JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID JOIN T_STORE s ON s.STORE_ID = o.STORE_ID
    LEFT JOIN T_PRODUCT_SETTLEMENT_ORDER pso ON pso.SOURCE_ORDER_ID = o.ORDER_ID
    LEFT JOIN T_PRODUCT_SETTLEMENT_ITEM psi ON psi.SOURCE_ORDER_ITEM_ID = oi.ITEM_ID
    LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.SNAPSHOT_STATUS = 'final'
    LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID
    WHERE o.IS_DELETED = 0 AND o.ORDER_STATUS IN ('completed','archived','已归档','returned','已退单','return_pending')
      AND o.STORE_ID IN (:storeIds) AND (DATE(COALESCE(o.ARCHIVE_TIME,o.CREATE_TIME)) BETWEEN :start AND :end OR o.ORDER_ID IN (:returnOrders))`,
    { ...p, returnOrders: returnOrders.length ? returnOrders : ['__NO_ORDER__'] }, transaction);
  const expenseSummary = await summarizeAllocatedExpenses({ storeIds: filters.storeIds, startDate: filters.startDate, endDate: filters.endDate, dateMode: 'financial_period', transaction });
  const reviewKeys = [...new Set([...rows.map(row => `sale:${row.orderId}`), ...returns.map(row => `return:${row.returnId}`), ...(expenseSummary.entries || []).map(row => `expense:${row.expenseId}:${row.storeId || 'company'}`)])];
  const reviews = await select(`SELECT * FROM T_FINANCIAL_PROFIT_REVIEW WHERE STORE_ID IN (:storeIds)
    AND (BUSINESS_DATE BETWEEN :start AND :end OR EVENT_KEY IN (:reviewKeys))`, { ...p, reviewKeys: reviewKeys.length ? reviewKeys : ['__NONE__'] }, transaction);
  const invoiceIds = [...new Set(reviews.map(row => parse(row.REVIEW_JSON).invoiceReference?.invoiceId).filter(Boolean))];
  if (invoiceIds.length) {
    const invoices = await select('SELECT INVOICE_ID,STATUS,TAX_AMOUNT FROM T_PURCHASE_INVOICE WHERE INVOICE_ID IN (:ids)', { ids: invoiceIds }, transaction);
    const invoiceMap = new Map(invoices.map(row => [row.INVOICE_ID, row]));
    for (const row of reviews) {
      const saved = parse(row.REVIEW_JSON), invoiceId = saved.invoiceReference?.invoiceId;
      if (invoiceId) { const invoice = invoiceMap.get(invoiceId); row.INVALID_INVOICE = !invoice || invoice.STATUS !== 'active' || Number(invoice.TAX_AMOUNT) + 0.001 < Math.abs(saved.amounts.deductibleInputVat || 0); }
    }
  }
  const reviewMap = new Map(reviews.map(row => [row.EVENT_KEY, row]));
  const neededMonths = [...new Set([...rows.map(row => date(row.businessDate).slice(0,7)), ...reviews.map(row => date(row.BUSINESS_DATE).slice(0,7))].filter(Boolean))];
  const periods = await select('SELECT * FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY BETWEEN :startMonth AND :endMonth OR MONTH_KEY IN (:neededMonths)', { startMonth: filters.startDate.slice(0,7), endMonth: filters.endDate.slice(0,7), neededMonths: neededMonths.length ? neededMonths : ['__NONE__'] }, transaction);
  const frozenSales = new Map();
  for (const period of periods) for (const event of parse(period.SNAPSHOT_JSON).items || []) if (event.entryType === 'sale') frozenSales.set(event.eventKey, event);
  const originals = new Map(); const items = [];
  const returnManagement = returnOrders.length ? await select(`SELECT RETURN_ID, SUM(GROSS_PROFIT_AMOUNT) amount FROM T_SALES_RETURN_GROSS_PROFIT WHERE ORDER_ID IN (:ids) GROUP BY RETURN_ID`, { ids: returnOrders }, transaction) : [];
  const returnProducts = returnOrders.length ? await select('SELECT SOURCE_RETURN_ID, GROSS_PROFIT_AMOUNT, STATUS FROM T_PRODUCT_SETTLEMENT_ADJUSTMENT WHERE SOURCE_ORDER_ID IN (:ids)', { ids: returnOrders }, transaction) : [];
  const { externalIncomeSql } = require('./productIncomeSql');
  const returnedExternal = returnOrders.length ? await select(`SELECT ENTRY_ID,GROSS_PROFIT_AMOUNT FROM (${externalIncomeSql()}) ext WHERE ENTRY_TYPE = 'external_return' AND SOURCE_ORDER_ID IN (:ids)`, { ids: returnOrders }, transaction) : [];

  for (const [orderId, orderRows] of group(rows, 'orderId')) {
    const raw = finish({ ...calculateOrder(orderRows.sort((a,b) => String(a.itemId).localeCompare(String(b.itemId)))), entryType: 'sale', eventKey: `sale:${orderId}`, entryNo: orderRows[0].orderNo, managementSalesGross: money(orderRows[0].managementSalesGross), managementProductGross: money((orderRows[0].managementProductStatus === 'posted' ? Number(orderRows[0].managementProductBase) : 0) + Number(orderRows[0].managementExternal || 0)), managementPending: orderRows[0].managementProductStatus !== 'posted' });
    const event = applyReview(raw, reviewMap.get(raw.eventKey));
    originals.set(orderId, frozenSales.get(raw.eventKey) || event);
    if (event.businessDate >= filters.startDate && event.businessDate <= filters.endDate) items.push(event);
  }
  for (const returnRows of group(returns, 'returnId').values()) {
    const original = originals.get(String(returnRows[0].orderId)) || frozenSales.get(`sale:${returnRows[0].orderId}`);
    if (!original) throw Object.assign(new Error('退货无法追溯原销售，请核对原单状态及门店'), { status: 409 });
    const raw = returnEvent(returnRows.sort((a,b) => String(a.itemId).localeCompare(String(b.itemId))), original, calculateOrder);
    const returnId = returnRows[0].returnId, product = returnProducts.find(row => row.SOURCE_RETURN_ID === returnId);
    raw.managementSalesGross = money(returnManagement.find(row => row.RETURN_ID === returnId)?.amount);
    raw.managementProductGross = money((product?.STATUS === 'posted' ? Number(product.GROSS_PROFIT_AMOUNT) : 0) + Number(returnedExternal.find(row => row.ENTRY_ID === `EXT-RET-${returnId}`)?.GROSS_PROFIT_AMOUNT || 0));
    raw.managementPending = product?.STATUS !== 'posted';
    items.push(applyReview(raw, reviewMap.get(raw.eventKey)));
  }
  const policies = await select(`SELECT CONCAT('policy:',e.ENTRY_ID) eventKey, e.ENTRY_ID entryId, e.SETTLEMENT_ID settlementId,
      r.SETTLEMENT_NO entryNo, e.STORE_ID storeId, s.NAME storeName, DATE(e.BUSINESS_DATE) businessDate, e.SOURCE_ORDER_NO orderNo,
      r.RESOURCE_TYPE resourceType, (CASE WHEN e.AMOUNT < 0 THEN -1 ELSE 1 END) * ABS(COALESCE(NULLIF(CAST(JSON_UNQUOTE(JSON_EXTRACT(e.DETAIL_JSON, '$.matchedAmount')) AS DECIMAL(12,2)),0),r.AMOUNT)) policyAmount,
      e.AMOUNT productAllocation, 'policy' entryType
    FROM T_PRODUCT_PROFIT_INCOME e JOIN T_RESOURCE_SETTLEMENT r ON r.SETTLEMENT_ID = e.SETTLEMENT_ID JOIN T_STORE s ON s.STORE_ID = e.STORE_ID
    WHERE e.STORE_ID IN (:storeIds) AND DATE(e.BUSINESS_DATE) BETWEEN :start AND :end`, p, transaction);
  const { pendingPolicySql } = require('./productIncomeSql');
  const pending = await select(`SELECT pending.*, pool.AMOUNT fullPolicyAmount FROM (${pendingPolicySql()}) pending JOIN T_RESOURCE_SETTLEMENT pool ON pool.SETTLEMENT_ID = pending.ENTRY_ID WHERE pending.STORE_ID IN (:storeIds) AND DATE(pending.BUSINESS_DATE) BETWEEN :start AND :end`, p, transaction);
  const policyItems = policies.map(row => {
    const raw = finish({ ...row, grossRevenue: 0, grossCost: 0, grossProfit: 0, policyImpact: 0, status: 'policy_unreviewed',
      pendingCostReason: '整笔核销已完成，尚待财务分类及税务依据核实；个人/产品经营分配不重复计入公司收益' });
    return applyReview(raw, reviewMap.get(raw.eventKey));
  });
  for (const row of pending) policyItems.push(finish({ eventKey: `pending:${row.ENTRY_ID}`, settlementId: row.ENTRY_ID, entryNo: row.ENTRY_NO,
    storeId: row.STORE_ID, storeName: row.STORE_NAME, businessDate: row.BUSINESS_DATE, orderNo: row.SOURCE_ORDER_NO,
    entryType: 'policy_pending', status: 'policy_pending', policyAmount: row.fullPolicyAmount, productAllocation: row.GROSS_PROFIT_AMOUNT,
    grossRevenue: 0, grossCost: 0, grossProfit: 0, policyImpact: 0, pendingCostReason: '尚未整笔核销，经营待实现；可在政策详情查看全额返利池' }));
  const adjustmentRows = await select('SELECT * FROM T_FINANCIAL_PROFIT_ADJUSTMENT WHERE STORE_ID IN (:storeIds)', p, transaction);
  const expenseAdjustments = [];
  for (const row of adjustmentRows) {
    if (date(row.BUSINESS_DATE) < filters.startDate || date(row.BUSINESS_DATE) > filters.endDate) continue;
    const saved = parse(row.DETAIL_JSON);
    const event = { ...saved.amounts, eventKey: `adjustment:${row.ADJUSTMENT_ID}`, entryNo: row.ADJUSTMENT_ID, entryType: 'adjustment',
      storeId: row.STORE_ID, businessDate: date(row.BUSINESS_DATE), status: 'confirmed', taxStatus: 'confirmed', review: saved, sourceEventKey: row.SOURCE_EVENT_KEY,
      grossProfit: money(saved.amounts.netRevenue - saved.amounts.bookCost), detailItems: [], sourceHash: hash(saved) };
    if (saved.category === 'policy') policyItems.push({ ...event, entryType: 'policy_adjustment', policyImpact: saved.amounts.policyImpact, grossProfit: 0 });
    else if (saved.category === 'expense') expenseAdjustments.push({ ...event, entryType: 'expense', storeId: saved.original.storeId || null, scopeStoreIds: saved.original.scopeStoreIds, category: saved.original.category || 'store', amount: event.grossCost });
    else items.push(event);
  }
  const performance = await select(`SELECT ADJUSTMENT_ID eventKey, STORE_ID storeId, DATE(COALESCE(ADMIN_REVIEW_TIME,UPDATE_TIME,CREATE_TIME)) businessDate,
      SIGNED_AMOUNT amount FROM T_PERFORMANCE_PROFIT_ADJUSTMENT WHERE STATUS = 'approved' AND STORE_ID IN (:storeIds)
      AND DATE(COALESCE(ADMIN_REVIEW_TIME,UPDATE_TIME,CREATE_TIME)) BETWEEN :start AND :end`, p, transaction);
  const managementAdjustments = performance.map(row => ({ ...row, businessDate: date(row.businessDate), amount: money(row.amount) }));
  return { items, policyItems, expenseEntries: (expenseSummary.entries || []).map(row => { const raw = finish({ ...row, eventKey: `expense:${row.expenseId}:${row.storeId || 'company'}`, entryNo: row.expenseId, entryType: 'expense', businessDate: date(row.businessDate), grossRevenue: 0, grossCost: row.amount, bookCost: row.amount, grossProfit: 0, status: 'estimated', policyImpact: 0 }); return applyReview(raw, reviewMap.get(raw.eventKey)); }).concat(expenseAdjustments), periods, adjustmentRows, managementAdjustments };
}
function overlayClosed(facts, filters) {
  const discrepancies = [];
  const frozenIndex = new Map();
  for (const period of facts.periods) {
    const snapshot = parse(period.SNAPSHOT_JSON);
    for (const row of [...snapshot.items,...snapshot.policyItems,...snapshot.expenseEntries]) if (row.entryType !== 'policy_pending') frozenIndex.set(row.eventKey, { row, month: period.MONTH_KEY });
  }
  for (const key of ['items','policyItems','expenseEntries']) facts[key] = facts[key].filter(row => {
    const saved = frozenIndex.get(row.eventKey);
    if (!saved || saved.month === row.businessDate.slice(0,7)) return true;
    discrepancies.push({ eventKey: row.eventKey, entryNo: row.entryNo, storeId: row.storeId, businessDate: saved.row.businessDate,
      reason: '已关账明细被改到其他期间，原快照保留，须通过跨期调整反映变化', before: saved.row, after: row }); return false;
  });
  for (const period of facts.periods) {
    if (period.MONTH_KEY < filters.startDate.slice(0, 7) || period.MONTH_KEY > filters.endDate.slice(0, 7)) continue;
    const frozen = parse(period.SNAPSHOT_JSON);
    const inScope = event => filters.storeIds.map(String).includes(String(event.storeId)) && date(event.businessDate) >= filters.startDate && date(event.businessDate) <= filters.endDate;
    for (const key of ['items', 'policyItems']) {
      const live = facts[key].filter(event => event.businessDate.startsWith(period.MONTH_KEY));
      const saved = (frozen[key] || []).filter(inScope);
      const liveMap = new Map(live.map(event => [event.eventKey, event]));
      const savedMap = new Map(saved.map(event => [event.eventKey, event]));
      for (const event of live) if (event.entryType !== 'policy_pending' && (!savedMap.has(event.eventKey) || savedMap.get(event.eventKey).sourceHash !== event.sourceHash || event.status === 'source_changed')) discrepancies.push({ eventKey: event.eventKey, storeId: event.storeId, entryNo: event.entryNo, businessDate: event.businessDate, reason: '已关账期间新增或原始依据发生变化，需在开放月份登记调整', before: savedMap.get(event.eventKey) || null, after: event });
      for (const event of saved) if (event.entryType !== 'policy_pending' && !liveMap.has(event.eventKey)) discrepancies.push({ eventKey: event.eventKey, storeId: event.storeId, entryNo: event.entryNo, businessDate: event.businessDate, reason: '原始记录已不可见，月结结果保留，需财务核实', before: event, after: null });
      facts[key] = facts[key].filter(event => !event.businessDate.startsWith(period.MONTH_KEY)).concat(saved.map(event => ({ ...event, closed: true })));
    }
    if (facts.managementAdjustments) facts.managementAdjustments = facts.managementAdjustments.filter(row => !row.businessDate.startsWith(period.MONTH_KEY)).concat((frozen.managementAdjustments || []).filter(inScope));
    const liveExpenses = facts.expenseEntries.filter(row => row.businessDate.startsWith(period.MONTH_KEY));
    const savedExpenses = expensesForScope(frozen.expenseEntries || [], filters.storeIds, filters.startDate, filters.endDate);
    const liveExpenseMap = new Map(liveExpenses.map(row => [row.eventKey, row]));
    const savedExpenseMap = new Map(savedExpenses.map(row => [row.eventKey, row]));
    for (const key of new Set([...liveExpenseMap.keys(),...savedExpenseMap.keys()])) {
      const before = savedExpenseMap.get(key), after = liveExpenseMap.get(key);
      if (before?.sourceHash !== after?.sourceHash || after?.status === 'source_changed') discrepancies.push({ eventKey: key, entryNo: before?.entryNo || after?.entryNo,
        storeId: before?.storeId || after?.storeId, businessDate: before?.businessDate || after?.businessDate,
        reason: '已关账费用依据变化，继续采用月结费用，请在开放月份调整', before: before || null, after: after || null });
    }
    facts.expenseEntries = facts.expenseEntries.filter(row => !row.businessDate.startsWith(period.MONTH_KEY)).concat(savedExpenses.map(row => ({ ...row, closed: true })));
  }
  return discrepancies;
}
async function query(filters, calculateOrder, { transaction, ignoreClosed = false } = {}) {
  if (!filters.storeIds.length) return { items: [], policyItems: [], expenseEntries: [], periods: [], discrepancies: [], summary: summarize([], 0), operatingExpense: 0 };
  const facts = await loadFacts(filters, calculateOrder, transaction);
  const unperiodizedExpenses = facts.expenseEntries.filter(row => !row.businessDate).map(row => ({ ...row, status: 'period_pending', pendingCostReason: '请先在费用原单补齐归属月份或费用日期，不能自动归入所选期间' }));
  facts.expenseEntries = expensesForScope(facts.expenseEntries, filters.storeIds, filters.startDate, filters.endDate);
  const discrepancies = ignoreClosed ? [] : overlayClosed(facts, filters);
  for (const difference of discrepancies) {
    difference.adjustmentIds = (facts.adjustmentRows || []).filter(row => row.SOURCE_EVENT_KEY === difference.eventKey && parse(row.DETAIL_JSON).resolvedSourceHash === (difference.after?.sourceHash || 'deleted')).map(row => row.ADJUSTMENT_ID);
    difference.resolved = difference.adjustmentIds.length > 0;
  }
  const matches = event => (!filters.orderNo || String(event.orderNo || '').includes(filters.orderNo)) && (!filters.status || event.status === filters.status);
  const items = facts.items.filter(matches), policyItems = facts.policyItems.filter(matches);
  const expenseSum = category => money(facts.expenseEntries.filter(row => row.category === category).reduce((n, row) => n + Number(row.bookCost ?? row.amount), 0));
  const expenseTotal = money(facts.expenseEntries.reduce((n, row) => n + Number(row.bookCost ?? row.amount), 0));
  const operatingExpense = filters.orderNo || filters.status ? null : expenseTotal;
  const summary = summarize(items, operatingExpense);
  summary.storeExpense = expenseSum('store'); summary.productExpense = expenseSum('product'); summary.companyExpense = expenseSum('company');
  summary.policyAdjustment = money(policyItems.reduce((n, event) => n + Number(event.policyImpact || 0), 0));
  summary.costPolicyAdjustment = money(policyItems.filter(event => event.review?.treatment === 'reduce_cost').reduce((n, event) => n + Number(event.policyImpact || 0), 0));
  summary.otherIncomeAdjustment = money(policyItems.filter(event => event.review?.treatment === 'other_income').reduce((n, event) => n + Number(event.policyImpact || 0), 0));
  summary.policyPendingCount = policyItems.filter(event => event.entryType === 'policy' && event.status !== 'confirmed').length;
  summary.expenseTaxPendingCount = facts.expenseEntries.filter(row => row.status !== 'confirmed').length;
  summary.unperiodizedExpenseCount = unperiodizedExpenses.length;
  summary.taxComplete = unperiodizedExpenses.length === 0 && summary.taxPendingCount === 0 && summary.policyPendingCount === 0 && summary.expenseTaxPendingCount === 0;
  summary.estimatedOperatingProfit = operatingExpense === null ? null : money(summary.grossProfit + summary.policyAdjustment - operatingExpense);
  summary.operatingProfit = summary.pendingOrderCount || !summary.taxComplete ? null : summary.estimatedOperatingProfit;
  summary.managementSalesGross = money(items.reduce((n,row) => n + Number(row.managementSalesGross || 0),0) + (facts.managementAdjustments || []).reduce((n,row) => n + row.amount,0));
  summary.managementProductGross = money(items.reduce((n,row) => n + Number(row.managementProductGross || 0),0) + policyItems.filter(row => row.entryType === 'policy').reduce((n,row) => n + Number(row.productAllocation || 0),0));
  summary.managementCombinedGross = money(summary.managementSalesGross + summary.managementProductGross);
  summary.financialComparableGross = money(summary.grossProfit + summary.policyAdjustment);
  summary.managementDifference = money(summary.financialComparableGross - summary.managementCombinedGross);
  summary.managementIncomplete = items.some(row => row.managementPending) || summary.pendingOrderCount > 0 || !summary.taxComplete;
  if (filters.orderNo || filters.status) { summary.managementSalesGross = null; summary.managementProductGross = null; summary.managementCombinedGross = null; summary.managementDifference = null; summary.managementIncomplete = true; }
  summary.expenseScopeNote = operatingExpense === null ? '单号/状态筛选仅用于明细，扣期间费用后的收益暂停显示' : '按所选门店及期间统计；公司未分摊费用仅在覆盖其全部归属门店时计入';
  const issueItems = [...items,...policyItems.filter(row => row.entryType !== 'policy_pending'),...facts.expenseEntries,...unperiodizedExpenses].filter(row => !row.closed && row.status !== 'confirmed').map(row => ({ ...row }));
  return { items: items.sort((a,b) => b.businessDate.localeCompare(a.businessDate)), issueItems, unperiodizedExpenses, policyItems, expenseEntries: facts.expenseEntries, discrepancies,
    managementAdjustments: facts.managementAdjustments, periods: facts.periods.filter(row => row.MONTH_KEY >= filters.startDate.slice(0,7) && row.MONTH_KEY <= filters.endDate.slice(0,7)).map(row => ({ month: row.MONTH_KEY, closedAt: row.CLOSED_AT, closedBy: row.CLOSED_BY, hash: row.SNAPSHOT_HASH })), summary, operatingExpense };
}
module.exports = { expensesForScope, query, select, parse, date, hash, money, sourceHash, applyReview, returnEvent, summarize, overlayClosed, amountFields };
