const {test}=require('node:test'),a=require('node:assert/strict');
const M=require('../src/models'),C=require('../src/modules/report/commissionConfig'),Review=require('../src/modules/report/employeeProfitReview');
function fixture(t){
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'O',order_no:'ORD1',store_id:'S',create_time:'2026-09-01',archive_time:'2026-09-01',update_time:'2026-09-01'}]);
 t.mock.method(M.OrderItem,'findAll',async()=>[{order_id:'O',item_id:7,product_name:'电脑',pn_code:'PN1',sn_code:'00123456789012345678'}]);
 t.mock.method(C,'scope',async()=>[{store_id:'S',name:'原门店'}]);
 return {reportRole:'manager',rows:[{reviewKey:'staff:1',staffId:'1',employeeName:'甲',storeId:'N',storeName:'现门店',role:'店长',grossProfit:100,issues:[
  {month:'2026-10',reason:'原销售门店与员工当前门店不一致',sourceOrderId:'O',orderNo:'RET1',returnId:'R'},
  {month:'2026-10',reason:'原月份盈亏平衡线未配置',sourceOrderId:'O',orderNo:'RET1',returnId:'R'},
  {month:'2026-10',reason:'产品端采购成本待核实',sourceOrderId:'O',orderNo:'RET1',returnId:'R'}]},
  {reviewKey:'staff:2',staffId:'2',employeeName:'乙',issues:[{month:'2026-10',reason:'个人提成基数未配置'}]},
  {reviewKey:'产品端:S',sideName:'产品端',commission:null,issues:[]}]};
}
test('review exports every issue with recommendations, exact identifiers and editable blanks',async t=>{
 const data=fixture(t),query={startDate:'2026-10-01',endDate:'2026-10-31'};
 const rows=await Review.buildRows({},query,data);
 a.equal(rows.length,4);a.equal(rows[0].SN,'00123456789012345678');a.equal(rows[0]['原商品行编号'],'7');
 a.match(rows[0].建议处理方式,/调店/);a.match(rows[1].建议处理方式,/原月份/);a.equal(rows[0].请填确认处理意见,'');
 a.equal(new Set(rows.map(r=>r.问题编号)).size,4);
 const again=await Review.buildRows({},query,data);a.equal(again[0].问题编号,rows[0].问题编号);a.equal(again[0].数据核对指纹,rows[0].数据核对指纹);
 const single=await Review.buildRows({}, {...query,reviewRowKey:'staff:2'},data);a.equal(single.length,1);a.equal(single[0].员工,'乙');
 const hidden=await Review.buildRows({}, {...query,reviewRowKey:'not-visible'},data);a.equal(hidden.length,0);
});
test('download keeps only key fields and stores record identities in a hidden validation sheet',async t=>{
 const data=fixture(t),ctx={state:{user:{}},query:{startDate:'2026-10-01',endDate:'2026-10-31'},set(){}};
 await Review.exportReview(ctx,data);
 const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'});a.equal(wb.SheetNames.length,3);
 const rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);a.equal(rows.find(r=>r.问题.includes('产品端')).SN,'00123456789012345678');a.equal(rows[0].SN,'');a.equal(rows.length,4);
 a.ok(!('问题编号' in rows[0]));a.ok('确认值' in rows[0]);a.equal(wb.Workbook.Sheets[2].Hidden,1);
});

test('return personal missing line requests return-month basis while retaining true original sale month',()=>{
 const groups=Review.compact([{'具体原因':'11月门店盈亏平衡线未配置','问题月份':'2026-11','原销售月份':'2026-09','核算依据月份':'2026-11','原销售门店编号':'S','员工编号':'1','问题编号':'I','数据核对指纹':'F'}]);
 a.equal(groups[0].target.month,'2026-11');a.equal(groups[0].row.月份,'2026-11');
});
