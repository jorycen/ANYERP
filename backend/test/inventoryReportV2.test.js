const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../src/modules/report/inventoryReport');
const {getInventoryQuantitySnapshot}=require('../src/utils/inventoryQuantities');
const base={category:'笔记本/联想',storeId:'A',storeName:'门店A',productId:'p',productName:'电脑',productCode:'SP1',quantity:1,type:'normal_qty',ageBucket:'d0_30',unitCost:100,costAmount:100,estimated:false,netEstimate:90,estimatedTax:10};
test('all dimension combinations preserve total quantity, cost, unknown costs and aging',()=>{
 const rows=[base,{...base,storeId:'B',storeName:'门店B',quantity:2,costAmount:200,netEstimate:180,estimatedTax:20},
  {...base,productId:'missing',quantity:3,unitCost:null,costAmount:null,netEstimate:null,ageBucket:'unknown'},
  {...base,productId:'zero',unitCost:0,costAmount:0,netEstimate:0,estimatedTax:0},
  {...base,productId:'estimate',costAmount:50,unitCost:50,estimated:true,netEstimate:null}];
 for(const dims of [['category'],['store'],['product'],['category','store'],['store','product'],['category','product'],['category','store','product']]){
  const groups=R.aggregate(rows,dims);
  assert.equal(groups.reduce((n,g)=>n+g.totalCount,0),8);
  assert.equal(groups.reduce((n,g)=>n+g.coveredCostAmount,0),350);
  assert.equal(groups.reduce((n,g)=>n+g.missingCostCount,0),3);
  assert.equal(groups.reduce((n,g)=>n+g.confirmedZeroCount,0),1);
  assert.equal(groups.reduce((n,g)=>n+g.unknown,0),3);
 }
 const summary=R.aggregate(rows,[])[0];assert.equal(summary.totalCost,null);assert.equal(summary.netAmount,null);
});
test('warehouse breakdown does not double count mirrored taxable stock and respects special warehouses',()=>{
 assert.equal(getInventoryQuantitySnapshot({normal_qty:5,regular_qty:2,subsidy_qty:3}).normal_qty,5);
 assert.equal(getInventoryQuantitySnapshot({regular_qty:2,subsidy_qty:3}).normal_qty,5);
 const special=getInventoryQuantitySnapshot({normal_qty:3,demo_qty:3},'demo_qty');assert.equal(special.demo_qty,3);assert.equal(special.normal_qty,0);
});
test('tax estimation requires actual document rate and does not assume 13 percent',()=>{
 assert.deepEqual(R.taxEstimate(1130,'专票13%'),{net:1000,tax:130});
 assert.deepEqual(R.taxEstimate(1130,'专票'),{net:null,tax:null});
 assert.deepEqual(R.taxEstimate(1130,''),{net:null,tax:null});
 assert.deepEqual(R.taxEstimate(null,'专票13%'),{net:null,tax:null});
 assert.deepEqual(R.taxEstimate(1130,'收据'),{net:1130,tax:0});
});
test('aging boundaries are explicit and missing/future dates remain unknown',()=>{
 const at=new Date('2026-11-02T00:00:00Z');
 for(const [days,expected]of [[0,'d0_30'],[30,'d0_30'],[31,'d31_60'],[60,'d31_60'],[61,'d61_90'],[90,'d61_90'],[91,'d90_plus']])assert.equal(R.bucket(new Date(at-days*86400000),at),expected);
 assert.equal(R.bucket(null,at),'unknown');assert.equal(R.bucket(new Date(at.getTime()+1),at),'unknown');
 assert.throws(()=>R.dimensions('wrong'));assert.deepEqual(R.dimensions('store,product,store'),['store','product']);
});
test('service scope keeps physical repair parts and ambiguous after-sales stock',()=>{
 assert.equal(R.nonPhysicalReason({name:'维修-配件更换',category:'售后',need_sn:0}),'');
 assert.equal(R.nonPhysicalReason({name:'联想 服务 系统重装',category:'售后',brand:'服务',need_sn:0}),'明确服务或虚拟项目');
 assert.equal(R.nonPhysicalReason({name:'纯利润',need_sn:0}),'明确服务或虚拟项目');
 assert.equal(R.nonPhysicalReason({name:'CARE卡',category:'售后'}),'CARE服务权益');
 assert.equal(R.nonPhysicalReason({name:'服务-电脑整机',category:'笔记本',need_sn:1}),'');
});
test('category paths follow category administration ordering',()=>{
 const tree=R.categoryPaths([{category_id:'b',parent_id:null,name:'手机',sort_order:2},{category_id:'a',parent_id:null,name:'电脑',sort_order:1},{category_id:'child',parent_id:'a',name:'拯救者',sort_order:1}]);
 assert.equal(tree.paths.get('child'),'电脑/拯救者');assert.deepEqual([...tree.order.keys()],['电脑','电脑/拯救者','手机']);
});
test('foreign store cannot be queried or exported through report parameters',async t=>{
 const M=require('../src/models');t.mock.method(M.sequelize,'transaction',async(_,fn)=>fn({}));
 await assert.rejects(R.load({storeId:'B'},{roles:['finance'],accessibleStoreIds:['A']}),{status:403});
});
