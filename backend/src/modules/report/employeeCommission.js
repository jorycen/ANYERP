// Employee commission rules shared by the employee gross-profit report and
// its export. This module only calculates from backend-provided gross profit;
// it does not read or infer order data.
const money = value => Math.round(Number(value || 0) * 100) / 100;
const configured = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;

function estimateStaffCommission(grossProfit, commissionBase) {
  if (!configured(commissionBase) || grossProfit == null || !Number.isFinite(Number(grossProfit))) return null;
  const gross = Number(grossProfit || 0);
  const base = Math.max(0, Number(commissionBase || 0));
  const tier = base * 1.5;
  if (gross <= base) return 0;
  if (gross <= tier) return money((gross - base) * 0.2);
  return money((tier - base) * 0.2 + (gross - tier) * 0.3);
}

function estimateManagerCommission(grossProfit, breakEvenLine, storeGrossProfit, storeRate = 0.03, stages) {
  if (!configured(breakEvenLine) || grossProfit == null || storeGrossProfit == null || !Number.isFinite(Number(grossProfit)) || !Number.isFinite(Number(storeGrossProfit))) return null;
  const gross = Number(grossProfit || 0);
  const storeGross = Number(storeGrossProfit || 0);
  if(!stages||stages.reason||stages.lowNetGrossProfit==null||stages.highNetGrossProfit==null||
    !Number.isFinite(Number(stages.lowNetGrossProfit))||!Number.isFinite(Number(stages.highNetGrossProfit))||
    money(Number(stages.lowNetGrossProfit)+Number(stages.highNetGrossProfit))!==money(gross))return null;
  const lowCommission=money(Number(stages.lowNetGrossProfit)*0.15),highCommission=money(Number(stages.highNetGrossProfit)*0.25);
  const personal=money(lowCommission+highCommission);
  return {personal,personalRate:null,lowCommission,highCommission,store:money(storeGross*Number(storeRate||0)),total:money(personal+storeGross*Number(storeRate||0))};
}

function employeeEstimate(employee, grossProfit, storeGrossProfit, config = {}) {
  const staffRule = ['卢珏', '葛宇'].includes(employee.employeeName) || !employee.isManager;
  if (staffRule) {
    const salesCommission = estimateStaffCommission(grossProfit, config.commissionBase);
    const historicalStoreOwner=config.includeHistoricalStoreCommission&&!['卢珏','葛宇'].includes(employee.employeeName);
    const storeCommission=historicalStoreOwner?config.storeAllocation.commission:0;
    return { rule: 'staff',historicalStoreOwner, salesCommission, storeCommission, productCommission: null, operationsCommission: null,
      performanceEstimate: salesCommission===null||storeCommission===null?null:money(salesCommission+storeCommission), status: salesCommission === null ? (configured(config.commissionBase) ? 'pending' : 'unconfigured') : storeCommission===null?'pending':'estimated',
      reason: !configured(config.commissionBase) ? '个人提成基数未配置' : salesCommission === null ? '个人销售毛利待核算' : storeCommission===null?'历史门店提成依据待核实':'' };
  }
  const rate = ['石高铭', '唐陈'].includes(employee.employeeName) ? 0.05 : 0.03;
  const result = estimateManagerCommission(grossProfit, config.originalStoreBasis?0:config.breakEvenLine, config.storeAllocation?0:storeGrossProfit, rate, config.stages);
  const storeCommission=config.storeAllocation?config.storeAllocation.commission:storeGrossProfit==null||!Number.isFinite(Number(storeGrossProfit))?null:money(Number(storeGrossProfit)*rate);
  return { rule: 'manager', salesCommission: result?.personal ?? null, storeCommission,
    productCommission: null, operationsCommission: null, performanceEstimate: result&&storeCommission!==null?money(result.personal+storeCommission):null,
    storeRate: rate, personalRate: result?.personalRate ?? null,
    lowGrossProfit:config.stages?.lowGrossProfit??null,highGrossProfit:config.stages?.highGrossProfit??null,
    lowDeduction:config.stages?.lowDeduction??null,highDeduction:config.stages?.highDeduction??null,
    lowNetGrossProfit:config.stages?.lowNetGrossProfit??null,highNetGrossProfit:config.stages?.highNetGrossProfit??null,
    lowCommission:result?.lowCommission??null,highCommission:result?.highCommission??null,
    commissionDetails:config.stages?.details||[],
    status: result&&storeCommission!==null ? 'estimated' : !config.originalStoreBasis&&!configured(config.breakEvenLine) ? 'unconfigured' : 'pending',
    reason: !config.originalStoreBasis&&!configured(config.breakEvenLine) ? '门店盈亏平衡线未配置' : !config.storeAllocation&&storeGrossProfit==null?'门店销售端毛利待核算':!result ? config.stages?.reason||'个人分阶段毛利待核算' : storeCommission===null?'历史店长门店提成依据待核实':'' };
}

module.exports = { money, estimateStaffCommission, estimateManagerCommission, employeeEstimate };
