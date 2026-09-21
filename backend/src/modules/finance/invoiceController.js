const { PurchaseInvoice, PurchaseInvoiceAllocation, SettlementPaymentRecord, Settlement, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { canAccessDistributor, distributorWhere } = require('../../utils/distributorScope');
const { sendExcel } = require('../../utils/excelExport');

const money = value => Math.round(Number(value || 0) * 100) / 100;
const text = value => String(value || '').trim();

function scope(where, user) { Object.assign(where, distributorWhere(user)); return where; }

function chinaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

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
      供应商: data.supplier_name || '', 销方税号: data.supplier_tax_no || '',
      发票号码: data.invoice_no || '', 开票日期: data.invoice_date || '', 票种: data.invoice_type || '',
      税率: data.tax_rate === null || data.tax_rate === undefined ? '' : `${money(Number(data.tax_rate) * 100)}%`,
      不含税金额: money(data.amount_without_tax), 税额: money(data.tax_amount), 价税合计: money(data.total_amount),
      关联结算单: link.settlement_no || '', 本票分摊金额: link.allocation_amount === undefined ? '' : money(link.allocation_amount),
      登记人: data.create_user || '', 登记时间: data.create_time || '', 备注: data.remark || ''
    }));
  });
}

async function findInvoiceCandidates(query, user) {
  const { supplierName, status = 'open' } = query;
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
  return rows.filter(row => canAccessDistributor(user, row.distributor_id)).map(row => ({ ...row, remaining_amount: money(row.paid_amount - row.invoiced_amount), due_date: new Date(new Date(row.payment_time).getTime() + 30 * 86400000), warning_status: new Date() > new Date(new Date(row.payment_time).getTime() + 30 * 86400000) ? 'overdue' : new Date() > new Date(new Date(row.payment_time).getTime() + 20 * 86400000) ? 'near_due' : 'normal' }));
}

async function getInvoiceCandidates(ctx) {
  const visible = await findInvoiceCandidates(ctx.query, ctx.state.user);
  ctx.body = { code: 0, data: { list: visible, summary: { receivable_amount: money(visible.reduce((s, r) => s + Number(r.paid_amount), 0)), unreceived_amount: money(visible.reduce((s, r) => s + r.remaining_amount, 0)), overdue_amount: money(visible.filter(r => r.warning_status === 'overdue').reduce((s, r) => s + r.remaining_amount, 0)) } } };
}

async function exportInvoiceCandidates(ctx) {
  const list = await findInvoiceCandidates({ ...ctx.query, status: 'open' }, ctx.state.user);
  const rows = list.map(row => ({
    付款流水ID: row.payment_id,
    供应商: row.supplier_name || '',
    结算单号: row.settlement_no || '',
    付款时间: row.payment_time || '',
    付款金额: money(row.paid_amount),
    已登记金额: money(row.invoiced_amount),
    未登记金额: money(row.remaining_amount),
    税号: '',
    发票号码: ''
  }));
  sendExcel(ctx, rows, ['付款流水ID', '供应商', '结算单号', '付款时间', '付款金额', '已登记金额', '未登记金额', '税号', '发票号码'], `未登记发票清单_${chinaDate()}.xlsx`, '未登记发票清单', { textHeaders: ['付款流水ID', '结算单号', '税号', '发票号码'] });
}

async function listInvoices(ctx) {
  const list = await queryInvoices(buildInvoiceWhere(ctx.query, ctx.state.user));
  ctx.body = { code: 0, data: { list } };
}

async function exportInvoices(ctx) {
  const list = await queryInvoices(buildInvoiceWhere(ctx.query, ctx.state.user));
  sendExcel(ctx, invoiceExportRows(list), [
    '供应商', '销方税号', '发票号码', '开票日期', '票种', '税率',
    '不含税金额', '税额', '价税合计', '关联结算单', '本票分摊金额', '登记人', '登记时间', '备注'
  ], `采购进项发票_${new Date().toISOString().slice(0, 10)}.xlsx`, '采购进项发票');
}

async function createInvoice(ctx) {
  const body = ctx.request.body || {}; const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const supplierTaxNo = text(body.supplierTaxNo), invoiceNo = text(body.invoiceNo);
  const total = money(body.totalAmount), withoutTax = money(body.amountWithoutTax), tax = money(body.taxAmount);
  if (!supplierTaxNo || !invoiceNo || !body.invoiceDate || !text(body.invoiceType)) ctx.throw(400, '请完整填写发票信息');
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
    const invoice = await PurchaseInvoice.create({ invoice_id: generateUUID(), distributor_id: first.distributor_id, supplier_name: first.supplier_name, supplier_tax_no: supplierTaxNo, invoice_code: '', invoice_no: invoiceNo, invoice_date: body.invoiceDate, invoice_type: text(body.invoiceType), tax_rate: body.taxRate == null || body.taxRate === '' ? null : Number(body.taxRate), amount_without_tax: withoutTax, tax_amount: tax, total_amount: total, remark: text(body.remark), create_user: ctx.state.user.name || ctx.state.user.staffId }, { transaction });
    for (const [index, allocation] of allocations.entries()) await PurchaseInvoiceAllocation.create({ allocation_id: generateUUID(), invoice_id: invoice.invoice_id, payment_id: allocation.paymentId, settlement_id: paymentRows[index].settlement_id, amount: money(allocation.amount) }, { transaction });
  });
  ctx.body = { code: 0, message: '发票已登记并计入已收票' };
}

