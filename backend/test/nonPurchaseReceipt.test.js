const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const service = require('../src/modules/inventory/nonPurchaseReceipt');
const runtime = require('../src/modules/approval/businessRuntime');
const { buildProductSettlementItem } = require('../src/modules/report/productSettlement')._test;
const user = { staffId: 1, name: '申请人', roles: ['boss'], accessibleStoreIds: ['STORE'], accessibleDistributorIds: ['DIST'] };
const tx = { LOCK: { UPDATE: 'UPDATE' } };
function ctx(body={}, id='R1') { return { request:{body},params:{receiptId:id},state:{user},throw(status,message){throw Object.assign(new Error(message),{status});} }; }
function fixture(t) {
  const mock=(object,key,value)=>t.mock.method(object,key,value);
  const data={ items:[{ productId:'P1',productName:'内存',quantity:1,snCode:'RAM1',orderItemId:10,needSn:true,recoveryUnitCost:null }] };
  const row={ receipt_id:'R1',receipt_no:'REC1',source_type:service.RECOVERY,order_id:'O1',order_no:'ORD1',store_id:'STORE',distributor_id:'DIST',status:'pending',payload_json:JSON.stringify(data),applicant_staff_id:1,applicant_name:'申请人',reason:'拆机',toJSON(){return {...this};},async update(values){Object.assign(this,values);return this;} };
  const inbound={inbound_id:'I1',source_type:service.RECOVERY,store_id:'STORE'};
  const itemRows=[];
  let adjustment;
  mock(M.sequelize,'transaction',async fn=>fn(tx));
  mock(M.NonPurchaseReceipt,'findByPk',async()=>row);
  mock(M.NonPurchaseReceipt,'findOne',async()=>row);
  mock(M.Order,'findByPk',async()=>({order_id:'O1',order_no:'ORD1',store_id:'STORE',order_status:'已归档',create_user:'原销售'}));
  mock(M.Store,'findByPk',async()=>({store_id:'STORE',distributor_id:'DIST',status:1}));
  mock(M.SalesReturnRequest,'findOne',async()=>null);
  mock(M.OrderItem,'findAll',async()=>[{item_id:10,product_name:'整机',sn_code:'PC1'}]);
  mock(M.Product,'findOne',async()=>({product_id:'P1',name:'内存',need_sn:1,status:1}));
  mock(M.ProductPrice,'findOne',async()=>({standard_price:250}));
  mock(M.ProductSn,'findOne',async()=>null);
  mock(M.Inbound,'create',async values=>{Object.assign(inbound,values);return inbound;});
  mock(M.InboundItem,'create',async values=>{const item={...values,item_id:itemRows.length+1};itemRows.push(item);return item;});
  mock(M.InboundItem,'findAll',async()=>itemRows);
  mock(M.PerformanceProfitAdjustment,'create',async (values,options)=>{assert.equal(options.transaction,tx);adjustment=values;});
  mock(M.BusinessActionLog,'create',async()=>{});
  mock(runtime,'advance',async()=>true);
  return {row,inbound,itemRows,get adjustment(){return adjustment;}};
}
test('回收审批人必须填写成本，审批只生成入库单，验收才确认原销售毛利，且只能入库一次',async t=>{
  const f=fixture(t);
  await assert.rejects(service.review(ctx({action:'approve'})),/明确填写/);
  assert.equal(f.row.status,'pending');
  await service.review(ctx({action:'approve',costs:{0:'200.00'}}));
  assert.equal(f.row.status,'approved');assert.equal(f.row.total_amount,200);
  assert.equal(f.itemRows[0].unit_price,200);assert.equal(f.itemRows[0].gross_profit_use_standard_price,1);
  assert.equal(f.adjustment,undefined);
  f.itemRows[0].received_quantity=1;
  await service.completeInbound(f.inbound,user,tx);
  assert.equal(f.row.status,'received');assert.equal(f.adjustment.signed_amount,200);
  assert.equal(f.adjustment.order_id,'O1');assert.equal(f.adjustment.employee_name,'原销售');
  await assert.rejects(service.completeInbound(f.inbound,user,tx),/状态无效/);
});
test('获赠成本强制0，不生成原销售毛利，审批入库不调用采购付款服务',async t=>{
  const f=fixture(t); f.row.source_type='GIFT';f.row.order_id=null;f.inbound.source_type='GIFT';
  t.mock.method(M.PurchaseRequest,'create',async()=>assert.fail('不得创建采购单'));
  t.mock.method(M.Payable,'create',async()=>assert.fail('不得创建应付'));
  await service.review(ctx({action:'approve',costs:{0:999}}));
  assert.equal(f.row.total_amount,0);assert.equal(f.itemRows[0].unit_price,0);
  f.itemRows[0].received_quantity=1;
  await service.completeInbound(f.inbound,user,tx);
  assert.equal(f.adjustment,undefined);assert.equal(f.row.status,'received');
});
test('部分入库、跨门店、非法成本以及退单来源被拒绝',async t=>{
  const f=fixture(t);
  for(const value of ['',null,-1,'1.234','NaN',true]) assert.throws(()=>service.amount(value,'成本'),/明确填写/);
  assert.throws(()=>service.visible({...user,accessibleStoreIds:[]},'STORE','DIST'),/无权/);
  await service.review(ctx({action:'approve',costs:{0:200}}));
  f.itemRows[0].received_quantity=0;
  await assert.rejects(service.completeInbound(f.inbound,user,tx),/整单验收/);
  assert.equal(f.adjustment,undefined);
  t.mock.method(M.SalesReturnRequest,'findOne',async()=>({status:'pending'}));
  await assert.rejects(service.sourceOrder('O1',user,tx),/退单/);
});
test('申请人传成本无效；防重提交返回原单，拒绝后不入库',async t=>{
  const f=fixture(t);
  const body={sourceType:service.RECOVERY,orderId:'O1',reason:'拆机',requestKey:'request-key-123456',items:[{productId:'P1',quantity:1,snCode:'RAM1',orderItemId:10,recoveryUnitCost:999}]};
  f.row.request_key=body.requestKey;
  await service.create(ctx(body));assert.equal(f.row.status,'pending');
  await assert.rejects(service.create(ctx({...body,items:[{...body.items[0],quantity:2}]})),/不同内容/);
  assert.equal(JSON.parse(f.row.payload_json).items[0].recoveryUnitCost,null);
  await service.review(ctx({action:'reject',comment:'不符合要求'}));
  assert.equal(f.row.status,'rejected');assert.equal(f.itemRows.length,0);
});
test('明确获赠0成本和回收成本用于产品端结算，不能回退到当前商品成本',()=>{
  for(const cost of [0,200]) {
    const result=buildProductSettlementItem({item:{item_id:1,quantity:1,product_id:'P'},product:{need_sn:0},productPrice:{cost_price:900,standard_price:250},productPricingDetail:{nonPurchaseSource:cost?'SALES_COMPONENT_RECOVERY':'GIFT',purchasePriceKnown:true,purchasePrice:cost,unitPricing:250}});
    assert.equal(result.purchase_unit_cost,cost);assert.equal(result.cost_status,'ready');assert.equal(result.gross_profit_amount,250-cost);
  }
});

