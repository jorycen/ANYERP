const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),F=require('../src/modules/inventory/foundation'),I=require('../src/modules/inventory/foundationIntake'),V=require('../src/modules/sales/purchaseVat');
const tx={LOCK:{UPDATE:'UPDATE'}};
test('SN重新入库建立新周期基础档案，旧销售所用档案保持',async t=>{
  I.enable();const old={basis_id:F.id('sn:S:original'),purchase_cost:1000},records=new Map([[old.basis_id,old]]),ref={basis_id:old.basis_id,async update(x){Object.assign(this,x);}};
  t.mock.method(M.SnLog,'findAll',async()=>[{sn_id:'S',log_id:'REENTRY',create_time:'2026-11-01'}]);
  t.mock.method(M.InventoryFoundation,'findByPk',async key=>records.get(key));
  t.mock.method(M.InventoryFoundation,'create',async value=>{records.set(value.basis_id,value);return value;});
  t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>ref);
  t.mock.method(M.Product,'findByPk',async()=>({name:'笔记本',gross_profit_cost_mode:'PURCHASE_PRICE'}));
  t.mock.method(M.ProductPrice,'findOne',async()=>({standard_price:3000}));
  t.mock.method(V,'resolveDocumentTaxBasis',async(o,ls)=>ls.map(l=>({...l,purchaseTaxBasis:{status:'confirmed',invoiceType:'专票13%'}})));
  await I.captureSn({sn_id:'S',sn_code:'SN',product_id:'P',store_id:'A',status:'in_stock',inbound_price:2000},{transaction:tx});
  a.equal(old.purchase_cost,1000);a.equal(ref.basis_id,F.id('sn:S:REENTRY'));a.equal(records.get(ref.basis_id).purchase_cost,2000);
  a.equal(Object.hasOwn(records.get(ref.basis_id), 'company_price'), false);
});
test('非SN库存增加不继承旧批次票种和成本；旧销售基础档案不被改写',async t=>{
  I.enable();const old={basis_id:'OLD',invoice_type:'收据',purchase_cost:20},ref={basis_id:'OLD',async update(x){Object.assign(this,x);}},created=[];
  t.mock.method(M.Product,'findByPk',async()=>({name:'配件',need_sn:0}));t.mock.method(M.ProductPrice,'findOne',async()=>({cost_price:50,standard_price:100}));t.mock.method(M.Location,'findByPk',async()=>({type:'normal_qty'}));
  t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>ref);t.mock.method(M.InventoryFoundation,'findByPk',async key=>key==='OLD'?old:null);
  t.mock.method(M.InventoryFoundation,'create',async value=>{created.push(value);return value;});
  await I.captureInventory({inventory_id:1,product_id:'P',store_id:'A',location_id:'L',normal_qty:3},
    {transaction:tx,previousInventory:{normal_qty:1}});
  a.equal(created.length,1);a.equal(created[0].invoice_type,null);a.equal(created[0].purchase_cost,null);a.equal(created[0].status,'pending');a.notEqual(ref.basis_id,'OLD');a.equal(old.invoice_type,'收据');a.equal(old.purchase_cost,20);
  a.equal(Object.hasOwn(created[0], 'company_price'), false);
});
test('原业务确认的同周期成本和计价变更同步统一档案，票种不被数量或价格变动覆盖',async t=>{
  I.enable();const basis={basis_id:F.id('sn:S:original'),product_id:'P',invoice_type:'收据',status:'confirmed',purchase_cost:1000,company_price:2500,cost_mode:'PURCHASE_PRICE',revision:1,source_data:{},
    toJSON(){return {...this};},async update(x){Object.assign(this,x);}};
  t.mock.method(M.SnLog,'findAll',async()=>[]);t.mock.method(M.InventoryFoundation,'findByPk',async()=>basis);
  t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>({async update(){}}));
  const logs=[];t.mock.method(M.BusinessActionLog,'create',async value=>logs.push(value));
  await I.captureSn({sn_id:'S',sn_code:'SN',product_id:'P',store_id:'A',status:'in_stock',inbound_price:2000,original_pickup_price:3000,gross_profit_use_standard_price:1},
    {transaction:tx,previousSn:{status:'in_stock',inbound_price:1000,original_pickup_price:2500,gross_profit_use_standard_price:0}});
  a.equal(basis.purchase_cost,2000);a.equal(basis.company_price,2500);a.equal(basis.cost_mode,'PURCHASE_PRICE');a.equal(basis.invoice_type,'收据');a.equal(basis.revision,2);a.equal(logs[0].action,'sync_inventory_fact');
});
