const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),F=require('../src/modules/inventory/foundation'),R=require('../src/modules/report/inventoryReport');
test('真实库存报表读取路径与订单基础资料一致，基础资料更新后两边同时变化，旧库存字段不参与回退',async t=>{
  t.after(()=>M.sequelize.close());
  t.mock.method(M.sequelize,'transaction',async(options,callback)=>(callback||options)({LOCK:{UPDATE:'UPDATE'}}));
  const basis={basis_id:'B',product_id:'P',status:'confirmed',invoice_type:'收据',purchase_cost:'100.00',cost_mode:'COMPANY_PRICE',company_price:'1639.00',revision:1};
  for(const name of ['ProductCategory','ProductPrice','Inventory','BusinessActionLog','ProductPn','ProductBarcode'])t.mock.method(M[name],'findAll',async()=>[]);
  t.mock.method(M.Product,'findAll',async()=>[{product_id:'P',name:'笔记本',category:'笔记本',need_sn:1}]);
  t.mock.method(M.ProductSn,'findAll',async()=>[{sn_id:'S',sn_code:'SN',product_id:'P',store_id:'STORE',location_id:'L',inventory_type:'normal_qty',inbound_price:'9999.00',status:'in_stock'}]);
  t.mock.method(M.Store,'findAll',async()=>[{store_id:'STORE',name:'门店'}]);t.mock.method(M.Location,'findAll',async()=>[{location_id:'L',type:'normal_qty'}]);
  t.mock.method(M.InventoryFoundationRef,'findAll',async()=>[{reference_key:'sn_current:S',basis_id:'B'},{reference_key:'order_item:1',basis_id:'B'}]);
  t.mock.method(M.InventoryFoundation,'findAll',async()=>[basis]);
  t.mock.method(M.sequelize,'query',async()=>a.fail('不得另查采购来源或计算一套基础资料'));
  for(const revision of [1,2]){
    const report=await R.load({dimensions:'product'},{roles:['boss'],accessibleStoreIds:['*']}),order=(await F.salesBasis({},[{itemId:1}]))[0].inventoryFoundation;
    a.equal(report.details[0].basisId,order.basisId);a.equal(report.details[0].invoiceType,order.invoiceType);
    a.equal(report.details[0].unitCost,order.purchaseCost);a.equal(report.details[0].basisRevision,revision);
    a.notEqual(report.details[0].unitCost,9999);
    basis.invoice_type='专票13%';basis.purchase_cost='200.00';basis.revision=2;
  }
});
