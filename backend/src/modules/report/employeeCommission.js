// Employee commission rules shared by the employee gross-profit report and
// its export. This module only calculates from backend-provided gross profit;
// it does not read or infer order data.
const money = value => Math.round(Number(value || 0) * 100) / 100;
const configured = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

function estimateStaffCommission(grossProfit, commissionBase) {
  if (!configured(commissionBase) || !Number.isFinite(Number(grossProfit))) return null;
  const gross = Number(grossProfit || 0);
  const base = Math.max(0, Number(commissionBase || 0));
  const tier = base * 1.5;
  if (gross <= base) return 0;
  if (gross <= tier) return money((tier - gross) * 0.2);
  return money((tier - base) * 0.2 + (gross - tier) * 0.3);
}

function estimateManagerCommission(grossProfit, breakEvenLine, storeGrossProfit, storeRate = 0.03) {
  if (!configured(breakEvenLine) || !Number.isFinite(Number(grossProfit)) || !Number.isFinite(Number(storeGrossProfit))) return null;
  const gross = Number(grossProfit || 0);
  const line = Math.max(0, Number(breakEvenLine || 0));
  const storeGross = Number(storeGrossProfit || 0);
  const personal = money(Math.min(gross, line) * 0.15 + Math.max(0, gross - line) * 0.25);
  return { personal, store: money(storeGross * Number(storeRate || 0)), total: money(personal + storeGross * Number(storeRate || 0)) };
}

function employeeEstimate(employee, grossProfit, storeGrossProfit, config = {}) {
  const staffRule = ['卢珏', '葛宇'].includes(employee.employeeName) || !employee.isManager;
  if (staffRule) {
    const salesCommission = estimateStaffCommission(grossProfit, config.commissionBase);
    return { rule: 'staff', salesCommission, storeCommission: 0, productCommission: null, operationsCommission: null,
      performanceEstimate: salesCommission, status: salesCommission === null ? 'unconfigured' : 'estimated' };
  }
  const rate = ['石高铭', '唐陈'].includes(employee.employeeName) ? 0.05 : 0.03;
  const result = estimateManagerCommission(grossProfit, config.breakEvenLine, storeGrossProfit, rate);
  return { rule: 'manager', salesCommission: result?.personal ?? null, storeCommission: result?.store ?? null,
    productCommission: null, operationsCommission: null, performanceEstimate: result?.total ?? null,
    storeRate: rate, status: result ? 'estimated' : 'unconfigured' };
}

module.exports = { money, estimateStaffCommission, estimateManagerCommission, employeeEstimate };
