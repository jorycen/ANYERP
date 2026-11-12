const { Op } = require('sequelize');
const M = require('../../models');
const { buildRanges, buildEmployeePerformance, canViewProfit } = require('./dashboardService');
const { RealtimeSqlDashboardDataSource } = require('./dashboardDataSource');
const deduction = require('../finance/expenseProfitDeduction');
const { employeeEstimate, money } = require('./employeeCommission');
const C = require('./commissionConfig');
const { sendExcel } = require('../../utils/excelExport');
const { isSelfOnlyReportUser } = require('../../utils/storePermissions');
const presentation = require('./employeeProfitColumns');
const timeline = require('./managerCommissionTimeline');
const storeAllocationService=require('./storeCommissionAllocation');
const {isProductWarehouse}=require('./profitAttribution');
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
  const reportRole = query.reportRole || 'all';
  if (!['all','staff','manager','product','operations'].includes(reportRole)) throw Object.assign(new Error('报表分类无效'), {status:400});
  if (!canViewProfit(user)) throw Object.assign(new Error('无权查看员工毛利汇总'), { status: 403 });
  const chunks = periods(query), stores = await C.scope(user, query.storeId), storeIds = stores.map(s => String(s.store_id));
  const salesStoreIds=storeIds.filter(id=>!isProductWarehouse(id));
  const selected = isSelfOnlyReportUser(user) ? String(user.staffId) : String(query.employeeId || '');
  const managerTimeline=timeline.createLoader({user,stores});
  const source = new RealtimeSqlDashboardDataSource(), combined = new Map(), sideRows = new Map();
  const panels = { sales: { grossProfit: 0, commission: 0 }, product: { grossProfit: 0, commission: null }, operations: { grossProfit: 0, commission: null } };
  for (const period of chunks) {
    const range = buildRanges(period).current, filters = { storeIds:salesStoreIds, storeId: query.storeId || '', archiveScope: 'archived' };
    const [orders, adjustments, configs, expenses] = await Promise.all([
      salesStoreIds.length ? source.getEmployeeOrderRows(filters, range) : [],
      salesStoreIds.length ? source.getApprovedAdjustments(filters, range) : [], C.options(user, period.month, query.storeId),
      salesStoreIds.length ? deduction.loadMonthly({ storeIds:salesStoreIds, user, startDate: period.startDate, endDate: period.endDate }) : []
    ]);
    const performance=buildEmployeePerformance(orders,adjustments,'',true,{allDetails:true});
    const ranks = deduction.attachMonthly(performance.ranking, expenses);
    for (const staff of configs.employees) if (!isProductWarehouse(staff.storeId)&&!ranks.some(r => String(r.staffId) === staff.staffId)) ranks.push({ staffId: staff.staffId, employeeName: staff.employeeName, grossProfit: 0, netGrossProfit: 0, expensePerformanceDeduction: 0 });
    const people = ranks.length ? await M.Staff.findAll({ where: { staff_id: { [Op.in]: ranks.map(x => x.staffId).filter(Boolean) } }, raw: true }) : [];
    const financial = storeIds.length ? await require('./financialProfitController').queryFinancialProfit({ storeIds, ...period, includeStores: true }) : { summary: {}, storeSummaries: [] };
    const allocations=storeIds.length?await storeAllocationService.load(financial,stores,period,configs):{owners:new Map(),missing:[],people:[]};
    for(const person of allocations.people){if(!people.some(p=>String(p.staff_id)===String(person.staff_id)))people.push(person);if(!ranks.some(r=>String(r.staffId)===String(person.staff_id)))ranks.push({staffId:String(person.staff_id),employeeName:person.name,grossProfit:0,netGrossProfit:0,expensePerformanceDeduction:0});}
    for(const [staffId]of allocations.owners)if(!ranks.some(r=>String(r.staffId)===staffId))ranks.push({staffId,employeeName:`历史店长#${staffId}`,grossProfit:0,netGrossProfit:0,expensePerformanceDeduction:0});
    const personalConfigs=await C.staffConfigs(period.month,ranks.map(r=>r.staffId));
    const monthEnd=new Date(Date.UTC(Number(period.month.slice(0,4)),Number(period.month.slice(5)),0)).toISOString().slice(0,10);
    if(period.startDate===`${period.month}-01`&&period.endDate===monthEnd)managerTimeline.seed?.(period.month,financial);
    for (const key of ['product', 'operations']) {
      const value = financial.summary[key === 'product' ? 'productGrossProfit' : 'operationsGrossProfit'];
      panels[key].grossProfit = selected || value == null || panels[key].grossProfit === null ? null : money(panels[key].grossProfit + value);
      if (!selected) for (const store of stores) {
        const summary=financial.storeSummaries?.find(s=>String(s.storeId)===String(store.store_id))?.summary;
        const gross=summary?.[key==='product'?'productGrossProfit':'operationsGrossProfit'];
        const id=`${key}:${store.store_id}`,previous=sideRows.get(id);
        sideRows.set(id,{employeeName:'',storeId:store.store_id,storeName:store.name,role:key==='product'?'产品':'运营',sideName:key==='product'?'产品端':'运营端',grossProfit:previous ? previous.grossProfit==null||gross==null?null:money(previous.grossProfit+Number(gross)) : gross??null,commission:null,performanceEstimate:null,status:'pending',remark:'暂不归属具体负责人；提成待定'});
        const side=sideRows.get(id),field=key==='product'?'productGrossProfit':'operationsGrossProfit';
        side.issues=[...(previous?.issues||[]),...(financial.profitDetails||[]).filter(e=>String(e.storeId)===String(store.store_id)&&e[field]===null).map(e=>({month:period.month,reason:e.profitPendingReason||`${side.sideName}依据待核实`,orderId:e.orderId,orderNo:e.entryNo,sourceOrderId:e.orderId,sourceOrderNo:e.orderNo}))];
        if(gross==null&&!side.issues.length)side.issues.push({month:period.month,reason:`${side.sideName}依据待核实`});
      }
    }
    for (const row of ranks) {
      if (selected && String(row.staffId) !== selected) continue;
      const person = people.find(p => String(p.staff_id) === String(row.staffId));
      const allocation=allocations.owners.get(String(row.staffId))||{commission:0,grossProfit:0,storeIds:[],issues:[]};
      const origin=performance.details.find(d=>String(d.staffId)===String(row.staffId));
      const store = stores.find(s => String(s.store_id) === String(person?.store_id))||stores.find(s=>String(s.store_id)===String(allocation.storeIds[0]||origin?.storeId));
      const option = configs.employees.find(s => s.staffId === String(row.staffId));
      const personalBase=personalConfigs.find(c=>String(c.entity_id)===String(row.staffId))?.amount??option?.commissionBase;
      const sc = configs.stores.find(s => s.storeId === store?.store_id);
      const roles = String(option?.roles || person?.role_code || '').split(',');
      const isManager = roles.some(r => ['manager','store_manager','store_admin'].includes(r)) || String(store?.manager_staff_id) === String(row.staffId);
      const reportManager=isManager||allocations.owners.has(String(row.staffId));
      const storeSummary = financial.storeSummaries?.find(s => String(s.storeId) === String(store?.store_id))?.summary;
      const storeGross = storeSummary?.salesGrossProfit;
      let stages;
      if(isManager&&!['卢珏','葛宇'].includes(row.employeeName)&&store){
        const grossStages=await managerTimeline.forStaff({period,storeId:store.store_id,staffId:row.staffId,configs,performanceDetails:performance.details});
        stages=timeline.netStages(grossStages,row.grossProfit,row.expensePerformanceDeduction??0,'proportional');
      }
      const estimate = employeeEstimate({ ...row, isManager }, row.netGrossProfit, storeGross, { commissionBase: personalBase, breakEvenLine: sc?.breakEvenLine,stages,originalStoreBasis:true,storeAllocation:allocation,includeHistoricalStoreCommission:allocations.owners.has(String(row.staffId)) });
      if(!person&&allocations.owners.has(String(row.staffId)))Object.assign(estimate,{salesCommission:null,performanceEstimate:null,status:'pending',reason:'历史店长员工档案未能定位'});
      const ownershipPending=estimate.rule==='manager'||estimate.historicalStoreOwner?allocations.missing.filter(m=>m.storeId===String(store?.store_id)||allocation.storeIds.includes(m.storeId)):[];
      if(ownershipPending.length)Object.assign(estimate,{storeCommission:null,performanceEstimate:null,status:'pending',reason:estimate.reason||'业务发生时的店长任职依据未确认'});
      const issues=[...(stages?.issues||[]),...allocation.issues,...ownershipPending.map(m=>({...m,originalStoreId:m.storeId}))];
      const addReason=reason=>{if(reason&&!issues.some(i=>i.reason===reason))issues.push({reason,month:period.month});};
      if(estimate.status!=='estimated')addReason(estimate.reason);
      if(estimate.rule==='manager'&&storeGross==null){
        for(const event of financial.profitDetails||[])if(String(event.storeId)===String(store?.store_id)&&event.salesGrossProfit===null)issues.push({month:period.month,reason:'门店销售端毛利待核算，影响门店提成及跨线判断',orderId:event.orderId,orderNo:event.entryNo,sourceOrderId:event.orderId,sourceOrderNo:event.orderNo});
        addReason('门店销售端毛利待核算');
      }
      if(!store)addReason('员工当前门店未匹配');
      if (!store) Object.assign(estimate, { salesCommission: null, storeCommission: null, performanceEstimate: null, status: 'unconfigured', reason: '员工当前门店未匹配' });
      const key = String(row.staffId || row.employeeName), previous = combined.get(key);
      const current = { ...row, reportRole:reportManager?'manager':roles.some(r=>['clerk','staff','salesperson'].includes(r))?'staff':'other',sideName:'销售端',storeId: store?.store_id || '', storeName: store?.name || '未匹配当前门店', role: (option?.roleNames || roles.join(' / '))+(estimate.historicalStoreOwner?'（含历史门店提成）':''),
        commissionBase: estimate.rule === 'staff' ? personalBase ?? null : null,
        breakEvenLine: estimate.rule === 'manager' ? sc?.breakEvenLine ?? null : null,
        storeGrossProfit: (estimate.rule === 'manager'||estimate.historicalStoreOwner)&&!ownershipPending.length ? allocation.grossProfit : null,commissionStoreNames:allocation.storeIds.map(id=>stores.find(s=>String(s.store_id)===String(id))?.name||id).join('、'), ...estimate,issues,
        remark: `${period.month}：${estimate.reason || '已计算'}；销售按归档期、调整按审批期计提；首次测算固定清单归9月；退货当月15%/25%分段；门店整月销售端毛利严格超过盈亏线才按全额计提门店提成，按原业务店长归属；产品/运营提成待定；按月计算，区间内不折算基数` };
      if (previous) {
        for (const field of ['grossProfit','expensePerformanceDeduction','netGrossProfit','salesCommission','storeCommission','performanceEstimate','storeGrossProfit','lowGrossProfit','highGrossProfit','lowDeduction','highDeduction','lowNetGrossProfit','highNetGrossProfit','lowCommission','highCommission']) current[field] = previous[field] == null || current[field] == null ? null : money(previous[field] + Number(current[field]));
        current.commissionDetails=[...(previous.commissionDetails||[]),...(current.commissionDetails||[])];
        current.issues=[...(previous.issues||[]),...current.issues];
        current.commissionStoreNames=[...new Set([previous.commissionStoreNames,current.commissionStoreNames].filter(Boolean))].join('、');
        current.status = [previous.status, current.status].includes('unconfigured') ? 'unconfigured' : current.performanceEstimate == null ? 'pending' : 'estimated';
        current.personalRate = null;
        current.remark = previous.remark + '；' + current.remark;
        current.commissionBase = null; current.breakEvenLine = null; current.remark += '；跨月参数按各月配置';
      }
      combined.set(key, current);
    }
    if(!selected)for(const missing of allocations.missing){
      const store=stores.find(s=>String(s.store_id)===missing.storeId),key=`history:${missing.storeId}:${missing.originalMonth}`;
      const issue={...missing,originalStoreId:missing.storeId,reason:missing.reason};
      const previous=combined.get(key);
      combined.set(key,{employeeName:'店长归属待确认',storeId:missing.storeId,storeName:store?.name||missing.storeId,role:'历史店长待确认',reportRole:'manager',rule:'manager',sideName:'销售端',grossProfit:0,expensePerformanceDeduction:0,netGrossProfit:0,storeCommission:null,salesCommission:0,performanceEstimate:null,status:'pending',reason:missing.reason,issues:[...(previous?.issues||[]),issue],remark:'请填写原业务月份的店长及任职有效期；不使用当前店长代替',reviewIdentity:key});
    }
  }
  let rows = [...combined.values()].filter(r=>!['staff','manager'].includes(reportRole)||r.reportRole===reportRole).sort((a,b) => Number(b.netGrossProfit) - Number(a.netGrossProfit));
  panels.sales.grossProfit = rows.some(r => r.netGrossProfit == null) ? null : money(rows.reduce((s,r) => s + Number(r.netGrossProfit),0));
  panels.sales.commission = rows.some(r => r.performanceEstimate == null) ? null : money(rows.reduce((s,r) => s + Number(r.performanceEstimate),0));
  panels.sales.status = rows.some(r => r.status === 'unconfigured') ? 'unconfigured' : panels.sales.commission == null ? 'pending' : 'estimated';
  if (reportRole==='all' && query.reportRole) rows.push(...sideRows.values());
  if (['product','operations'].includes(reportRole)) rows=[...sideRows.entries()].filter(([id])=>id.startsWith(reportRole+':')).map(([,row])=>row);
  const fields=presentation.columns(reportRole).filter(c=>reportRole!=='manager'||c.key!=='commissionBase');
  for(const row of rows){row.cells=Object.fromEntries(fields.map(c=>[c.key,presentation.display(row,c)]));row.reviewKey=row.reviewIdentity||(row.staffId?`staff:${row.staffId}`:`${row.sideName}:${row.storeId}`);}
  return { rows, panels, columns:fields,reportRole,canConfigure: C.canConfigure(user), note: '销售按归档时间、调整差额按审批通过时间计提，原归档毛利不回写。首次测算固定28单归9月；另有62笔历史校正及3张跨月销售一次性归10月，真实日期保留。店长个人按当月全店销售端毛利15%/25%分段，历史校正跟随原销售计提日期参与跨线。费用按两阶段个人毛利占比分摊。门店整月销售端毛利严格超过盈亏线后按全额计提门店提成，石高铭、唐陈、蒋君杰5%，其他店长3%，按原业务店长归属。产品、运营暂按门店汇总，负责人留空。' };
}
async function report(ctx) { ctx.body = { code: 0, data: await load(ctx.state.user, ctx.query) }; }
async function config(ctx) { if (!C.canConfigure(ctx.state.user)) ctx.throw(403, '无权配置提成参数'); ctx.body = { code: 0, data: await C.options(ctx.state.user, ctx.query.month, ctx.query.storeId) }; }
function exportRows(rows) { return rows.map(r => { const missing = r.status === 'pending' ? '待核算' : '待配置'; return ({ 员工: r.employeeName, 门店: r.storeName, 角色: r.role, 毛利: r.grossProfit,
  费用扣减: r.expensePerformanceDeduction, 扣减后毛利: r.netGrossProfit, 提成基数: r.commissionBase ?? '未配置/跨月', 盈亏平衡线: r.breakEvenLine ?? '未配置/跨月',
  门店销售端毛利: r.rule === 'staff' ? '' : r.storeGrossProfit ?? '待核算', 店长个人提成比例: r.rule==='staff'?'':'分阶段15% / 25%',
  '15%阶段个人毛利':r.rule==='staff'?'':r.lowGrossProfit??missing,'15%阶段费用扣减':r.rule==='staff'?'':r.lowDeduction??missing,'15%阶段扣减后毛利':r.rule==='staff'?'':r.lowNetGrossProfit??missing,'15%阶段提成':r.rule==='staff'?'':r.lowCommission??missing,
  '25%阶段个人毛利':r.rule==='staff'?'':r.highGrossProfit??missing,'25%阶段费用扣减':r.rule==='staff'?'':r.highDeduction??missing,'25%阶段扣减后毛利':r.rule==='staff'?'':r.highNetGrossProfit??missing,'25%阶段提成':r.rule==='staff'?'':r.highCommission??missing,
  销售端提成: r.salesCommission ?? missing, 店长门店提成: r.storeCommission ?? missing, 产品端提成: '待定', 运营端提成: '待定', 绩效预估: r.performanceEstimate ?? missing, 备注: r.remark }); }); }
async function exportReport(ctx) {
  const data = await load(ctx.state.user, ctx.query);
  if(String(ctx.query.review)==='1'){return require('./employeeProfitReview').exportReview(ctx,data);}
  if(!ctx.query.reportRole){const legacy=exportRows(data.rows);sendExcel(ctx,legacy,legacy.length?Object.keys(legacy[0]):['员工','门店','角色','毛利','绩效预估'],'员工毛利汇总.xlsx');return;}
  const rows=data.rows.map(row=>Object.fromEntries(data.columns.map(c=>[c.label,presentation.display(row,c)])));
  sendExcel(ctx, rows, data.columns.map(c=>c.label), '员工毛利汇总.xlsx');
}
module.exports = { periods, load, report, config, exportReport, exportRows };
