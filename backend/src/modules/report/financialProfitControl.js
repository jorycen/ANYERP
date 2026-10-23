const M = require('../../models');
const { getUserRoles } = require('../../middleware/permission');
const { canAccessDistributor } = require('../../utils/distributorScope');
const { generateUUID } = require('../../utils');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const E = require('./financialProfitEngine');
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function roles(ctx) { if (!getUserRoles(ctx.state.user).some(role => ['boss','admin','finance'].includes(role))) ctx.throw(403, '仅财务或管理员可核实财务依据'); }
function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0,10) !== text) fail('请填写有效业务日期');
  return text;
}
function decimal(value, name, signed = false) {
  if (value === null || value === undefined || typeof value === 'boolean' || !(signed ? /^-?\d{1,9}(\.\d{1,2})?$/ : /^\d{1,9}(\.\d{1,2})?$/).test(String(value))) fail(`${name}须为${signed ? '' : '非负'}金额，最多两位小数`);
  return E.money(value);
}
function evidence(body) {
  const reason = String(body.reason || '').trim(), basis = String(body.evidence || '').trim(), invoiceNo = String(body.invoiceNo || '').trim();
  if (reason.length < 2 || reason.length > 512 || basis.length < 2 || basis.length > 2000 || invoiceNo.length > 512) fail('请填写核实依据和2至512字的操作原因，凭据说明不超过2000字');
  return { reason, evidence: basis, invoiceNo };
}
function reviewAmounts(event, body) {
  const proof = evidence(body);
  if (event.entryType === 'policy_pending') fail('尚未整笔核销的政策仅展示待实现信息');
  if (event.entryType === 'policy') {
    if (!['reduce_cost','other_income','defer_inventory','excluded'].includes(body.treatment)) fail('请选择政策财务分类');
    const eligibleAmount = ['defer_inventory','excluded'].includes(body.treatment) ? 0 : decimal(body.eligibleAmount, '本期损益政策金额');
    const taxImpact = eligibleAmount ? decimal(body.taxImpact, '政策税务影响') : 0;
    if (eligibleAmount > Math.abs(event.policyAmount) + 0.001 || taxImpact > eligibleAmount) fail('本期金额不得超过政策全额，税务影响不得超过本期金额');
    const sign = Number(event.policyAmount) < 0 ? -1 : 1;
    return { ...proof, treatment: body.treatment, eligibleAmount, deferredOrExcluded: E.money(Math.abs(event.policyAmount) - eligibleAmount), taxImpact,
      amounts: { policyImpact: E.money(sign * (eligibleAmount - taxImpact)), grossProfit: 0 } };
  }
  if (event.grossProfit === null || event.status === 'cost_pending') fail('请先补齐实际成本依据，再核实税额');
  const input = decimal(body.inputVat, '分摊进项税额'), output = event.entryType === 'expense' ? 0 : decimal(body.outputVat, '销项税额');
  if (input > Math.abs(event.grossCost) + 0.001 || output > Math.abs(event.grossRevenue) + 0.001) fail('税额不得超过对应含税金额');
  if (!['deductible','non_deductible'].includes(body.inputTaxMode)) fail('请选择进项抵扣判断');
  if (body.inputTaxMode === 'non_deductible' && input !== 0) fail('不可抵扣时进项税额须为0');
  let itemTaxes;
  if ((event.detailItems || []).length > 1) {
    if (!Array.isArray(body.itemTaxes) || body.itemTaxes.length !== event.detailItems.length || new Set(body.itemTaxes.map(row => String(row.itemId))).size !== body.itemTaxes.length) fail('混合商品单据须逐行核对税额，不能仅用统一比例分摊');
    itemTaxes = event.detailItems.map(item => {
      const row = body.itemTaxes.find(value => String(value.itemId) === String(item.itemId));
      if (!row) fail('逐行税额与原商品不匹配');
      const lineOutput = decimal(row.outputVat, '商品行销项税'), lineInput = decimal(row.inputVat, '商品行进项税');
      if (lineOutput > Math.abs(item.grossRevenue) + 0.001 || lineInput > Math.abs(item.grossCost) + 0.001) fail('商品行税额超过对应金额');
      return { itemId: item.itemId, outputVat: lineOutput, inputVat: lineInput };
    });
    if (E.money(itemTaxes.reduce((n,row) => n + row.outputVat,0)) !== output || E.money(itemTaxes.reduce((n,row) => n + row.inputVat,0)) !== input) fail('商品行税额合计须与单据税额一致');
  } else if (event.detailItems?.length === 1) itemTaxes = [{ itemId: event.detailItems[0].itemId, outputVat: output, inputVat: input }];
  const inputVat = E.money(input * (event.grossCost < 0 ? -1 : 1));
  const outputVat = E.money(output * (event.grossRevenue < 0 ? -1 : 1));
  const netRevenue = E.money(event.grossRevenue - outputVat), bookCost = E.money(event.grossCost - inputVat);
  return { ...proof, itemTaxes, inputTaxMode: body.inputTaxMode, amounts: { netRevenue, outputVat, bookCost, deductibleInputVat: inputVat,
    grossProfit: event.entryType === 'expense' ? 0 : E.money(netRevenue - bookCost),
    grossMargin: netRevenue ? E.money((netRevenue - bookCost) / netRevenue * 100) : null } };
}
async function verifyInvoice(ctx, event, saved, transaction) {
  if (!Number(saved.amounts.deductibleInputVat)) return;
  if (!saved.invoiceNo) fail('确认分摊进项税时请填写系统已登记的发票号码；无票或不可抵扣请按0元核实');
  if (event.entryType === 'expense' && event.expenseId) {
    const expense = await M.Expense.findByPk(event.expenseId, { transaction });
    if (expense && Number(expense.has_invoice) === 1 && String(expense.invoice_no || '').trim() === saved.invoiceNo) {
      saved.invoiceReference = { source: 'expense', expenseId: expense.expense_id, invoiceNo: saved.invoiceNo }; return;
    }
  }
  const invoice = await M.PurchaseInvoice.findOne({ where: { invoice_no: saved.invoiceNo, status: 'active' }, transaction });
  if (!invoice || !canAccessDistributor(ctx.state.user, invoice.distributor_id)) fail('未找到当前经销商可访问的有效发票，请先登记凭据');
  if (Math.abs(saved.amounts.deductibleInputVat) > Number(invoice.tax_amount) + 0.001) fail('本单分摊进项税超过该发票税额，请核对分摊依据');
  saved.invoiceReference = { source: 'purchase_invoice', invoiceId: invoice.invoice_id, invoiceNo: invoice.invoice_no,
    supplierName: invoice.supplier_name, taxAmount: Number(invoice.tax_amount), allocationNote: '财务人工确认的销售成本/费用分摊依据，不等同于申报抵扣或自动SN分摊' };
}
async function lockStore(ctx, storeId, transaction) {
  const store = await M.Store.findByPk(storeId, { transaction, lock: transaction.LOCK.UPDATE });
  const user = ctx.state.user, ids = (user.accessibleStoreIds || []).map(String);
  if (!store || (!ids.includes('*') && !ids.includes(String(storeId))) || !canAccessDistributor(user, store.distributor_id)) ctx.throw(403, '无权处理此门店财务记录');
  return store;
}
async function isClosed(month, transaction) { return (await E.select('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY = :month', { month }, transaction)).length > 0; }
async function rawReport(filters, transaction, ignoreClosed = true) { return E.query(filters, require('./financialProfitController').calculateOrder, { transaction, ignoreClosed }); }
async function review(ctx) {
  roles(ctx);
  const body = ctx.request.body || {}, businessDate = validDate(body.businessDate);
  await M.sequelize.transaction(async transaction => {
    await lockStore(ctx, body.storeId, transaction);
    if (await isClosed(businessDate.slice(0,7), transaction)) ctx.throw(409, '该月份已关账，请在开放月份登记调整');
    const accessible = await require('./financialProfitController').resolveFilters({ ...ctx, query: { startDate: businessDate, endDate: businessDate } });
    const report = await rawReport(accessible, transaction);
    const event = [...report.items,...report.policyItems,...report.expenseEntries].find(row => row.eventKey === body.eventKey);
    if (!event || (event.storeId ? String(event.storeId) !== String(body.storeId) : String([...(event.scopeStoreIds || [])].map(String).sort()[0]) !== String(body.storeId))) ctx.throw(404, '当前权限范围内未找到待核实明细');
    if (event.sourceEventKey) ctx.throw(409, '独立调整记录不可覆盖，请通过另一条调整记录修正');
    if (event.reviewedBusinessDate && await isClosed(event.reviewedBusinessDate.slice(0,7), transaction)) ctx.throw(409, '原始核实记录已关账，改期也不可重写，请登记跨期调整');
    if (event.sourceHash !== body.sourceHash || Number(body.expectedRevision || 0) !== Number(event.reviewRevision || 0)) ctx.throw(409, '明细或核实记录已变化，请刷新后重新核实');
    const saved = reviewAmounts(event, body), revision = Number(event.reviewRevision || 0) + 1;
    await verifyInvoice(ctx, event, saved, transaction);
    await M.sequelize.query(`INSERT INTO T_FINANCIAL_PROFIT_REVIEW (EVENT_KEY,STORE_ID,BUSINESS_DATE,REVISION,SOURCE_HASH,REVIEW_JSON,UPDATE_TIME)
      VALUES (:key,:store,:date,:revision,:hash,:json,NOW(3)) ON DUPLICATE KEY UPDATE REVISION=VALUES(REVISION),SOURCE_HASH=VALUES(SOURCE_HASH),REVIEW_JSON=VALUES(REVIEW_JSON),UPDATE_TIME=NOW(3)`,
      { replacements: { key: event.eventKey, store: String(body.storeId), date: businessDate, revision, hash: event.sourceHash, json: JSON.stringify(saved) }, transaction });
    await recordBusinessAction({ businessType: 'financial_profit_review', businessId: event.eventKey, businessNo: event.entryNo, action: 'confirm_basis',
      user: ctx.state.user, comment: saved.reason, detail: { revision, before: event.review || null, after: saved, sourceHash: event.sourceHash }, transaction });
  });
  ctx.body = { code: 0, message: '财务依据已核实并留痕；资金、库存及销售考核数据保持原记录' };
}
function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) fail('月份格式须为YYYY-MM');
  const startDate = validDate(`${month}-01`);
  const monthEnd = new Date(`${startDate}T00:00:00Z`); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0);
  const endDate = monthEnd.toISOString().slice(0,10);
  const today = new Date(Date.now() + 28800000).toISOString().slice(0,10);
  if (endDate >= today) fail('仅可对已经结束的月份执行月结');
  return { startDate, endDate };
}
function closeBlockers(report) {
  const all = [...report.items, ...report.policyItems.filter(row => row.entryType === 'policy'), ...report.expenseEntries,...(report.unperiodizedExpenses || [])];
  return all.filter(row => row.status !== 'confirmed').map(row => ({ eventKey: row.eventKey, entryNo: row.entryNo, status: row.status, reason: row.pendingCostReason || '尚未核实税务及分类依据' })).concat((report.discrepancies || []).filter(row => !row.resolved).map(row => ({ eventKey: row.eventKey, entryNo: row.entryNo, status: 'closed_difference', reason: row.reason })));
}
function snapshot(report, month, storeIds) {
  const data = { month, storeIds: storeIds.map(String).sort(), items: [...report.items].sort((a,b) => a.eventKey.localeCompare(b.eventKey)), policyItems: [...report.policyItems].sort((a,b) => a.eventKey.localeCompare(b.eventKey)), expenseEntries: [...report.expenseEntries].sort((a,b) => a.eventKey.localeCompare(b.eventKey)),
    managementAdjustments: [...(report.managementAdjustments || [])].sort((a,b) => a.eventKey.localeCompare(b.eventKey)),
    formulaVersion: 'FINANCIAL_PROFIT_V2_20261023' };
  return { data, hash: E.hash(data) };
}
async function monthFilters(ctx, transaction) {
  if (!getUserRoles(ctx.state.user).includes('boss') || !(ctx.state.user.accessibleStoreIds || []).includes('*')) ctx.throw(403, '全公司月结仅允许有全部门店权限的BOSS执行');
  const dates = monthRange(ctx.request.body.month);
  const stores = await M.Store.findAll({ attributes: ['store_id'], order: [['store_id','ASC']], ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}), raw: true });
  return { ...dates, storeIds: stores.map(row => String(row.store_id)) };
}
async function previewClose(ctx) {
  roles(ctx);
  const filters = await monthFilters(ctx);
  if (await isClosed(ctx.request.body.month)) ctx.throw(409, '该月份已经关账');
  const report = await rawReport(filters, undefined, false);
  ctx.body = { code: 0, data: { month: ctx.request.body.month, summary: report.summary, blockers: closeBlockers(report), previewHash: snapshot(report, ctx.request.body.month, filters.storeIds).hash } };
}
async function close(ctx) {
  roles(ctx);
  const body = ctx.request.body || {};
  const proof = evidence(body);
  await M.sequelize.transaction(async transaction => {
    const filters = await monthFilters(ctx, transaction);
    if (await isClosed(body.month, transaction)) ctx.throw(409, '该月份已经关账');
    const report = await rawReport(filters, transaction, false);
    if (closeBlockers(report).length) ctx.throw(409, '仍有成本、税务或政策分类待核实项目，不能关账');
    const frozen = snapshot(report, body.month, filters.storeIds);
    if (body.previewHash !== frozen.hash) ctx.throw(409, '报表已变化，请重新预览月结');
    await M.sequelize.query('INSERT INTO T_FINANCIAL_PROFIT_PERIOD (MONTH_KEY,SNAPSHOT_JSON,SNAPSHOT_HASH,CLOSED_BY,CLOSED_AT) VALUES (:month,:json,:hash,:name,NOW(3))',
      { replacements: { month: body.month, json: JSON.stringify(frozen.data), hash: frozen.hash, name: ctx.state.user.name || 'BOSS' }, transaction });
    await recordBusinessAction({ businessType: 'financial_profit_period', businessId: body.month, action: 'close', user: ctx.state.user,
      comment: proof.reason, detail: { hash: frozen.hash, summary: report.summary, evidence: proof.evidence }, transaction });
  });
  ctx.body = { code: 0, message: '月结快照已保存，后续差异请在开放月份登记调整' };
}
function adjustmentAmounts(body, original = {}) {
  if (['policy','policy_adjustment','policy_pending'].includes(original.entryType)) return { grossRevenue: 0, grossCost: 0, outputVat: 0, deductibleInputVat: 0, netRevenue: 0, bookCost: 0, grossProfit: 0, policyImpact: decimal(body.policyImpact, '政策损益调整', true) };

  const grossRevenue = decimal(body.grossRevenue, '含税收入调整', true), grossCost = decimal(body.grossCost, '含税成本调整', true);
  const outputVat = decimal(body.outputVat, '销项税调整', true), deductibleInputVat = decimal(body.inputVat, '分摊进项税调整', true);
  const netRevenue = E.money(grossRevenue - outputVat), bookCost = E.money(grossCost - deductibleInputVat);
  // Tax-only corrections are valid, but require explicit evidence in the same record.
  return { grossRevenue, grossCost, outputVat, deductibleInputVat, netRevenue, bookCost, grossProfit: E.money(netRevenue - bookCost) };
}
async function adjust(ctx) {
  roles(ctx);
  const body = ctx.request.body || {}, businessDate = validDate(body.businessDate), proof = evidence(body);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(body.requestKey || ''))) fail('缺少有效的防重复提交编号');
  await M.sequelize.transaction(async transaction => {
    await lockStore(ctx, body.storeId, transaction);
    if (await isClosed(businessDate.slice(0,7), transaction)) ctx.throw(409, '调整日期必须属于开放月份');
    const periods = await E.select('SELECT * FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY < :month', { month: businessDate.slice(0,7) }, transaction);
    let original;
    for (const period of periods) {
      const saved = E.parse(period.SNAPSHOT_JSON);
      original = [...saved.items,...saved.policyItems,...saved.expenseEntries].find(row => row.eventKey === body.sourceEventKey && String(row.storeId || row.scopeStoreIds?.[0]) === String(body.storeId));
      if (original) break;
    }
    if (!original && body.sourceDate) {
      const sourceDate = validDate(body.sourceDate);
      if (!await isClosed(sourceDate.slice(0,7), transaction)) ctx.throw(409, '原始日期须属于已关账月份');
      const sourceReport = await rawReport({ storeIds: [String(body.storeId)], startDate: sourceDate, endDate: sourceDate }, transaction);
      original = [...sourceReport.items,...sourceReport.policyItems,...sourceReport.expenseEntries].find(row => row.eventKey === body.sourceEventKey);
    }
    if (!original) ctx.throw(409, '未找到已关账期间的有效原始依据');
    const amounts = adjustmentAmounts(body, original);
    if (original.entryType === 'expense' && (amounts.grossRevenue !== 0 || amounts.outputVat !== 0)) ctx.throw(400, '费用调整不得填写销售收入或销项税');
    if (Object.values(amounts).every(value => value === 0)) fail('调整金额不能全部为0');
    const duplicate = await E.select('SELECT ADJUSTMENT_ID FROM T_FINANCIAL_PROFIT_ADJUSTMENT WHERE REQUEST_KEY = :key', { key: body.requestKey }, transaction);
    if (duplicate.length) ctx.throw(409, '此调整已保存，请刷新，不能重复提交');
    if (body.observedHash) {
      const sourceDate = validDate(body.sourceDate);
      const sourceFilters = await require('./financialProfitController').resolveFilters({ ...ctx, query: { startDate: sourceDate, endDate: sourceDate } });
      const live = await rawReport(sourceFilters, transaction);
      const observed = [...live.items,...live.policyItems,...live.expenseEntries].find(row => row.eventKey === body.sourceEventKey);
      if ((observed?.sourceHash || 'deleted') !== body.observedHash) ctx.throw(409, '原始依据再次变化，请重新查看差异后调整');
    }
    const category = original.entryType.startsWith('policy') ? 'policy' : original.entryType === 'expense' ? 'expense' : 'goods';
    const id = generateUUID(), saved = { ...proof, amounts, category, original, resolvedSourceHash: body.observedHash || null, sourceEventKey: body.sourceEventKey };
    await M.sequelize.query(`INSERT INTO T_FINANCIAL_PROFIT_ADJUSTMENT (ADJUSTMENT_ID,REQUEST_KEY,STORE_ID,BUSINESS_DATE,SOURCE_EVENT_KEY,DETAIL_JSON,CREATE_USER,CREATE_TIME)
      VALUES (:id,:key,:store,:date,:source,:json,:name,NOW(3))`, { replacements: { id, key: body.requestKey, store: String(body.storeId), date: businessDate,
        source: body.sourceEventKey, json: JSON.stringify(saved), name: ctx.state.user.name || ctx.state.user.phone || 'finance' }, transaction });
    await recordBusinessAction({ businessType: 'financial_profit_adjustment', businessId: id, action: 'create', user: ctx.state.user,
      comment: proof.reason, detail: saved, transaction });
  });
  ctx.body = { code: 0, message: '跨期调整已登记，原月结快照保持原值' };
}
async function history(ctx) {
  roles(ctx);
  const businessDate = validDate(ctx.query.businessDate);
  const filters = await require('./financialProfitController').resolveFilters({ ...ctx, query: { startDate: businessDate, endDate: businessDate } });
  const report = await E.query(filters, require('./financialProfitController').calculateOrder);
  const event = [...report.items,...report.policyItems,...report.expenseEntries].find(row => row.eventKey === ctx.query.eventKey);
  if (!event) ctx.throw(404, '无权查看该明细历史');
  ctx.body = { code: 0, data: await listBusinessActions('financial_profit_review', event.eventKey) };
}
module.exports = { history, review, previewClose, close, adjust, reviewAmounts, adjustmentAmounts, validDate, monthRange, closeBlockers, snapshot };
