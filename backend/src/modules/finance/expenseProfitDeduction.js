const M=require('../../models');
const {Op}=require('sequelize');
const {generateUUID}=require('../../utils');
const {getUserRoles}=require('../../middleware/permission');
const {canAccessDistributor}=require('../../utils/distributorScope');
const {accountTypeWhere}=require('../../utils/staffAccount');
const {recordBusinessAction}=require('../../utils/businessActionLog');
const METHOD='PROFIT_DEDUCTION';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const currentMonth=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,7);
const parse=value=>typeof value==='string'?JSON.parse(value):value;
function cents(value){const n=Number(value);if(value===''||value==null||!Number.isFinite(n)||n<=0||n>1e9||Math.abs(n*100-Math.round(n*100))>0.000001)fail('分摊金额必须大于0且最多两位小数');return Math.round(n*100)}
async function storeContext(storeId,user,transaction){
 const store=await M.Store.findByPk(storeId,{transaction});if(!store||Number(store.is_deleted)||store.status===0)fail('门店不存在或已停用');
 const allowed=(user.accessibleStoreIds||[]).map(String);
 if(!allowed.includes('*')&&!allowed.includes(String(storeId)))fail('无权操作该门店',403);
 if(!canAccessDistributor(user,store.distributor_id))fail('无权操作该经销商',403);
 return store;
}
function staffWhere(store,user){
 const roles=getUserRoles(user),all=roles.some(r=>['admin','boss'].includes(r));
 return {...accountTypeWhere('business'),distributor_id:store.distributor_id,status:1,is_deleted:0,
 ...(!all&&!user.accessibleStoreIds?.includes('*')?{store_id:{[Op.in]:(user.accessibleStoreIds||[]).map(String)}}:{})};
}
async function assertOpen(distributorId,month,transaction){
 const {assertPeriodOpen,normalizeMonth}=require('./expenseAccountingController');
 // Month parsing is shared with existing performance allocations.
 const parsed=normalizeMonth(month,'抵扣月份');
 await assertPeriodOpen(distributorId,parsed,transaction);
 const rows=await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY=:month'+(transaction?' FOR UPDATE':''),{replacements:{month:parsed},type:M.sequelize.QueryTypes.SELECT,transaction});
 if(rows.length)fail(`抵扣月份 ${parsed} 已关账`);
 return parsed;
}
async function normalize(input,{amount,store,user,transaction,draft=false,enforceScope=true}){
 if(enforceScope&&!canAccessDistributor(user,store.distributor_id))fail('无权操作该经销商',403);
 input=input||{};const performanceMonth=String(input.performanceMonth||currentMonth());
 await assertOpen(store.distributor_id,performanceMonth,transaction);
 const method=input.method||'MANUAL';if(!['MANUAL','AVERAGE'].includes(method))fail('分摊方式无效');
 const values=Array.isArray(input.allocations)?input.allocations:[];
 if(!draft&&(!values.length||values.length>100))fail('请选择1至100名抵扣人员');
 if(values.length>100)fail('最多分摊给100名人员');
 const ids=values.map(r=>String(r.staffId||r.staff_id||''));if(new Set(ids).size!==ids.length||ids.some(id=>!id))fail('抵扣人员不能重复或为空');
 const staff=ids.length?await M.Staff.findAll({where:{...(enforceScope?staffWhere(store,user):{...accountTypeWhere('business'),distributor_id:store.distributor_id,status:1,is_deleted:0}),staff_id:{[Op.in]:ids}},attributes:['staff_id','name','store_id','distributor_id'],transaction,raw:true}):[];
 if(staff.length!==ids.length)fail('存在无权选择、跨经销商或已停用的抵扣人员');
 const otherStores=[...new Set(staff.map(s=>s.store_id).filter(id=>id&&String(id)!==String(store.store_id)))];
 if(otherStores.length){const valid=await M.Store.findAll({where:{store_id:{[Op.in]:otherStores},distributor_id:store.distributor_id,status:1,is_deleted:0},transaction,raw:true});if(valid.length!==otherStores.length)fail('抵扣人员所属门店与经销商不一致或已停用');}

 const total=cents(amount),per=values.length?Math.floor(total/values.length):0;
 const allocations=values.map((r,i)=>{const target=staff.find(s=>String(s.staff_id)===ids[i]);const value=method==='AVERAGE'?(i===values.length-1?total-per*i:per):((draft&&(r.amount===''||r.amount==null))?0:cents(r.amount));if(!draft&&value<=0)fail('每人的抵扣金额必须大于0');return {staffId:String(target.staff_id),staffName:target.name,storeId:target.store_id||store.store_id,amount:value/100}});
 const sum=allocations.reduce((s,r)=>s+Math.round(r.amount*100),0);
 if(!draft&&sum!==total)fail('人员分摊金额合计必须等于费用金额');
 return {version:1,mode:METHOD,performanceMonth,method,allocations,totalAmount:sum/100,expenseAmount:total/100,remainingAmount:(total-sum)/100};
}
async function options(ctx){const store=await storeContext(ctx.query.storeId,ctx.state.user);const rows=await M.Staff.findAll({where:staffWhere(store,ctx.state.user),attributes:['staff_id','name','store_id'],order:[['name','ASC'],['staff_id','ASC']],raw:true});ctx.body={code:0,data:{currentMonth:currentMonth(),employees:rows.map(s=>({staffId:String(s.staff_id),name:s.name,storeId:s.store_id}))}}}
async function preview(ctx){const body=ctx.request.body;const store=await storeContext(body.storeId,ctx.state.user);ctx.body={code:0,data:await normalize(body.profitDeduction,{amount:body.amount,store,user:ctx.state.user})}}
function read(expense){if(expense.payment_method!==METHOD)return null;const snapshot=parse(expense.recipient_snapshot_json||'{}');if(snapshot.mode!==METHOD)fail('抵扣毛利资料缺失，请重新提交');return snapshot}
function display(expense){const data=read(expense);return data?{...data,label:'抵扣毛利',allocationText:data.allocations.map(r=>`${r.staffName} ¥${r.amount.toFixed(2)}`).join('；')}:null}
async function apply(expense,actor,transaction){
 const snapshot=read(expense);if(!snapshot)return;
 const store=await M.Store.findByPk(expense.store_id,{transaction});if(!store||store.status===0||Number(store.is_deleted)||String(store.distributor_id)!==String(expense.distributor_id))fail('费用门店经销商已变化，请重新核对');
 await assertOpen(expense.distributor_id,expense.accounting_month,transaction);
 const normalized=await normalize(snapshot,{amount:expense.amount,store,transaction,enforceScope:false});
 const existing=await M.ExpensePerformanceAllocation.findAll({where:{expense_id:expense.expense_id},transaction,lock:transaction.LOCK.UPDATE});
 const expected=new Set(normalized.allocations.map(r=>`EPD-${expense.expense_id}-${r.staffId}`));
 if(existing.some(r=>r.status!=='cancelled'&&!expected.has(r.allocation_no)))fail('该费用已有其他绩效分摊，不能重复扣减');
 for(const row of normalized.allocations){
  const no=`EPD-${expense.expense_id}-${row.staffId}`,old=existing.find(r=>r.allocation_no===no);
  const values={expense_id:expense.expense_id,expense_no:expense.expense_no,distributor_id:expense.distributor_id,region_id:expense.region_id,store_id:row.storeId,performance_month:normalized.performanceMonth,staff_id:row.staffId,staff_name:row.staffName,amount:row.amount,reason:`费用抵扣毛利：${expense.expense_no}；${expense.remark||expense.expense_party}`.slice(0,1000),status:'approved',applicant_staff_id:expense.applicant_staff_id,applicant_name:expense.applicant_name,admin_reviewer_id:actor.staffId,admin_reviewer_name:actor.name||'',admin_review_comment:'费用原审批流程全部通过，自动生效',admin_review_time:new Date(),update_time:new Date()};
  if(old&&old.status==='approved'){if(Number(old.amount)!==row.amount||old.performance_month!==normalized.performanceMonth)fail('已入账抵扣记录与审批资料不一致');continue;}
  if(old)await old.update(values,{transaction});else await M.ExpensePerformanceAllocation.create({allocation_id:generateUUID(),allocation_no:no,...values},{transaction});
 }
 await recordBusinessAction({businessType:'expense_profit_deduction',businessId:expense.expense_id,businessNo:expense.expense_no,action:'approved_deduction',user:actor,detail:normalized,transaction});
}
async function reverse(expense,actor,transaction,reason){
 const snapshot=read(expense);if(!snapshot)return;
 const rows=await M.ExpensePerformanceAllocation.findAll({where:{expense_id:expense.expense_id,status:'approved'},transaction,lock:transaction.LOCK.UPDATE});
 if(!rows.length)return;
 await assertOpen(expense.distributor_id,snapshot.performanceMonth,transaction);await assertOpen(expense.distributor_id,expense.accounting_month,transaction);
 for(const row of rows)await row.update({status:'cancelled',update_time:new Date(),admin_review_comment:`已撤销抵扣：${reason}`.slice(0,512)},{transaction});
 await recordBusinessAction({businessType:'expense_profit_deduction',businessId:expense.expense_id,businessNo:expense.expense_no,action:'reversed_deduction',user:actor,comment:reason,detail:{performanceMonth:snapshot.performanceMonth,allocations:rows.map(r=>({staffId:r.staff_id,amount:r.amount}))},transaction});
}
// Shared monthly reporting source. Do not allocate these expenses into order sales profit.
async function loadMonthly({storeIds,user,startDate,endDate,staffName,staffId,orderNo}) {
 if(!storeIds?.length || orderNo)return [];
 const where={store_id:{[Op.in]:storeIds},status:'approved'};
 if(startDate||endDate)where.performance_month={...(startDate?{[Op.gte]:String(startDate).slice(0,7)}:{}),...(endDate?{[Op.lte]:String(endDate).slice(0,7)}:{})};
 if(staffName)where.staff_name=staffName;
 if(staffId)where.staff_id=staffId;
 if(require('../../utils/storePermissions').isSelfOnlyReportUser(user))where.staff_id=user.staffId;
 const scope=require('../../utils/distributorScope').accessibleDistributorIds(user);
 if(!scope.includes('*'))where.distributor_id={[Op.in]:scope};
 const rows=await M.ExpensePerformanceAllocation.findAll({where,attributes:['staff_id','staff_name',[M.sequelize.fn('SUM',M.sequelize.col('amount')),'amount']],group:['staff_id','staff_name'],order:[[M.sequelize.literal('amount'),'DESC']],raw:true});
 return rows.map(r=>({staffId:String(r.staff_id),staffName:r.staff_name,amount:Number(r.amount)}));
}
const netProfit=(gross,deduction)=>Number((Number(gross)-Number(deduction)).toFixed(2));
function attachMonthly(ranking,rows,canCalculate=true){
 if(rows===null)return ranking.map(row=>({...row,expensePerformanceDeduction:null,netGrossProfit:null}));
 const output=ranking.map(row=>({...row}));
 for(const item of rows){let target=output.find(r=>String(r.staffId)===item.staffId);if(!target){target={staffId:item.staffId,employeeName:item.staffName,salesAmount:0,grossProfit:0,participatedOrderCount:0};output.push(target)}target.expensePerformanceDeduction=Number(((target.expensePerformanceDeduction||0)+item.amount).toFixed(2));}
 return output.map(row=>({...row,expensePerformanceDeduction:row.expensePerformanceDeduction||0,netGrossProfit:canCalculate&&row.grossProfit!==null?netProfit(row.grossProfit,row.expensePerformanceDeduction||0):null}));
}
// Same approved allocation facts used by employee deductions. Grouping by expense
// and store counts a split expense once, without charging its full amount per staff.
async function storeCommissionEvents({storeIds,month}){
 if(!storeIds?.length)return [];
 const rows=await M.sequelize.query(`SELECT a.EXPENSE_ID expenseId,a.EXPENSE_NO expenseNo,a.STORE_ID storeId,
 SUM(a.AMOUNT) amount,e.EXPENSE_DATE expenseDate
 FROM T_EXPENSE_PERFORMANCE_ALLOCATION a JOIN T_EXPENSE e ON e.EXPENSE_ID=a.EXPENSE_ID
 WHERE a.STATUS='approved' AND e.STATUS='approved' AND e.IS_DELETED=0 AND e.AFFECTS_STORE_PROFIT=1
 AND a.PERFORMANCE_MONTH=:month AND a.STORE_ID IN (:storeIds)
 GROUP BY a.EXPENSE_ID,a.EXPENSE_NO,a.STORE_ID,e.EXPENSE_DATE`,{replacements:{storeIds,month},type:M.sequelize.QueryTypes.SELECT});
 return rows.map(r=>({eventKey:`expense-deduction:${r.expenseId}:${r.storeId}`,entryType:'expense_deduction',entryNo:r.expenseNo,storeId:r.storeId,ownershipStoreId:r.storeId,
 ownershipTime:r.expenseDate?`${String(r.expenseDate).slice(0,10)}T00:00:00+08:00`:null,amount:-Number(r.amount),businessDate:month+'-01'}));
}
module.exports={METHOD,currentMonth,storeContext,staffWhere,assertOpen,normalize,options,preview,read,display,apply,reverse,loadMonthly,netProfit,attachMonthly,storeCommissionEvents};
