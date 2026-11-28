const { Op } = require('sequelize');
const M = require('../../models');
const { canAccessDistributor } = require('../../utils/distributorScope');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const { getAllocationSummary, getPayableRemaining, getSettlementItemAvailableAmount, refreshPayableState, refreshExpenseState } = require('./settlementAllocation');
const money = value => Math.round(Number(value) * 100) / 100;

async function prepare(ctx, transaction, settlement = null) {
  settlement ||= await M.Settlement.findOne({ where: { settlement_id: ctx.params.id, is_deleted: 0 }, transaction, lock: transaction.LOCK.UPDATE });
  if (!settlement || settlement.is_deleted) ctx.throw(404, '结算单不存在');
  if (!canAccessDistributor(ctx.state.user, settlement.distributor_id)) ctx.throw(403, '无权操作该经销商结算单');
  if (settlement.status !== 'draft') ctx.throw(409, '只有草稿结算单可以编辑或重新提交，请刷新');
  if (Number(settlement.paid_amount || 0) !== 0 || await M.SettlementPaymentRecord.findOne({ where: { settlement_id: settlement.settlement_id, status: 'active' }, transaction })) ctx.throw(409, '已有付款记录，不能修改结算草稿');
  if (await M.ApprovalFlowInstance.findOne({ where: { business_type: 'payable_settlement', business_id: settlement.settlement_id, status: 'pending' }, transaction })) ctx.throw(409, '结算单仍有在途审批，请先撤回');
  const items = await M.SettlementItem.findAll({ where: { settlement_id: settlement.settlement_id }, order: [['item_id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  if (!items.length) ctx.throw(409, '结算单缺少明细，请核对原单');
  const ids = [...new Set(items.map(row => String(row.payable_id)))];
  const payables = await M.Payable.findAll({ where: { payable_id: { [Op.in]: ids } }, order: [['payable_id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  if (payables.length !== ids.length || payables.some(row => String(row.distributor_id || '') !== String(settlement.distributor_id || '') || ['voided', 'cancelled'].includes(row.status))) ctx.throw(409, '来源应付款不存在、已作废或归属不一致');
  const requestIds = items.map(row => row.request_item_id).filter(Boolean);
  const [summary, requestItems, deltas] = await Promise.all([
    getAllocationSummary(ids, transaction, { excludeSettlementId: settlement.settlement_id }),
    requestIds.length ? M.PurchaseRequestItem.findAll({ where: { item_id: { [Op.in]: requestIds } }, transaction }) : [],
    require('./payableController').getPurchaseAdjustmentQuantityDeltasForDraft(payables.map(row => row.request_id), transaction)
  ]);
  return { settlement, items, payables, summary, requestItems: new Map(requestItems.map(row => [String(row.item_id), row])), deltas };
}

function validateItems(ctx, state, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) ctx.throw(400, '至少保留一条结算明细');
  const byId = new Map(state.items.map(row => [String(row.item_id), row]));
  const payables = new Map(state.payables.map(row => [String(row.payable_id), row]));
  const used = new Map([...state.summary].map(([id, row]) => [id, { amount: row.amount, amountByItem: new Map(row.amountByItem) }]));
  const seen = new Set(), planned = [];
  for (const edit of incoming) {
    const id = String(edit.itemId || ''), item = byId.get(id);
    if (!item || seen.has(id)) ctx.throw(400, '结算明细不属于本单或重复');
    seen.add(id);
    if (edit.amount === '' || edit.amount == null || !Number.isFinite(Number(edit.amount)) || Math.abs(Number(edit.amount) * 100 - Math.round(Number(edit.amount) * 100)) > 0.000001) ctx.throw(400, '结算金额必须为有效数字，最多两位小数');
    const amount = money(edit.amount), payable = payables.get(String(item.payable_id));
    const allocation = used.get(String(item.payable_id)) || { amount: 0, amountByItem: new Map() };
    const remaining = getPayableRemaining(payable.total_amount, allocation.amount, payable.offset_amount);
    if (Number(payable.total_amount) < 0 ? (amount > 0 || amount < remaining - 0.005) : (amount < 0 || amount > remaining + 0.005)) ctx.throw(409, `来源单 ${item.request_no || item.payable_id} 的金额超过剩余可结算金额，请刷新`);
    if (item.request_item_id && Number(payable.total_amount) >= 0) {
      const request = state.requestItems.get(String(item.request_item_id));
      if (!request) ctx.throw(409, '来源采购商品不存在');
      const available = getSettlementItemAvailableAmount(request, allocation.amountByItem.get(String(item.request_item_id)) || 0, state.deltas.get(String(item.request_item_id)) || 0);
      if (amount > available + 0.005) ctx.throw(409, `商品 ${item.product_name || ''} 超过剩余可结算金额`);
      allocation.amountByItem.set(String(item.request_item_id), (allocation.amountByItem.get(String(item.request_item_id)) || 0) + amount);
    }
    allocation.amount = money(allocation.amount + amount); used.set(String(item.payable_id), allocation);
    planned.push({ item, amount });
  }
  let rebateAllocations = [];
  try { rebateAllocations = JSON.parse(state.settlement.rebate_allocation_json || '[]'); } catch (_) { ctx.throw(409, '原返利分配记录异常'); }
  if (rebateAllocations.some(row => Number(row.amount) > 0 && !planned.some(line => String(line.item.payable_id) === String(row.payableId)))) ctx.throw(400, '已分配返利的来源应付款须保留，不能删除全部关联行');
  if (!planned.some(row => row.amount !== 0) && !(Number(state.settlement.rebate_deduction) > 0)) ctx.throw(400, '至少保留一项非零结算金额');
  return planned;
}

async function getDraft(ctx) {
  await M.sequelize.transaction(async transaction => {
    const state = await prepare(ctx, transaction);
    const accounts = state.settlement.supplier_id ? await M.SupplierPaymentAccount.findAll({ where: { supplier_id: state.settlement.supplier_id, status: 1, is_deleted: 0 }, transaction, raw: true }) : [];
    let accountSnapshot = {};
    try { accountSnapshot = JSON.parse(state.settlement.supplier_account_snapshot || '{}'); } catch (_) {}
    ctx.body = { code: 0, data: { ...state.settlement.toJSON(), supplier_account_snapshot_parsed: accountSnapshot, items: state.items.map(row => row.toJSON()), paymentAccounts: accounts } };
  });
}
async function updateDraft(ctx) {
  await M.sequelize.transaction(async transaction => {
    const state = await prepare(ctx, transaction), body = ctx.request.body || {};
    if (Object.keys(body).some(key => !['items', 'remark', 'supplierAccountId'].includes(key))) ctx.throw(400, '包含不可编辑的结算字段');
    const planned = validateItems(ctx, state, body.items);
    const before = { ...state.settlement.toJSON(), items: state.items.map(row => row.toJSON()) };
    const patch = { total_amount: money(planned.reduce((sum, row) => sum + row.amount, 0)), remark: body.remark === undefined ? state.settlement.remark : String(body.remark || '').trim().slice(0,512) || null };
    patch.payment_status = patch.total_amount < 0 ? 'pending_refund' : patch.total_amount === 0 ? 'settled' : 'unpaid';
    if (body.supplierAccountId) {
      const account = await M.SupplierPaymentAccount.findOne({ where: { account_id: body.supplierAccountId, supplier_id: state.settlement.supplier_id, status: 1, is_deleted: 0 }, transaction });
      if (!account) ctx.throw(400, '收款账户不属于本供应商或已停用');
      patch.supplier_account_id = account.account_id;
      patch.supplier_account_snapshot = JSON.stringify({ accountId: account.account_id, companyName: account.company_name || '', taxNo: account.tax_no || '', bankName: account.bank_name || '', accountNumber: account.account_number || '', remark: account.remark || '' });
      patch.other_payment_remark = null; patch.other_payment_image = null;
    }
    const kept = new Set(planned.map(row => String(row.item.item_id)));
    for (const item of state.items) if (!kept.has(String(item.item_id))) await item.destroy({ transaction });
    for (const { item, amount } of planned) if (Number(item.amount) !== amount) await item.update({ amount, quantity: null }, { transaction });
    await state.settlement.update(patch, { transaction });
    for (const payable of state.payables) await refreshPayableState(payable.payable_id, transaction);
    const expenses = await M.Expense.findAll({ where: { payable_id: { [Op.in]: state.payables.map(row => row.payable_id) } }, transaction });
    for (const expense of expenses) await refreshExpenseState(expense.expense_id, transaction);
    await recordBusinessAction({ businessType: 'payable_settlement', businessId: state.settlement.settlement_id, businessNo: state.settlement.settlement_no,
      action: 'draft_updated', user: ctx.state.user, detail: { before, after: { ...patch, items: planned.map(row => ({ itemId: row.item.item_id, amount: row.amount })) } }, transaction });
    ctx.body = { code: 0, message: '草稿已保存，可重新提交审批' };
  });
}
async function validateForSubmit(ctx, settlement, transaction) {
  const state = await prepare(ctx, transaction, settlement);
  validateItems(ctx, state, state.items.map(row => ({ itemId: row.item_id, amount: row.amount })));
}
module.exports = { getDraft, updateDraft, validateItems, validateForSubmit };