function normalizeInvoiceImportRows(rows) {
  const selected = [];
  const errors = [];
  const seenPayments = new Set();
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const rowNo = Number(row.excelRow) || index + 2;
    const paymentId = text(row.paymentId ?? row['付款流水ID']);
    const supplierTaxNo = text(row.supplierTaxNo ?? row['税号']);
    const invoiceNo = text(row.invoiceNo ?? row['发票号码']);
    if (!supplierTaxNo && !invoiceNo) return;
    if (!paymentId) return errors.push({ row: rowNo, message: '付款流水ID缺失，请使用系统导出的文件' });
    if (!supplierTaxNo || !invoiceNo) return errors.push({ row: rowNo, message: '税号和发票号码必须同时填写' });
    if (seenPayments.has(paymentId)) return errors.push({ row: rowNo, message: '付款流水ID重复' });
    seenPayments.add(paymentId);
    selected.push({ row: rowNo, paymentId, supplierTaxNo, invoiceNo });
  });
  if (!selected.length && !errors.length) errors.push({ row: 0, message: '没有找到已填写税号和发票号码的记录' });
  return { selected, errors };
}

async function importInvoices(ctx) {
  const parsed = normalizeInvoiceImportRows(ctx.request.body?.rows);
  if (parsed.errors.length) {
    ctx.body = { code: 400, message: '导入校验失败，整批未处理', data: { errors: parsed.errors } };
    return;
  }
  const groups = new Map();
  parsed.selected.forEach(row => {
    const key = `${row.supplierTaxNo}\u0000${row.invoiceNo}`;
    if (!groups.has(key)) groups.set(key, { supplierTaxNo: row.supplierTaxNo, invoiceNo: row.invoiceNo, rows: [] });
    groups.get(key).rows.push(row);
  });

  const result = await sequelize.transaction(async transaction => {
    let allocationCount = 0;
    for (const group of groups.values()) {
      const duplicate = await PurchaseInvoice.findOne({ where: { supplier_tax_no: group.supplierTaxNo, invoice_no: group.invoiceNo }, transaction });
      if (duplicate) ctx.throw(400, `发票号码 ${group.invoiceNo} 已登记，请勿重复导入`);
      const payments = [];
      const allocations = [];
      for (const source of group.rows) {
        const payment = await SettlementPaymentRecord.findOne({ where: { payment_id: source.paymentId, status: 'active' }, include: [{ model: Settlement, required: true, where: { tax_status: 'TAX_INCLUDED' } }], transaction, lock: transaction.LOCK.UPDATE });
        if (!payment || !canAccessDistributor(ctx.state.user, payment.distributor_id)) ctx.throw(400, `第${source.row}行付款记录不存在、已冲销或无权限`);
        const used = money(await PurchaseInvoiceAllocation.sum('amount', { where: { payment_id: payment.payment_id }, transaction }) || 0);
        const remaining = money(Number(payment.amount || 0) - used);
        if (remaining <= 0) ctx.throw(400, `第${source.row}行结算单 ${payment.settlement_no} 已完成发票登记`);
        payments.push(payment);
        allocations.push({ payment, amount: remaining });
      }
      const first = payments[0];
      if (payments.some(payment => String(payment.distributor_id || '') !== String(first.distributor_id || ''))) ctx.throw(400, `发票 ${group.invoiceNo} 关联了不同经销商`);
      if (payments.some(payment => String(payment.supplier_name || '') !== String(first.supplier_name || ''))) ctx.throw(400, `发票 ${group.invoiceNo} 关联了不同供应商`);
      const total = money(allocations.reduce((sum, row) => sum + row.amount, 0));
      const withoutTax = money(total / 1.13);
      const invoice = await PurchaseInvoice.create({
        invoice_id: generateUUID(), distributor_id: first.distributor_id, supplier_name: first.supplier_name,
        supplier_tax_no: group.supplierTaxNo, invoice_code: '', invoice_no: group.invoiceNo,
        invoice_date: chinaDate(), invoice_type: '增值税专用发票', tax_rate: 0.13,
        amount_without_tax: withoutTax, tax_amount: money(total - withoutTax), total_amount: total,
        remark: 'Excel批量导入', create_user: ctx.state.user.name || ctx.state.user.staffId
      }, { transaction });
      for (const allocation of allocations) {
        await PurchaseInvoiceAllocation.create({ allocation_id: generateUUID(), invoice_id: invoice.invoice_id, payment_id: allocation.payment.payment_id, settlement_id: allocation.payment.settlement_id, amount: allocation.amount }, { transaction });
        allocationCount += 1;
      }
    }
    return { invoiceCount: groups.size, allocationCount };
  });
  ctx.body = { code: 0, message: `成功登记 ${result.invoiceCount} 张发票，共关联 ${result.allocationCount} 笔付款`, data: result };
}

module.exports = { getInvoiceCandidates, exportInvoiceCandidates, listInvoices, exportInvoices, createInvoice, importInvoices, _test: { buildInvoiceSettlementLinks, invoiceExportRows, normalizeInvoiceImportRows } };
