const { PurchaseInvoice, PurchaseInvoiceAllocation, SettlementPaymentRecord, Settlement, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { canAccessDistributor, distributorWhere } = require('../../utils/distributorScope');
const { sendExcel } = require('../../utils/excelExport');

const money = value => Math.round(Number(value || 0) * 100) / 100;
const text = value => String(value || '').trim();

function scope(where, user) { Object.assign(where, distributorWhere(user)); return where; }

function buildInvoiceWhere(query, user) {
  const where = scope({ status: 'active' }, user);
  if (query.keyword) where[Op.or] = ['invoice_no', 'supplier_name'].map(key => ({ [key]: { [Op.like]: `%${text(query.keyword)}%` } }));
  if (query.startDate || query.endDate) {
    where.invoice_date = {};
    if (query.startDate) where.invoice_date[Op.gte] = query.startDate;
    if (query.endDate) where.invoice_date[Op.lte] = query.endDate;
  }
  return where;
}

async function queryInvoices(where) {
  const list = await PurchaseInvoice.findAll({ where, include: [{ model: PurchaseInvoiceAllocation, as: 'allocations' }], order: [['invoice_date', 'DESC'], ['create_time', 'DESC']] });
  const settlementIds = [...new Set(list.flatMap(row => (row.allocations || []).map(item => item.settlement_id).filter(Boolean).map(String)))];
  const settlements = settlementIds.length
    ? await Settlement.findAll({ where: { settlement_id: { [Op.in]: settlementIds }, is_deleted: 0 }, attributes: ['settlement_id', 'settlement_no', 'supplier_name', 'total_amount', 'status', 'payment_status'] })
    : [];
  const settlementMap = new Map(settlements.map(row => [String(row.settlement_id), row]));
  list.forEach(invoice => {
    const links = buildInvoiceSettlementLinks(invoice.allocations, settlementMap);
    invoice.setDataValue('settlement_links', links);
  });
  return list;
}

function buildInvoiceSettlementLinks(allocations = [], settlementMap = new Map()) {
  const links = new Map();
  allocations.forEach(allocation => {
    const settlementId = String(allocation.settlement_id || '');
    if (!settlementId) return;
    const settlement = settlementMap.get(settlementId);
    const current = links.get(settlementId);
    if (current) {
      current.allocation_amount = money(current.allocation_amount + Number(allocation.amount || 0));
      return;
    }
    links.set(settlementId, {
      settlement_id: allocation.settlement_id,
      settlement_no: settlement?.settlement_no || allocation.settlement_id,
      allocation_amount: money(allocation.amount),
      settlement_total_amount: settlement ? money(settlement.total_amount) : null,
      status: settlement?.status || '',
      payment_status: settlement?.payment_status || ''
    });
  });
  return [...links.values()];
}

function invoiceExportRows(list) {
  return list.flatMap(invoice => {
    const data = invoice.toJSON ? invoice.toJSON() : invoice;
    const links = data.settlement_links?.length ? data.settlement_links : [{}];
    return links.map(link => ({
      供应商: data.supplier_name || '', 销方税号: data.supplier_tax_no || '', 发票代码: data.invoice_code || '',
      发票号码: data.invoice_no || '', 开票日期: data.invoice_date || '', 票种: data.invoice_type || '',
      税率: data.tax_rate === null || data.tax_rate === undefined ? '' : `${money(Number(data.tax_rate) * 100)}%`,
      不含税金额: money(data.amount_without_tax), 税额: money(data.tax_amount), 价税合计: money(data.total_amount),
      关联结算单: link.settlement_no || '', 本票分摊金额: link.allocation_amount === undefined ? '' : money(link.allocation_amount),
      登记人: data.create_user || '', 登记时间: data.create_time || '', 备注: data.remark || ''
    }));
  });
}

async function getInvoiceCandidates(ctx) {
  const { supplierName, status = 'open' } = ctx.query;
  const rows = await sequelize.query(`
    SELECT p.PAYMENT_ID payment_id, p.SETTLEMENT_ID settlement_id, p.SETTLEMENT_NO settlement_no,
      p.SUPPLIER_NAME supplier_name, p.DISTRIBUTOR_ID distributor_id, p.AMOUNT paid_amount, p.PAYMENT_TIME payment_time,
      COALESCE(SUM(CASE WHEN i.INVOICE_ID IS NULL THEN 0 ELSE a.AMOUNT END), 0) invoiced_amount
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
  const list = await queryInvoices(buildInvoiceWhere(ctx.query, ctx.state.user));
  ctx.body = { code: 0, data: { list } };
}

async function exportInvoices(ctx) {
  const list = await queryInvoices(buildInvoiceWhere(ctx.query, ctx.state.user));
  sendExcel(ctx, invoiceExportRows(list), [
    '供应商', '销方税号', '发票代码', '发票号码', '开票日期', '票种', '税率',
    '不含税金额', '税额', '价税合计', '关联结算单', '本票分摊金额', '登记人', '登记时间', '备注'
  ], `采购进项发票_${new Date().toISOString().slice(0, 10)}.xlsx`, '采购进项发票');
}

async function createInvoice(ctx) {
  const body = ctx.request.body || {}; const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const supplierTaxNo = text(body.supplierTaxNo), invoiceCode = text(body.invoiceCode), invoiceNo = text(body.invoiceNo);
  const total = money(body.totalAmount), withoutTax = money(body.amountWithoutTax), tax = money(body.taxAmount);
  if (!supplierTaxNo || !invoiceCode || !invoiceNo || !body.invoiceDate || !text(body.invoiceType)) ctx.throw(400, '请完整填写发票信息');
  if (total <= 0 || withoutTax < 0 || tax < 0 || money(withoutTax + tax) !== total) ctx.throw(400, '发票金额或税额不正确');
  if (!allocations.length || money(allocations.reduce((s, row) => s + Number(row.amount || 0), 0)) !== total) ctx.throw(400, '发票总额必须与付款分摊金额一致');
  if (new Set(allocations.map(row => String(row.paymentId || ''))).size !== allocations.length) ctx.throw(400, '同一付款流水不能重复分摊');
  await sequelize.transaction(async transaction => {
    const paymentRows = [];
    for (const allocation of allocations) {
      const payment = await SettlementPaymentRecord.findOne({ where: { payment_id: allocation.paymentId, status: 'active' }, include: [{ model: Settlement, required: true, where: { tax_status: 'TAX_INCLUDED' } }], transaction, lock: transaction.LOCK.UPDATE });
      if (!payment || !canAccessDistributor(ctx.state.user, payment.distributor_id)) ctx.throw(400, '付款记录不存在、已冲销或无权限');
      const used = money(await PurchaseInvoiceAllocation.sum('amount', { where: { payment_id: payment.payment_id }, transaction }) || 0);
      if (money(allocation.amount) <= 0 || money(used + Number(allocation.amount)) > money(payment.amount)) ctx.throw(400, `付款单 ${payment.settlement_no} 的可收票余额不足`);
      paymentRows.push(payment);
    }
    const first = paymentRows[0];
    if (paymentRows.some(payment => String(payment.distributor_id || '') !== String(first.distributor_id || ''))) ctx.throw(400, '一张发票不能关联不同经销商的付款');
    if (paymentRows.some(payment => String(payment.supplier_name || '') !== String(first.supplier_name || ''))) ctx.throw(400, '一张发票不能关联不同供应商的付款');
    const invoice = await PurchaseInvoice.create({ invoice_id: generateUUID(), distributor_id: first.distributor_id, supplier_name: first.supplier_name, supplier_tax_no: supplierTaxNo, invoice_code: invoiceCode, invoice_no: invoiceNo, invoice_date: body.invoiceDate, invoice_type: text(body.invoiceType), tax_rate: body.taxRate == null || body.taxRate === '' ? null : Number(body.taxRate), amount_without_tax: withoutTax, tax_amount: tax, total_amount: total, remark: text(body.remark), create_user: ctx.state.user.name || ctx.state.user.staffId }, { transaction });
    for (const [index, allocation] of allocations.entries()) await PurchaseInvoiceAllocation.create({ allocation_id: generateUUID(), invoice_id: invoice.invoice_id, payment_id: allocation.paymentId, settlement_id: paymentRows[index].settlement_id, amount: money(allocation.amount) }, { transaction });
  });
  ctx.body = { code: 0, message: '发票已登记并计入已收票' };
}
module.exports = { getInvoiceCandidates, listInvoices, exportInvoices, createInvoice, _test: { buildInvoiceSettlementLinks, invoiceExportRows } };
