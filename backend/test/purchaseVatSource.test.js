const test=require('node:test'),a=require('node:assert/strict'),V=require('../src/modules/sales/purchaseVat'),M=require('../src/models');
test('purchase invoice aliases are explicit; legacy receipt-or-normal follows confirmed receipt mapping',()=>{a.equal(V.normalizeInvoiceType('收据'),'收据');a.equal(V.normalizeInvoiceType('增专票（13%）'),'专票13%');a.equal(V.normalizeInvoiceType('未税（收据或普票）'),'收据');a.equal(V.normalizeInvoiceType('NONE'),null);});
test('historical non-SN candidates must all agree on tax mode, never pick latest purchase',async t=>{const order={store_id:'S',archive_time:'2026-10-20'},line={productId:'P',productName:'硬盘',purchasePrice:350,quantity:2,supplierId:'V'};const row={productId:'P',storeId:'S',supplierId:'V',unitCost:350,receiptTime:'2026-10-01',invoiceType:'收据'};let r=await V.attachPurchaseTaxBasis(order,[line],null,new Map([['product:P',[{...row,purchaseId:'A'},{...row,purchaseId:'B'}]]]));a.equal(r[0].purchaseTaxBasis.status,'confirmed');a.equal(r[0].purchaseTaxBasis.purchaseAmount,700);r=await V.attachPurchaseTaxBasis(order,[line],null,new Map([['product:P',[{...row,purchaseId:'A'},{...row,purchaseId:'B',invoiceType:'专票13%'}]]]));a.equal(r[0].purchaseTaxBasis.status,'pending');});
test('service tax base zero does not mutate company cost; absent receipt is not guessed',async()=>{const line={productName:'Lenovo CARE 智惠4年',unitPricing:268,quantity:1};const r=await V.attachPurchaseTaxBasis({},[line],null,new Map());a.equal(r[0].unitPricing,268);a.equal(r[0].purchaseTaxBasis.purchaseAmount,0);const missing=await V.attachPurchaseTaxBasis({store_id:'S'},[{productId:'P',productName:'硬盘',purchasePrice:0,quantity:1}],null,new Map());a.equal(missing[0].purchaseTaxBasis.status,'pending');});
test('exact confirmed foundation survives a heuristic return source without querying missing legacy documents',async()=>{
 const basis={basisId:'B',identityKey:'import_sale:1',productId:'P',snCode:'',status:'confirmed',invoiceType:'收据',revision:2,source:{}};
 const line={itemId:1,productId:'P',productName:'清洁套装',purchasePrice:2,quantity:2,inventoryFoundation:basis,pricingOrigin:{sourceType:'sales_return',sourceNo:'RET-OLD'}};
 const result=await V.resolveDocumentTaxBasis({store_id:'S'},[line],null,new Map());
 a.equal(result[0].purchaseTaxBasis.status,'confirmed');a.equal(result[0].purchaseTaxBasis.basisId,'B');a.equal(result[0].purchaseTaxBasis.purchaseAmount,4);
});
test('legacy non-SN return hint may reuse live-stock consensus only through the guarded foundation service',async t=>{
 const F=require('../src/modules/inventory/foundation');
 t.mock.method(M.SalesReturnRequest,'findOne',async()=>null);
 t.mock.method(F,'inventoryTaxConsensus',async order=>order.order_status==='未归档'?{status:'confirmed',invoiceType:'收据',purchaseAmount:15,source:'confirmed_current_inventory_tax'}:null);
 const line={itemId:1,productId:'P',productName:'散热支架',purchasePrice:15,quantity:1,pricingOrigin:{sourceType:'sales_return',sourceNo:'R'}};
 let r=await V.resolveDocumentTaxBasis({order_status:'未归档'},[line]);a.equal(r[0].purchaseTaxBasis.status,'confirmed');a.equal(r[0].purchaseTaxBasis.ignoredReturnHint,'R');
 r=await V.resolveDocumentTaxBasis({order_status:'已归档'},[line]);a.equal(r[0].purchaseTaxBasis.status,'pending');
 r=await V.resolveDocumentTaxBasis({order_status:'未归档'},[{...line,snCode:'SN'}]);a.equal(r[0].purchaseTaxBasis.status,'pending');
});
test('return tracing uses exact return item and original foundation even without an old pricing snapshot',async t=>{
 const F=require('../src/modules/inventory/foundation');
 t.mock.method(M.SalesReturnRequest,'findOne',async()=>({return_id:'R',order_id:'O'}));
 t.mock.method(M.SalesReturnRequestItem,'findAll',async()=>[{item_id:1,order_item_id:10},{item_id:2,order_item_id:11}]);
 t.mock.method(M.OrderItem,'findByPk',async id=>({item_id:id,order_id:'O',product_id:'P',product_name:'配件',pn_code:'PN',sn_code:''}));
 t.mock.method(M.Order,'findByPk',async()=>({order_id:'O',store_id:'S',order_status:'已归档'}));
 t.mock.method(M.OrderGrossProfit,'findOne',async()=>null);
 t.mock.method(F,'salesBasis',async(order,lines)=>{a.equal(lines[0].itemId,11);return [{...lines[0],inventoryFoundation:{basisId:'B',status:'confirmed',invoiceType:'收据',source:{}}}];});
 const line={productId:'P',productName:'配件',purchasePrice:15,quantity:2,pricingOrigin:{sourceType:'sales_return',sourceNo:'RET',returnItemId:2}};
 const r=await V.resolveDocumentTaxBasis({store_id:'S'},[line]);a.equal(r[0].purchaseTaxBasis.status,'confirmed');a.equal(r[0].purchaseTaxBasis.originalItemId,11);a.equal(r[0].purchaseTaxBasis.purchaseAmount,30);
});
