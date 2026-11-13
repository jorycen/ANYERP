const M = require('../../models');
const { Op } = require('sequelize');
const { distributorWhere } = require('../../utils/distributorScope');
const { getUserRoles } = require('../../middleware/permission');
const money = x => Math.round(Number(x) * 100) / 100;
function section(rows, page, size) {
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(size) || 20)));
  const total = rows.length, current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), Math.max(1, Math.ceil(total / pageSize)));
  return { rows: rows.slice((current-1)*pageSize,current*pageSize), total, page: current, pageSize,
    grossProfit: rows.some(r=>r.grossProfit==null)?null:money(rows.reduce((s,r)=>s+Number(r.grossProfit),0)) };
}
async function prepare(user, query, data) {
  if (!['product','operations'].includes(data.reportRole)) return data;
  const people = data.rows.filter(r=>r.sourceLabel==='人员业绩');
  let system = data.rows.filter(r=>r.sourceLabel!=='人员业绩').map(r=>({...r, category:'operating', state:'operating'}));
  let rebateAccess = false;
  if (data.reportRole==='product' && !query.employeeId && getUserRoles(user).some(r=>['boss','admin','finance'].includes(r))) {
    rebateAccess = true;
    const stores=await require('./commissionConfig').scope(user,query.storeId);
    const where={...distributorWhere(user), status:{[Op.in]:['PENDING','PARTIALLY_SETTLED','SETTLED']},
      create_time:{[Op.gte]:new Date(query.startDate+'T00:00:00+08:00'),[Op.lt]:new Date(new Date(query.endDate+'T00:00:00+08:00').getTime()+86400000)}};
    const records=stores.length?await M.ResourceSettlement.findAll({where,include:[{model:M.ProductSn,required:true,where:{store_id:stores.map(s=>s.store_id)},attributes:['store_id','pn_code']},{model:M.ResourceCategory,as:'ResourceCategory',attributes:['name'],required:false}],order:[['create_time','DESC'],['settlement_id','DESC']]}):[];
    system.push(...records.map(r=>({sourceLabel:'返利池',category:r.resource_type,state:r.status,orderNo:r.settlement_no,businessDate:r.create_time,storeName:stores.find(s=>s.store_id===r.ProductSn?.store_id)?.name||'',resourceName:r.ResourceCategory?.name||r.resource_type,snCode:r.sn_code,pnCode:r.ProductSn?.pn_code||'',grossProfit:null,pendingAmount:money(Number(r.amount)-Number(r.matched_amount)),confirmedAmount:money(r.matched_amount),remark:'返利独立列示，不加入经营毛利'})));
  }
  const categories=[...new Map(system.map(r=>[r.category,{value:r.category,label:r.category==='operating'?'经营分配':r.resourceName||r.category}])).values()];
  if(query.category)system=system.filter(r=>r.category===query.category);
  if(query.state)system=system.filter(r=>r.state===query.state);
  const pendingAmount=money(system.reduce((s,r)=>s+Number(r.pendingAmount||0),0));
  const confirmedAmount=money(system.reduce((s,r)=>s+Number(r.confirmedAmount||0),0));
  const sections={people:section(people,query.peoplePage,query.peoplePageSize),system:section(system,query.systemPage,query.systemPageSize)};
  sections.system.grossProfit=section(system.filter(r=>r.category==='operating'),1,20).grossProfit;
  return {...data,sections,categoryOptions:categories,rebateAccess,pendingAmount,confirmedAmount,exportSections:{people,system}};
}
module.exports={section,prepare};
