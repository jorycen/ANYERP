const test=require('node:test'),a=require('node:assert/strict');
const M=require('../src/models'),S=require('../src/modules/report/employeeProfitSections'),C=require('../src/modules/report/commissionConfig');
test('分页保留全量汇总且空页边界有效',()=>{
 const rows=Array.from({length:45},(_,i)=>({grossProfit:i}));
 const page=S.section(rows,2,20);a.equal(page.rows.length,20);a.equal(page.total,45);a.equal(page.grossProfit,990);
 a.equal(S.section(rows,100,20).page,3);a.equal(S.section([],10,20).page,1);
 a.equal(S.section([{grossProfit:null}],1,20).grossProfit,null);
});
test('返利受角色范围控制，分类过滤及导出集合不受分页影响',async t=>{
 t.mock.method(C,'scope',async()=>[{store_id:'S',name:'店'}]);
 let calls=0;
 t.mock.method(M.ResourceSettlement,'findAll',async opts=>{calls++;a.equal(opts.include[0].required,true);return [{settlement_no:'R',resource_type:'EDU_SUBSIDY',status:'PARTIALLY_SETTLED',amount:'200',matched_amount:'80',create_time:'2026-11-13',ProductSn:{store_id:'S'},ResourceCategory:{name:'教育补贴'}}];});
 const data={reportRole:'product',rows:[{sourceLabel:'人员业绩',grossProfit:50},{sourceLabel:'订单产品端毛利',grossProfit:100}]};
 const q={startDate:'2026-11-01',endDate:'2026-11-30',systemPageSize:1};
 const x=await S.prepare({roles:['boss']},q,data);
 a.equal(x.sections.people.total,1);a.equal(x.sections.system.total,2);a.equal(x.sections.system.rows.length,1);
 a.equal(x.pendingAmount,120);a.equal(x.confirmedAmount,80);a.equal(x.sections.system.grossProfit,100);a.equal(x.exportSections.system.length,2);
 const y=await S.prepare({roles:['boss']},{...q,category:'EDU_SUBSIDY'},data);a.equal(y.sections.system.total,1);a.equal(y.sections.system.grossProfit,0);
 await S.prepare({roles:['manager']},q,data);await S.prepare({roles:['boss']},{...q,employeeId:'1'},data);a.equal(calls,2);
});
