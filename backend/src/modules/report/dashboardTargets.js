const M = require('../../models');
const { Op } = require('sequelize');
const money = n => Math.round(n * 100) / 100;
function monthSlices(startDate, endDate) {
  const out = [];
  for (let day = new Date(startDate + 'T00:00:00Z'); day <= new Date(endDate + 'T00:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    const month = day.toISOString().slice(0, 7), last = out[out.length - 1];
    if (last?.month === month) last.days++;
    else out.push({ month, days: 1, totalDays: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate() });
  }
  return out;
}
function prorate(tasks, slices, storeId) {
  const rows = slices.map(slice => { const matching = tasks.filter(t => t.month_key === slice.month && String(t.target_id) === String(storeId) && t.target_type === 'store' && t.status === 1);
    return matching.length === 1 && Number(matching[0].gross_profit_target) > 0 ? Number(matching[0].gross_profit_target) * slice.days / slice.totalDays : null; });
  return rows.some(n => n === null) ? null : money(rows.reduce((s, n) => s + n, 0));
}
async function load(storeIds, range) {
  if (!storeIds.length) return new Map();
  const slices = monthSlices(range.startDate, range.endDate), tasks = [];
  for (const slice of slices) {
    const monthly = await M.MonthlyTask.findAll({ where: { month_key: slice.month, target_type: 'store', target_id: { [Op.in]: storeIds }, status: 1 }, raw: true });
    await require('../sales/monthlyProfitTargets').overlayMigratedProfit(monthly, [], slice.month, storeIds);
    tasks.push(...monthly);
  }
  return new Map(storeIds.map(id => [String(id), prorate(tasks, slices, id)]));
}
module.exports = { load, monthSlices, prorate };
