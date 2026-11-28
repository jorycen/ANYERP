const { Op } = require('sequelize');
const M = require('../../models');
const { getUserRoles } = require('../../middleware/permission');
const { canAccessDistributor, distributorWhere } = require('../../utils/distributorScope');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const money = value => Math.round(Number(value || 0) * 100) / 100;
const plain = value => value?.toJSON ? value.toJSON() : value;
function json(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch (_) { return {}; } }
function allocation(record, task) {
  const snapshot = json(task?.reward_snapshot_json);
  if (record.resource_type === 'EDU_SUBSIDY') {
    if (snapshot.accountingVersion !== 2 || !(Number(snapshot.amount) > 0)
      || !Number.isFinite(Number(snapshot.employeeAmount)) || !Number.isFinite(Number(snapshot.productAmount))
      || money(snapshot.employeeAmount) !== money(Number(snapshot.amount) * 0.8)
      || money(Number(snapshot.employeeAmount) + Number(snapshot.productAmount)) !== money(snapshot.amount)) return { known: false, note: '历史记录缺少有效分配快照，需核对原政策' };
    const sign = Number(record.amount) < 0 ? -1 : 1;
    return { known: true, policyAmount: sign * money(snapshot.amount), employeeAmount: sign * money(snapshot.employeeAmount), productAmount: sign * money(snapshot.productAmount), note: '全额入池；个人80%为考核毛利，产品20%整笔核销后确认；不是税率或现金奖励' };
  }
  const known = record.source_type === 'MANUFACTURER_REBATE' || record.resource_type === 'MANUFACTURER_REBATE';
  return { known, policyAmount: money(record.amount), employeeAmount: known ? 0 : null, productAmount: known ? money(record.amount) : null,
    note: known ? '已通过前折/调价给销售，后返整笔核销后全额归产品端，不再新增个人业绩' : '其他返利不自动推定产品端分配' };
}
function sortTaxHistory(rows) { return rows.sort((a, b) => Number(a.detail?.revision || 0) - Number(b.detail?.revision || 0)); }
function requireFinance(ctx) {
  if (!getUserRoles(ctx.state.user).some(role => ['boss', 'admin', 'finance'].includes(role))) ctx.throw(403, '仅财务或管理员可查看政策明细');
}
async function resolve(ctx, transaction) {
  requireFinance(ctx);
  const record = await M.ResourceSettlement.findByPk(ctx.params.settlementId, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!record) ctx.throw(404, '返利池记录不存在');
  const estimate = record.source_type === 'MANUFACTURER_REBATE' ? await M.RebateEstimate.findByPk(record.source_id, { transaction }) : null;
  const task = !estimate ? await M.ResourceRightChangeOrder.findByPk(String(record.source_id || '').replace(/^PRICE_CLAIM_/, ''), { transaction }) : null;
  const orderId = estimate?.sales_order_id || task?.related_sale_order_id;
  const order = orderId ? await M.Order.findByPk(orderId, { transaction }) : null;
  const sn = !order?.store_id && record.sn_id ? await M.ProductSn.findByPk(record.sn_id, { transaction }) : null;
  const storeId = order?.store_id || sn?.store_id;
  const store = storeId ? await M.Store.findByPk(storeId, { transaction }) : null;
  const user = ctx.state.user;
  const ids = (user.accessibleStoreIds || []).map(String);
  if (!getUserRoles(user).includes('boss')) {
    if (store && (!canAccessDistributor(user, store.distributor_id) || (!ids.includes('*') && !ids.includes(String(storeId))))) ctx.throw(403, '无权查看此门店政策');
    if (!store && (!record.distributor_id || !canAccessDistributor(user, record.distributor_id))) ctx.throw(403, '历史返利缺少可验证归属，请由BOSS核查');
  }
  return { record, task, estimate, order, store };
}
async function detail(ctx) {
  const { record, task, estimate, order, store } = await resolve(ctx);
  const [adjustments, income, allocations, history] = await Promise.all([
    estimate ? M.SalesSettlementCostAdjustment.findAll({ where: { rebate_estimate_id: estimate.estimate_id }, raw: true }) : [],
    M.ProductProfitIncome.findAll({ where: { settlement_id: record.settlement_id }, raw: true, order: [['business_date', 'ASC'], ['entry_id', 'ASC']] }),
    M.RebateSettlementAllocation.findAll({ where: { settlement_id: record.settlement_id }, include: [{ model: M.RebatePostingOrder, as: 'PostingOrder', required: false }], order: [['create_time', 'ASC']] }),
    listBusinessActions('rebate_tax_evidence', record.settlement_id)
  ]);
  sortTaxHistory(history);
  const split = allocation(record, task);
  const itemId = estimate?.sales_order_item_id || json(task?.reward_snapshot_json).orderItemId;
  const productSettlement = order && itemId ? await M.ProductSettlementOrder.findOne({ where: { source_order_id: order.order_id } }) : null;
  const productItem = productSettlement ? await M.ProductSettlementItem.findOne({ where: { settlement_id: productSettlement.settlement_id, source_order_item_id: itemId } }) : null;
  const baseProductMargin = productItem?.cost_status === 'ready' ? money(productItem.gross_profit_amount) : null;

  ctx.body = { code: 0, data: { settlement: plain(record), order: order ? { orderId: order.order_id, orderNo: order.order_no, storeName: store?.name || '' } : null,
    allocation: split, recognizedProductAmount: money(income.reduce((n, row) => n + Number(row.amount), 0)),
    expectedProductAmount: split.known && ['PENDING', 'PARTIALLY_SETTLED'].includes(record.status) ? split.productAmount : 0,
    baseProductMargin, policyRealizedMargin: baseProductMargin === null ? null : money(baseProductMargin + income.reduce((n, row) => n + Number(row.amount), 0)),
    policyExpectedMargin: baseProductMargin === null || !split.known || ['CANCELLED','REVERSED'].includes(record.status) || Number(record.amount) <= 0 ? null : money(baseProductMargin + split.productAmount),
    pricingEvidence: adjustments, pricingEvidenceNote: adjustments.length ? '仅展示原销售政策调整快照，不重算历史价格' : '未记录可验证的前折金额，不以当前价格倒推',
    income, allocations: allocations.map(plain), tax: history[history.length - 1]?.detail?.after || null, taxHistory: history } };
}
function validateTax(body = {}) {
  const { invoiceMode, status, impactAmount, invoiceNo = '', evidence = '', reason = '' } = body;
  if (!['unknown', 'no_invoice', 'normal', 'red_invoice'].includes(invoiceMode) || !['pending', 'confirmed', 'not_applicable'].includes(status)) throw Object.assign(new Error('请选择有效的开票方式和处理状态'), { status: 400 });
  if (String(reason).trim().length < 2 || String(reason).length > 512 || String(evidence).length > 2000 || String(invoiceNo).length > 512) throw Object.assign(new Error('请填写2至512字的修改依据，凭据说明不超过2000字'), { status: 400 });
  let amount = null;
  if (status === 'confirmed') {
    if (impactAmount === null || impactAmount === undefined || !/^\d{1,9}(\.\d{1,2})?$/.test(String(impactAmount))) throw Object.assign(new Error('确认税务影响时须填写非负金额，最多两位小数'), { status: 400 });
    if (!String(evidence).trim()) throw Object.assign(new Error('请填写税务处理凭据或判断依据'), { status: 400 });
    amount = money(impactAmount);
  }
  return { invoiceMode, status, impactAmount: amount, invoiceNo: String(invoiceNo).trim(), evidence: String(evidence).trim() };
}
async function saveTax(ctx) {
  requireFinance(ctx);
  const after = validateTax(ctx.request.body);
  await M.sequelize.transaction(async transaction => {
    const { record } = await resolve(ctx, transaction);
    const history = sortTaxHistory(await listBusinessActions('rebate_tax_evidence', record.settlement_id));
    await recordBusinessAction({ businessType: 'rebate_tax_evidence', businessId: record.settlement_id, businessNo: record.settlement_no,
      action: 'update_tax_evidence', user: ctx.state.user, comment: ctx.request.body.reason,
      detail: { revision: Number(history[history.length - 1]?.detail?.revision || 0) + 1, before: history[history.length - 1]?.detail?.after || null, after }, transaction });
  });
  ctx.body = { code: 0, message: '处理依据已保存，仅作经营核对记录', data: after };
}
async function credit(ctx) {
  const { record } = await resolve(ctx);
  if (!record.counterparty_id) ctx.throw(409, '此记录缺少供应商');
  const user = ctx.state.user;
  const [ledger, requests] = await Promise.all([
    M.SupplierRebate.findAll({ where: { supplier_id: record.counterparty_id, ...distributorWhere(user) }, raw: true, order: [['create_time', 'DESC'], ['rebate_id', 'DESC']], limit: 200 }),
    M.PurchaseRequest.findAll({ where: { supplier_id: record.counterparty_id, ...distributorWhere(user), rebate_deduction: { [Op.gt]: 0 },
      ...(getUserRoles(user).includes('boss') || (user.accessibleStoreIds || []).includes('*') ? {} : { store_id: { [Op.in]: user.accessibleStoreIds || [] } }) },
      attributes: ['request_id', 'request_no', 'status', 'total_amount', 'rebate_deduction', 'actual_total', 'create_time'], raw: true, order: [['create_time', 'DESC']], limit: 200 })
  ]);
  ctx.body = { code: 0, data: { supplierName: record.counterparty_name, availableBalance: getUserRoles(user).includes('boss') && ledger.length ? money(ledger[0].balance) : null,
    purchases: requests, ledger, note: '供应商额度可跨政策合并使用，以下不虚构逐笔政策与采购的分摊关系。待审批采购扣减属于额度占用；已审批扣减属于采购抵用。列表最多展示最近200张采购单，余额仅BOSS可查看全供应商口径。' } };
}
module.exports = { detail, saveTax, credit, allocation, validateTax, sortTaxHistory };
