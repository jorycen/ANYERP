const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),F=require('../src/modules/inventory/foundation'),P=require('../src/modules/inventory/foundationMigration');
test('同一SN库存周期共用基础身份，重入库前后历史不串周期',()=>{
  const cycles=[{sn_id:'S',log_id:'new',create_time:'2026-11-01T00:00:00Z'}];
  a.equal(F.snKey('S',cycles,'2026-10-01'),'sn:S:original');a.equal(F.snKey('S',cycles,'2026-11-02'),'sn:S:new');
});
test('来源冲突明确隔离，未知成本不伪装零，零值可保留',()=>{
  const b=F.mergeCandidates([{invoice_type:'收据',purchase_cost:0},{invoice_type:'专票13%',purchase_cost:0}]);
  a.equal(b.status,'conflict');a.equal(b.invoice_type,null);a.equal(b.purchase_cost,0);
  a.equal(F.money(null),null);a.equal(F.money(''),null);a.equal(F.money(0),0);
});
test('订单和库存引用同一档案读取相同字段，未关联不得取商品或供应商默认',async t=>{
  t.mock.method(M.InventoryFoundationRef,'findAll',async()=>[{reference_key:'order_item:1',basis_id:'B'},{reference_key:'sn_current:S',basis_id:'B'}]);
  t.mock.method(M.InventoryFoundation,'findAll',async()=>[{basis_id:'B',status:'confirmed',invoice_type:'收据',purchase_cost:'100.00',cost_mode:'COMPANY_PRICE',company_price:'1639.00',revision:2}]);
  const refs=await F.load(['order_item:1','sn_current:S']);a.deepEqual(refs.get('order_item:1'),refs.get('sn_current:S'));
  const line=(await F.applySalesTaxBasis({},[{itemId:1,quantity:2}],null))[0];a.equal(line.purchaseTaxBasis.invoiceType,'收据');a.equal(line.purchaseTaxBasis.purchaseAmount,200);a.equal(line.purchaseTaxBasis.basisRevision,2);
  const missing=(await F.salesBasis({},[{itemId:999,productId:'same-product'}]))[0];a.equal(missing.inventoryFoundation.basisId,null);a.equal(missing.inventoryFoundation.purchaseCost,null);
});
test('迁移只合并同SN同周期；非SN历史明细不按同商品强合批次',()=>{
  const data={products:[],prices:[],sns:[{sn_id:'S',sn_code:'SN',product_id:'P',status:'sold'}],inventory:[],cycles:[],reviews:new Map(),
    orders:[{order_id:'O',order_no:'ORD20261001',create_time:'2026-10-01'}],items:[{item_id:1,product_id:'P',sn_id:'S'},{item_id:2,product_id:'P'},{item_id:3,product_id:'P'}],
    snapshots:[{order_id:'O',product_pricing_details:[1,2,3].map(itemId=>({itemId,productId:'P',snCode:itemId===1?'SN':'',purchasePrice:10,isCompanyPriced:false,purchaseTaxBasis:{status:'confirmed',invoiceType:'收据'}}))}]};
  const plan=P.plan(data);a.equal(plan.rows.length,3);a.equal(plan.counts.unlinkedNonSnSales,2);
  a(plan.rows.some(x=>x.identity_key==='sn:S:original'));a(plan.rows.some(x=>x.identity_key==='import_sale:2'));
});
test('修改基础资料使用版本校验和真实零确认，不自动改归档快照',async t=>{
  let written=false;t.mock.method(M.InventoryFoundation,'findByPk',async()=>({revision:3}));
  await a.rejects(()=>F.update('B',{revision:2},{},{LOCK:{UPDATE:'UPDATE'}}),/已变化/);
  t.mock.method(M.InventoryFoundation,'findByPk',async()=>({revision:3,toJSON:()=>({revision:3}),update:async()=>{written=true;}}));
  await a.rejects(()=>F.update('B',{revision:3,invoiceType:'收据',purchaseCost:0,companyPrice:null,costMode:null,reason:'确认'},{},{LOCK:{UPDATE:'UPDATE'}}),/零采购成本/);a.equal(written,false);
});
test('十月临时分类确认不能推广十一月；十一月已刷新依据优先于十月临时值',()=>{
  const base={products:[],prices:[],sns:[{sn_id:'S',sn_code:'SN',product_id:'P',status:'sold'}],inventory:[],cycles:[],reviews:new Map(),
    orders:[{order_id:'O',order_no:'ORD20261001',create_time:'2026-10-01'},{order_id:'N',order_no:'ORD20261101',create_time:'2026-11-01'}],
    items:[{item_id:1,product_id:'P',sn_id:'S'},{item_id:2,product_id:'P',sn_id:'S'}],snapshots:[]};
  const l=(itemId,basis)=>({itemId,productId:'P',snCode:'SN',purchasePrice:10,isCompanyPriced:false,purchaseTaxBasis:basis});
  base.snapshots=[{order_id:'O',product_pricing_details:[l(1,{status:'confirmed',invoiceType:'收据',source:'user_october_category_confirmation'})]},
    {order_id:'N',product_pricing_details:[l(2,{status:'pending'})]}];
  a.equal(P.plan(base).rows[0].invoice_type,null);
  base.snapshots[1].product_pricing_details[0].purchaseTaxBasis={status:'confirmed',invoiceType:'专票13%'};
  const row=P.plan(base).rows[0];a.equal(row.invoice_type,'专票13%');a.equal(row.status,'confirmed');
});
test('草稿换商品或换SN时不得沿用旧档案，SN改编码仍按内部身份识别',()=>{
  const b={basisId:'B',identityKey:'sn:S:original',productId:'P',snCode:'OLD'};
  a.equal(F.matchesLine(b,{productId:'OTHER',snId:'S'}),false);
  a.equal(F.matchesLine(b,{productId:'P',snId:'NEW'}),false);
  a.equal(F.matchesLine(b,{productId:'P',snId:'S',snCode:'RENAMED'}),true);
  a.equal(F.matchesLine(b,{productId:'P',snCode:''}),false);
});
