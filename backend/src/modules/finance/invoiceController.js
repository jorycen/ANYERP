const { PurchaseInvoice, PurchaseInvoiceAllocation, SettlementPaymentRecord, Settlement, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { canAccessDistributor, distributorWhere } = require('../../utils/distributorScope');

const money = value => Math.round(Number(value || 0) * 100) / 100;
const text = value => String(value || '').trim();

function scope(where, user) { Object.assign(where, distributorWhere(user)); return where; }

async function getInvoiceCandidates(ctx) {
  const { supplierName, status = 'open' } = ctx.query;
  const rows = await sequelize.query(`
    SELECT p.PAYMENT_ID payment_id, p.SETTLEMENT_ID settlement_id, p.SETTLEMENT_NO settlement_no,
      p.SUPPLIER_NAME supplier_name, p.DISTRIBUTOR_ID distributor_id, p.AMOUNT paid_amount, p.PAYMENT_TIME payment_time,
      COALESCE(SUM(a.AMOUNT), 0) invoiced_amount
    FROM T_SETTLEMENT_PAYMENT_RECORD p
    INNER JOIN T_SETTLEMENT s ON s.SETTLEMENT_ID = p.SETTLEMENT_ID
    LEFT JOIN T_PURCHASE_INVOICE_ALLOCATION a ON a.PAYMENT_ID = p.PAYMENT_ID
    LEFT JOIN T_PURCHASE_INVOICE i ON i.INVOICE_ID = a.INVOICE_ID AND i.STATUS = 'active'
    WHERE p.STATUS = 'active' AND s.TAX_STATUS = 'TAX_INCLUDED'
      AND (:supplierName = '' OR p.SUPPLIER_NAME LIKE CONCAT('%', :supplierName, '%'))
    GROUP BY p.PAYMENT_ID
    HAVING (:status <> 'open' OR p.AMOUNT - COALESCE(SUM(CASE WHEN i.INVOICE_ID IS NULL THEN 0 ELSE a.AMOUNT END), 0) > 0.005)
    ORDER BY p.PAYMENT_TIME ASC`, { replacements: { supplierName: text(supplierName), status }, type: sequelize.QueryTypes.SELECT });
  const visible = rows.filter(row => canAccessDistributor(ctx.state.user, row.distributor_id)).map(row => ({ ...row, remaining_amount: money(row.paid_amount - row.invoiced_amount), due_date: new Date(new Date(row.payment_time).getTime() + 30 * 86400000), warning_status: new Date() > new Date(new Date(row.payment_time).getTime() + 30 * 86400000) ? 'overdue' : new Date() > new Date(new Date(row.payment_time).getTime() + 20 * 86400000) ? 'near_due' : 'normal' }));
  ctx.body = { code: 0, data: { list: visible, summary: { receivable_amount: money(visible.reduce((s, r) => s + Number(r.paid_amount), 0)), unreceived_amount: money(visible.reduce((s, r) => s + r.remaining_amount, 0)), overdue_amount: money(visible.filter(r => r.warning_status === 'overdue').reduce((s, r) => s + r.remaining_amount, 0)) } } };
}

async function listInvoices(ctx) {
  const where = scope({ status: 'active' }, ctx.state.user);
  if (ctx.query.keyword) where[Op.or] = ['invoice_no', 'supplier_name'].map(key => ({ [key]: { [Op.like]: `%${text(ctx.query.keyword)}%` } }));
  const list = await PurchaseInvoice.findAll({ where, include: [{ model: PurchaseInvoiceAllocation, as: 'allocations' }], order: [['invoice_date', 'DESC'], ['create_time', 'DESC']] });
  ctx.body = { code: 0, data: { list } };
}

async function createInvoice(ctx) {
  const body = ctx.request.body || {}; const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const supplierTaxNo = text(body.supplierTaxNo), invoiceCode = text(body.invoiceCode), invoiceNo = text(body.invoiceNo);
  const total = money(body.totalAmount), withoutTax = money(body.amountWithoutTax), tax = money(body.taxAmount);
  if (!supplierTaxNo || !invoiceCode || !invoiceNo || !body.invoiceDate || !text(body.invoiceType)) ctx.throw(400, '请完整填写发票信息');
  if (total <= 0 || withoutTax < 0 || tax < 0 || money(withoutTax + tax) !== total) ctx.throw(400, '发票金额或税额不正确');
  if (!allocations.length || money(allocations.reduce((s, row) => s + Number(row.amount || 0), 0)) !== total) ctx.throw(400, '发票总额必须与付款分摊金额一致');
  await sequelize.transaction(async transaction => {
    for (const allocation of allocations) {
      const payment = await SettlementPaymentRecord.findOne({ where: { payment_id: allocation.paymentId, status: 'active' }, include: [{ model: Settlement, required: true, where: { tax_status: 'TAX_INCLUDED' } }], transaction, lock: transaction.LOCK.UPDATE });
      if (!payment || !canAccessDistributor(ctx.state.user, payment.distributor_id)) ctx.throw(400, '付款记录不存在、已冲销或无权限');
      const used = money(await PurchaseInvoiceAllocation.sum('amount', { where: { payment_id: payment.payment_id }, transaction }) || 0);
      if (money(allocation.amount) <= 0 || money(used + Number(allocation.amount)) > money(payment.amount)) ctx.throw(400, `付款单 ${payment.settlement_no} 的可收票余额不足`);
    }
    const first = await SettlementPaymentRecord.findByPk(allocations[0].paymentId, { transaction });
    const invoice = await PurchaseInvoice.create({ invoice_id: generateUUID(), distributor_id: first.distributor_id, supplier_name: first.supplier_name, supplier_tax_no: supplierTaxNo, invoice_code: invoiceCode, invoice_no: invoiceNo, invoice_date: body.invoiceDate, invoice_type: text(body.invoiceType), tax_rate: body.taxRate == null || body.taxRate === '' ? null : Number(body.taxRate), amount_without_tax: withoutTax, tax_amount: tax, total_amount: total, remark: text(body.remark), create_user: ctx.state.user.name || ctx.state.user.staffId }, { transaction });
    for (const allocation of allocations) await PurchaseInvoiceAllocation.create({ allocation_id: generateUUID(), invoice_id: invoice.invoice_id, payment_id: allocation.paymentId, settlement_id: allocation.settlementId, amount: money(allocation.amount) }, { transaction });
  });
  ctx.body = { code: 0, message: '发票已登记并计入已收票' };
}
module.exports = { getInvoiceCandidates, listInvoices, createInvoice };
