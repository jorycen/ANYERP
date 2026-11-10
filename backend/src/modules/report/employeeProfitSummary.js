const { Op } = require('sequelize');
const M = require('../../models');
const { buildRanges, buildEmployeePerformance, canViewProfit } = require('./dashboardService');
const { RealtimeSqlDashboardDataSource } = require('./dashboardDataSource');
const deduction = require('../finance/expenseProfitDeduction');
const { employeeEstimate, money } = require('./employeeCommission');
const C = require('./commissionConfig');
const { sendExcel } = require('../../utils/excelExport');
const { isSelfOnlyReportUser } = require('../../utils/storePermissions');
function periods(query) {
  const start = String(query.startDate || ''), end = String(query.endDate || '');
  const valid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  const fail = () => { throw Object.assign(new Error('请选择有效日期范围（最多12个月）'), { status: 400 }); };
  if (!valid(start) || !valid(end) || start > end) fail();
  const out = []; let date = start;
  while (date <= end) {
    const month = date.slice(0,7), last = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5)), 0)).toISOString().slice(0,10);
    out.push({ month, startDate: date, endDate: end < last ? end : last });
    if (out.length > 12) fail();
    date = new Date(Date.parse(last) + 86400000).toISOString().slice(0,10);
  }
  return out;
}
async function load(user, query) {
  if (!canViewProfit(user)) throw Object.assign(new Error('无权查看员工毛利汇总'), { status: 403 });
  const chunks = periods(query), stores = await C.scope(user, query.storeId), storeIds = stores.map(s => String(s.store_id));
  const selected = isSelfOnlyReportUser(user) ? String(user.staffId) : String(query.employeeId || '');
  const source = new RealtimeSqlDashboardDataSource(), combined = new Map();
  const panels = { sales: { grossProfit: 0, commission: 0 }, product: { grossProfit: 0, commission: null }, operations: { grossProfit: 0, commission: null } };
  for (const period of chunks) {
    const range = buildRanges(period).current, filters = { storeIds, storeId: query.storeId || '', archiveScope: 'archived' };
    const [orders, adjustments, configs, expenses] = await Promise.all([
      storeIds.length ? source.getEmployeeOrderRows(filters, range) : [],
      storeIds.length ? source.getApprovedAdjustments(filters, range) : [], C.options(user, period.month, query.storeId),
      deduction.loadMonthly({ storeIds, user, startDate: period.startDate, endDate: period.endDate })
    ]);
    const ranks = deduction.attachMonthly(buildEmployeePerformance(orders, adjustments, '', true).ranking, expenses);
    for (const staff of configs.employees) if (!ranks.some(r => String(r.staffId) === staff.staffId)) ranks.push({ staffId: staff.staffId, employeeName: staff.employeeName, grossProfit: 0, netGrossProfit: 0, expensePerformanceDeduction: 0 });
    const people = ranks.length ? await M.Staff.findAll({ where: { staff_id: { [Op.in]: ranks.map(x => x.staffId).filter(Boolean) } }, raw: true }) : [];
    const financial = storeIds.length ? await require('./financialProfitController').queryFinancialProfit({ storeIds, ...period, includeStores: true }) : { summary: {}, storeSummaries: [] };
    for (const key of ['product', 'operations']) {
      const value = financial.summary[key === 'product' ? 'productGrossProfit' : 'operationsGrossProfit'];
      panels[key].grossProfit = selected || value == null || panels[key].grossProfit === null ? null : money(panels[key].grossProfit + value);
    }
    for (const row of ranks) {
      if (selected && String(row.staffId) !== selected) continue;
      const person = people.find(p => String(p.staff_id) === String(row.staffId));
      const store = stores.find(s => String(s.store_id) === String(person?.store_id));
      const option = configs.employees.find(s => s.staffId === String(row.staffId));
      const sc = configs.stores.find(s => s.storeId === store?.store_id);
      const roles = String(option?.roles || person?.role_code || '').split(',');
      const isManager = roles.some(r => ['manager','store_manager','store_admin'].includes(r)) || String(store?.manager_staff_id) === String(row.staffId);
      const storeSummary = financial.storeSummaries?.find(s => String(s.storeId) === String(store?.store_id))?.summary;
      const storeGross = storeSummary?.salesGrossProfit;
      const estimate = employeeEstimate({ ...row, isManager }, row.netGrossProfit, storeGross, { commissionBase: option?.commissionBase, breakEvenLine: sc?.breakEvenLine });
      if (!store) Object.assign(estimate, { salesCommission: null, storeCommission: null, performanceEstimate: null, status: 'unconfigured', reason: '员工当前门店未匹配' });
      const key = String(row.staffId || row.employeeName), previous = combined.get(key);
      const current = { ...row, storeId: store?.store_id || '', storeName: store?.name || '未匹配当前门店', role: option?.roleNames || roles.join(' / '),
        commissionBase: estimate.rule === 'staff' ? option?.commissionBase ?? null : null,
        breakEvenLine: estimate.rule === 'manager' ? sc?.breakEvenLine ?? null : null,
        storeGrossProfit: estimate.rule === 'manager' ? storeGross ?? null : null, ...estimate,
        remark: `${period.month}：${estimate.reason || '已计算'}；店长仅使用全店销售端毛利；产品/运营提成待定；按月计算，区间内不折算基数` };
      if (previous) {
        for (const field of ['grossProfit','expensePerformanceDeduction','netGrossProfit','salesCommission','storeCommission','performanceEstimate','storeGrossProfit']) current[field] = previous[field] == null || current[field] == null ? null : money(previous[field] + Number(current[field]));
        current.status = [previous.status, current.status].includes('unconfigured') ? 'unconfigured' : current.performanceEstimate == null ? 'pending' : 'estimated';
        current.personalRate = null;
        current.remark = previous.remark + '；' + current.remark;
        current.commissionBase = null; current.breakEvenLine = null; current.remark += '；跨月参数按各月配置';
      }
      combined.set(key, current);
    }
  }
  const rows = [...combined.values()].sort((a,b) => Number(b.netGrossProfit) - Number(a.netGrossProfit));
  panels.sales.grossProfit = rows.some(r => r.netGrossProfit == null) ? null : money(rows.reduce((s,r) => s + Number(r.netGrossProfit),0));
  panels.sales.commission = rows.some(r => r.performanceEstimate == null) ? null : money(rows.reduce((s,r) => s + Number(r.performanceEstimate),0));
  panels.sales.status = rows.some(r => r.status === 'unconfigured') ? 'unconfigured' : panels.sales.commission == null ? 'pending' : 'estimated';
  return { rows, panels, canConfigure: C.canConfigure(user), note: '员工毛利沿用业绩分摊及费用扣减；店长达标判断及门店提成仅基于全店销售端毛利。选择员工时产品/运营毛利暂不归属个人。绩效预估仅含销售及店长门店提成。' };
}
async function report(ctx) { ctx.body = { code: 0, data: await load(ctx.state.user, ctx.query) }; }
async function config(ctx) { if (!C.canConfigure(ctx.state.user)) ctx.throw(403, '无权配置提成参数'); ctx.body = { code: 0, data: await C.options(ctx.state.user, ctx.query.month, ctx.query.storeId) }; }
function exportRows(rows) { return rows.map(r => { const missing = r.status === 'pending' ? '待核算' : '待配置'; return ({ 员工: r.employeeName, 门店: r.storeName, 角色: r.role, 毛利: r.grossProfit,
  费用扣减: r.expensePerformanceDeduction, 扣减后毛利: r.netGrossProfit, 提成基数: r.commissionBase ?? '未配置/跨月', 盈亏平衡线: r.breakEvenLine ?? '未配置/跨月',
  门店销售端毛利: r.rule === 'staff' ? '不适用' : r.storeGrossProfit ?? '待核算', 店长个人提成比例: r.personalRate == null ? (r.rule === 'staff' ? '不适用' : '待核算/跨月') : `${r.personalRate * 100}%`,
  销售端提成: r.salesCommission ?? missing, 店长门店提成: r.storeCommission ?? missing, 产品端提成: '待定', 运营端提成: '待定', 绩效预估: r.performanceEstimate ?? missing, 备注: r.remark }); }); }
async function exportReport(ctx) {
  const data = await load(ctx.state.user, ctx.query);
  sendExcel(ctx, exportRows(data.rows), ['员工','门店','角色','毛利','费用扣减','扣减后毛利','提成基数','盈亏平衡线','门店销售端毛利','店长个人提成比例','销售端提成','店长门店提成','产品端提成','运营端提成','绩效预估','备注'], '员工毛利汇总.xlsx');
}
module.exports = { periods, load, report, config, exportReport, exportRows };
