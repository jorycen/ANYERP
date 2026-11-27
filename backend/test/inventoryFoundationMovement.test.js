const {test}=require('node:test'),a=require('node:assert/strict');
const M=require('../src/models'),R=require('../src/modules/inventory/foundationMovement'),I=require('../src/modules/inventory/foundationIntake');
const tx={LOCK:{UPDATE:'UPDATE'}};
test('流转混合票种、缺失或十月临时依据不被猜成已确认',()=>{
 const f=invoiceType=>({status:'confirmed',invoiceType,basisId:invoiceType});
 a.equal(R.consensus('P',[f('收据'),f('收据')],'move').invoiceType,'收据');
 for(const facts of [[],[null],[f('收据'),f('专票13%')],[{...f('收据'),source:{taxScope:'2026-10'}}]])a.equal(R.consensus('P',facts,'move').invoiceType,null);
});
test('调拨出库冻结原依据，来源库存变化后接收仍读取冻结来源',async t=>{
 let created;const refs=new Map();
 t.mock.method(M.InventoryFoundation,'findByPk',async id=>created?.basis_id===id?created:null);
 t.mock.method(M.InventoryFoundation,'create',async row=>(created={...row}));
 t.mock.method(M.InventoryFoundationRef,'findByPk',async key=>refs.get(key));
 t.mock.method(M.InventoryFoundationRef,'create',async row=>{refs.set(row.reference_key,row);return row;});
 await R.save('transfer_item:1','P',{productId:'P',invoiceType:'收据',basisIds:['ORIGINAL'],reason:'test'},tx);
 a.equal((await R.referenceReceipt('transfer_item:1','P',tx)).invoiceType,'收据');
 a.equal((await R.referenceReceipt('transfer_item:1','OTHER',tx)).invoiceType,null);
 a.equal(created.source_data.movement.basisIds[0],'ORIGINAL');
});
test('采购/退货/调拨同票种补货继承；混合存量待核实且旧档案不改写',async t=>{
 I.enable();let receipt,oldType='收据',created;const ref={basis_id:'OLD',async update(p){Object.assign(this,p);}};
 t.mock.method(M.Product,'findByPk',async()=>({name:'配件',need_sn:0}));
 t.mock.method(M.ProductPrice,'findOne',async()=>({cost_price:115}));
 t.mock.method(M.Location,'findByPk',async()=>({type:'normal_qty'}));
 t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>ref);
 t.mock.method(M.InventoryFoundation,'findByPk',async id=>id==='OLD'?{basis_id:'OLD',product_id:'P',status:'confirmed',invoice_type:oldType}:null);
 t.mock.method(M.InventoryFoundation,'create',async row=>(created=row));
 for(const type of ['收据','专票13%']){
  ref.basis_id='OLD';receipt={productId:'P',invoiceType:type,source:'transfer_item:1'};
  await I.captureInventory({inventory_id:'INV',product_id:'P',store_id:'B',location_id:'L',normal_qty:3},{transaction:tx,previousInventory:{normal_qty:1},foundationReceipt:receipt});
  a.equal(created.invoice_type,type===oldType?'收据':null);
 }
});
test('销售退货校验原单商品身份，缺关联明确待核实',async t=>{
 t.mock.method(M.SalesReturnRequest,'findOne',async()=>({return_id:'R',order_id:'O'}));
 t.mock.method(M.SalesReturnRequestItem,'findAll',async()=>[{order_item_id:1}]);
 t.mock.method(M.OrderItem,'findByPk',async()=>({order_id:'OTHER',product_id:'P'}));
 a.equal((await R.returnReceipt({source_no:'RET'},{product_id:'P'},tx)).invoiceType,null);
});
test('退货继承原销售明细档案，不读取当前商品票种',async t=>{
 t.mock.method(M.SalesReturnRequest,'findOne',async()=>({return_id:'R',order_id:'O'}));
 t.mock.method(M.SalesReturnRequestItem,'findAll',async()=>[{order_item_id:1,sn_code:'SN'}]);
 t.mock.method(M.OrderItem,'findByPk',async()=>({order_id:'O',product_id:'P'}));
 t.mock.method(M.InventoryFoundationRef,'findByPk',async key=>{a.equal(key,'order_item:1');return {basis_id:'ORIGINAL'};});
 t.mock.method(M.InventoryFoundation,'findByPk',async()=>({basis_id:'ORIGINAL',product_id:'P',status:'confirmed',invoice_type:'专票13%',purchase_cost:15}));
 a.equal((await R.returnReceipt({source_no:'RET'},{product_id:'P',sn_code:'SN'},tx)).invoiceType,'专票13%');
});

test('mixed acquisition prices keep cost, then FIFO consumption leaves the latest layer', async t => {
  I.enable();
  const initial = {
    basis_id: 'INITIAL', product_id: 'P', status: 'confirmed', invoice_type: '专票13%', purchase_cost: 110.69
  };
  const records = new Map([[initial.basis_id, initial]]);
  const ref = { basis_id: 'INITIAL', async update(patch) { Object.assign(this, patch); } };
  t.mock.method(M.Product, 'findByPk', async () => ({ name: '适配器', need_sn: 0 }));
  t.mock.method(M.ProductPrice, 'findOne', async () => null);
  t.mock.method(M.Location, 'findByPk', async () => ({ type: 'normal_qty' }));
  t.mock.method(M.InventoryFoundationRef, 'findByPk', async () => ref);
  t.mock.method(M.InventoryFoundation, 'findByPk', async id => records.get(id));
  t.mock.method(M.InventoryFoundation, 'create', async row => { records.set(row.basis_id, row); return row; });
  const inv = { inventory_id: 'INV', product_id: 'P', store_id: 'S', location_id: 'L', normal_qty: 6 };
  await I.captureInventory(inv, { transaction: tx, previousInventory: { normal_qty: 1 },
    foundationReceipt: { productId: 'P', unitCost: 90, invoiceType: '收据' } });
  a.equal(records.get(ref.basis_id).purchase_cost, 93.45);
  a.equal(records.get(ref.basis_id).invoice_type, null);
  a.equal(records.get(ref.basis_id).source_data.costLayers.length, 2);
  await I.captureInventory({ ...inv, normal_qty: 5 }, { transaction: tx, previousInventory: { normal_qty: 6 } });
  a.equal(records.get(ref.basis_id).purchase_cost, 90);
  a.equal(records.get(ref.basis_id).invoice_type, '收据');
  a.equal(records.get('INITIAL').purchase_cost, 110.69);
});

test('return uses exact archived purchase cost when the order foundation cost is missing', async t => {
  t.mock.method(M.SalesReturnRequest,'findOne',async()=>({return_id:'R',order_id:'O'}));
  t.mock.method(M.SalesReturnRequestItem,'findAll',async()=>[{order_item_id:1,quantity:2}]);
  t.mock.method(M.OrderItem,'findByPk',async()=>({order_id:'O',product_id:'P',original_inventory_cost:15}));
  t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>null);
  t.mock.method(M.OrderGrossProfit,'findOne',async()=>({product_pricing_details:[
    {itemId:1,productId:'P',purchasePrice:12,purchasePriceKnown:true,
      purchaseTaxBasis:{status:'confirmed',invoiceType:'收据',purchaseId:'PR'}}
  ]}));
  const receipt = await R.returnReceipt({source_no:'RET'},{product_id:'P',quantity:2},tx);
  a.deepEqual(receipt.costLayers,[{quantity:2,unitCost:12,invoiceType:'收据',estimated:false}]);
});