test('新申请不接受申请人成本，且回收与获赠只匹配自己的审批类型',async t=>{
  const f=fixture(t);let saved;
  t.mock.method(M.NonPurchaseReceipt,'findOne',async()=>null);
  t.mock.method(M.NonPurchaseReceipt,'findAll',async()=>[]);
  t.mock.method(M.NonPurchaseReceipt,'create',async values=>{saved=values;return {toJSON:()=>values};});
  await service.create(ctx({sourceType:service.RECOVERY,orderId:'O1',reason:'拆件',requestKey:'unique-key-12345678',items:[{productId:'P1',quantity:1,snCode:'RAM1',orderItemId:10,recoveryUnitCost:999}]}));
  assert.equal(JSON.parse(saved.payload_json).items[0].recoveryUnitCost,null);
  assert.equal(f.itemRows.length,0);assert.equal(f.adjustment,undefined);
  assert.equal(runtime.pending('sales_component_recovery',saved),true);
  assert.equal(runtime.pending('gift_receipt',saved),false);
});
test('通用入库接口也不能篡改已审批SN、数量或绕过权限',async t=>{
  const f=fixture(t);
  await service.review(ctx({action:'approve',costs:{0:200}}));
  const approved=JSON.parse(f.row.payload_json).items[0];
  const input={inboundItemId:approved.inboundItemId,productId:'P1',quantity:1,snCode:'RAM1'};
  await service.validateInboundRequest(f.inbound,[input],user,tx);
  await assert.rejects(service.validateInboundRequest(f.inbound,[{...input,snCode:'OTHER'}],user,tx),/必须与已审批/);
  await assert.rejects(service.validateInboundRequest(f.inbound,[],user,tx),/整单验收/);
  await assert.rejects(service.validateInboundRequest(f.inbound,[input],{...user,roles:['clerk'],accessibleDistributorIds:[]},tx),/无权/);
});
test('无SN混合库存只接纳有审批依据的零成本层，成本不完整不能冒充0',()=>{
  const {fifoRemainingAverageCost}=require('../src/modules/product/controller');
  const layers=[{unit_price:0,quantity:1,zero_cost_confirmed:1},{unit_price:200,quantity:1}];
  assert.equal(fifoRemainingAverageCost(layers,2,{requireComplete:true}),100);
  assert.equal(fifoRemainingAverageCost([{unit_price:0,quantity:1}],1,{requireComplete:true}),null);
  assert.equal(fifoRemainingAverageCost(layers,3,{requireComplete:true}),null);
});
test('无SN获赠验收复用成本服务并在同一事务刷新平均成本',async t=>{
  const f=fixture(t);f.row.source_type='GIFT';f.row.status='approved';f.row.payload_json=JSON.stringify({items:[{productId:'P1',needSn:false}]});
  f.inbound.source_type='GIFT';f.itemRows.push({quantity:1,received_quantity:1});
  let cost;
  t.mock.method(M.ProductPrice,'findOne',async()=>({cost_price_locked:0,update:async(values,options)=>{cost=values.cost_price;assert.equal(options.transaction,tx);}}));
  t.mock.method(require('../src/modules/product/controller'),'calculateFifoCost',async(id,options)=>{assert.equal(id,'P1');assert.equal(options.requireComplete,true);assert.equal(options.transaction,tx);return 100;});
  await service.completeInbound(f.inbound,user,tx);
  assert.equal(cost,100);assert.equal(f.row.status,'received');assert.equal(f.adjustment,undefined);
});
test('回收经营确认价值在公司财务中须等待原成本分摊，不能重复扣为采购成本',()=>{
  const {resolveFinancialCost}=require('../src/modules/report/financialProfitController');
  assert.equal(resolveFinancialCost({purchaseUnitCost:200,purchaseCostStatus:'ready',purchaseCostSource:'sales_component_recovery_value',originalInventoryCost:200}).unitCost,null);
  assert.equal(resolveFinancialCost({purchaseUnitCost:0,purchaseCostStatus:'ready',purchaseCostSource:'approved_non_purchase_receipt'}).unitCost,0);
});
