const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),F=require('../src/modules/inventory/foundation'),V=require('../src/modules/sales/purchaseVat');
test.after(()=>M.sequelize.close());
test('tax confirmation audits one canonical fact and preserves acquisition cost and pricing',async t=>{
  const row={basis_id:'B',status:'pending',invoice_type:null,purchase_cost:15,company_price:16,cost_mode:'COMPANY_PRICE',revision:1,source_data:{},
    toJSON(){return {...this};},async update(patch){Object.assign(this,patch);}};
  const logs=[];t.mock.method(M.BusinessActionLog,'create',async x=>logs.push(x));
  await F.confirmTaxEvidence(row,{status:'confirmed',invoiceType:'收据'},{name:'user'},'明确未税',{LOCK:{UPDATE:'UPDATE'}});
  a.equal(row.invoice_type,'收据');a.equal(row.status,'confirmed');a.equal(row.revision,2);
  a.equal(row.purchase_cost,15);a.equal(row.company_price,16);a.equal(row.cost_mode,'COMPANY_PRICE');
  a.equal(logs.length,1);a.equal(logs[0].action,'confirm_purchase_tax');
  await a.rejects(()=>F.confirmTaxEvidence(row,{status:'confirmed',invoiceType:'专票13%'},{name:'user'},'cannot overwrite',{}));
  a.equal(row.invoice_type,'收据');
});
test('real conflicts and unconfirmed evidence are rejected without writing',async t=>{
  const row={status:'conflict',reason:'基础资料冲突：invoice_type',source_data:{},toJSON(){return {...this};},async update(){a.fail('不得写入');}};
  await a.rejects(()=>F.confirmTaxEvidence(row,{status:'confirmed',invoiceType:'收据'},{name:'user'},'test',{}));
  row.status='pending';await a.rejects(()=>F.confirmTaxEvidence(row,{status:'pending'},{name:'user'},'test',{}));
});
test('archive error names the specific pending product but non-invoicing remains usable',()=>{
  const lines=[{itemId:1,productName:'联想X1散热支架',pnCode:'QB41R34336',purchaseTaxBasis:{status:'pending',reason:'缺少原采购'}}];
  a.throws(()=>V.calculateVat(lines,100,'开普票'),error=>error.code==='ORDER_PURCHASE_TAX_PENDING'&&error.message.includes('QB41R34336')&&error.pendingItems[0].reason==='缺少原采购');
  a.equal(V.calculateVat(lines,100,'不开票').amount,0);
});
test('saving an existing draft persists newly traced return tax to the same foundation',async t=>{
  const row={basis_id:'B',product_id:'P',identity_key:'import_sale:1',status:'pending',invoice_type:null,purchase_cost:15,revision:1,updated_by:'system',source_data:{},
    toJSON(){return {...this};},async update(patch){Object.assign(this,patch);}};
  t.mock.method(M.InventoryFoundationRef,'findAll',async()=>[{reference_key:'order_item:1',basis_id:'B'}]);
  t.mock.method(M.InventoryFoundation,'findAll',async()=>[row.toJSON()]);
  t.mock.method(M.InventoryFoundation,'findByPk',async()=>row);
  t.mock.method(M.Product,'findAll',async()=>[{product_id:'P',gross_profit_cost_mode:'COMPANY_PRICE'}]);
  t.mock.method(M.ProductPrice,'findAll',async()=>[{product_id:'P',standard_price:16}]);
  t.mock.method(M.BusinessActionLog,'create',async()=>({}));
  t.mock.method(M.InventoryFoundation,'create',async()=>a.fail('不能创建第二套基础事实'));
  await F.ensureSalesReferences({order_status:'未归档'},[{itemId:1,productId:'P',purchaseTaxBasis:{status:'confirmed',invoiceType:'收据',source:'sales_return_original_purchase'}}],{LOCK:{UPDATE:'UPDATE'}});
  a.equal(row.invoice_type,'收据');a.equal(row.status,'confirmed');a.equal(row.purchase_cost,15);
});
test('named maintenance/diagnostic services retain zero tax deduction without treating hardware as service',()=>{
  a.equal(V.isService({productName:'服务-深层保养'}),true);
  a.equal(V.isService({productName:'电脑检测维修'}),true);
  a.equal(V.isService({productName:'延保-意外保-THINK'}),true);
  a.equal(V.isService({productName:'四年至臻',category:'Care服务'}),true);
  a.equal(V.isService({productName:'四年至臻',category:'售后',pnCode:'ANY-CARE-NB-ZZ4'}),true);
  a.equal(V.isService({productName:'联想X1散热支架'}),false);
});
test('new imported non-SN sales reuse unanimous current-stock tax, never historical or mixed pools',async t=>{
  const facts=[{basis_id:'A',product_id:'P',status:'confirmed',invoice_type:'收据',source_data:{}},{basis_id:'B',product_id:'P',status:'confirmed',invoice_type:'收据',source_data:{}}];
  t.mock.method(M.InventoryFoundationRef,'findAll',async({where})=>{a.equal(where.store_id,'STORE');return [{reference_key:'inventory:I:normal_qty',basis_id:'A'},{reference_key:'inventory:J:normal_qty',basis_id:'B'}];});
  t.mock.method(M.Inventory,'findAll',async()=>[{inventory_id:'I',normal_qty:2},{inventory_id:'J',normal_qty:1}]);
  t.mock.method(M.InventoryFoundation,'findAll',async()=>facts);
  const order={store_id:'STORE',order_status:'未归档'},line={productId:'P',purchasePrice:15,quantity:2};
  let result=await F.inventoryTaxConsensus(order,line);a.equal(result.invoiceType,'收据');a.equal(result.purchaseAmount,30);
  a.equal(await F.inventoryTaxConsensus({...order,order_status:'已归档'},line),null);
  a.equal(await F.inventoryTaxConsensus(order,{...line,purchasePrice:null}),null);
  facts[1].invoice_type='专票13%';a.equal(await F.inventoryTaxConsensus(order,line),null);
  facts[1].invoice_type='收据';facts[1].status='pending';a.equal(await F.inventoryTaxConsensus(order,line),null);
  facts[1].status='confirmed';facts[1].source_data={taxScope:'2026-10'};a.equal(await F.inventoryTaxConsensus(order,line),null);
});
