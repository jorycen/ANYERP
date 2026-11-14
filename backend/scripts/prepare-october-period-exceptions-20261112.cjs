// Read-only capture of the exact 65 records approved by the user.
const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const M=require('../src/models'),dates=require('../src/modules/report/commissionDates');
const dir=path.resolve(__dirname,'../backup/commission-period-exceptions-20261112');
const original=require('../../outputs/commission-difference-20261111/difference-data.json');
(async()=>{
 const historical=original.records.filter(r=>['优惠券历史校正移月','教育套件历史校正移月'].includes(r.type)),sales=original.records.filter(r=>r.type==='归档月份变化');a.equal(historical.length,62);a.equal(sales.length,3);
 const orders=await M.Order.findAll({where:{order_id:[...new Set([...historical,...sales].map(r=>r.sourceId))]},raw:true}),byOrder=new Map(orders.map(o=>[o.order_id,o]));
 const corrections=await M.PerformanceProfitAdjustment.findAll({where:{adjustment_no:historical.map(r=>r.businessNo)},raw:true});a.equal(corrections.length,62);
 const data={batch:'OCTOBER-PERIOD-EXCEPTIONS-20261112',reason:'用户确认一次性将清单50笔优惠券、12笔教育套件历史校正及3张跨月销售归10月，真实日期和金额保留。',sales:[],adjustments:[]};
 for(const r of sales){const o=byOrder.get(r.sourceId);a(o);a(new Date(o.create_time).toISOString().startsWith('2026-10'));a(new Date(o.archive_time).toISOString().startsWith('2026-11'));data.sales.push({orderId:o.order_id,orderNo:o.order_no,postingTime:o.create_time,originalArchiveTime:o.archive_time});}
 for(const r of historical){const c=corrections.find(c=>c.adjustment_no===r.businessNo),o=byOrder.get(r.sourceId);a(c&&o);a.equal(c.status,'approved');a.equal(Number(c.signed_amount),r.before);a.equal(c.order_id,r.sourceId);
  const postingTime=data.sales.find(s=>s.orderId===o.order_id)?.postingTime||dates.saleTime(o);a(postingTime,'原销售计提时间缺失');a.equal(new Date(new Date(postingTime).getTime()+28800000).toISOString().slice(0,7),'2026-10');
  data.adjustments.push({adjustmentId:c.adjustment_id,adjustmentNo:c.adjustment_no,orderId:c.order_id,orderNo:c.order_no,postingTime,originalApprovalTime:c.admin_review_time,amount:Number(c.signed_amount),category:r.type});
 }
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'source-records.json'),JSON.stringify({orders,corrections},null,2));
 const target=path.resolve(__dirname,'../src/modules/report/commissionPeriodExceptions.json');a(!fs.existsSync(target),'清单已存在，请核实后处理');fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');
 console.log(JSON.stringify({sales:data.sales.length,adjustments:data.adjustments.length,adjustmentAmount:data.adjustments.reduce((s,r)=>s+r.amount,0),output:target}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
