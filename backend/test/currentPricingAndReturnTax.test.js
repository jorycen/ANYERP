const test = require('node:test');
const a = require('node:assert/strict');
const M = require('../src/models');
const F = require('../src/modules/inventory/foundation');
const V = require('../src/modules/sales/purchaseVat');
test.after(() => M.sequelize.close());

test('frozen inventory foundation mode wins over mutable product mode', async t => {
  const product = {product_id:'P',gross_profit_cost_mode:'COMPANY_PRICE'};
  const price = {product_id:'P',standard_price:15400};
  const row = {basis_id:'B',product_id:'P',identity_key:'sn:S:original',status:'conflict',reason:'基础资料冲突：company_price',
    purchase_cost:15071,cost_mode:'PURCHASE_PRICE',company_price:null,source_data:{observations:[
      {source:'current_sn',invoice_type:'专票13%',purchase_cost:15071,company_price:15071},
      {source:'sales_snapshot',invoice_type:'专票13%',purchase_cost:15071,company_price:16000}]}};
  t.mock.method(M.InventoryFoundationRef,'findAll',async()=>[{reference_key:'order_item:1',basis_id:'B'}]);
  t.mock.method(M.InventoryFoundation,'findAll',async()=>[row]);
  t.mock.method(M.Product,'findAll',async()=>[product]);
  t.mock.method(M.ProductPrice,'findAll',async()=>[price]);
  const line={itemId:1,productId:'P',snId:'S',quantity:2,isSpecialPrice:false};
  let result=(await F.applySalesPricing({},[line]))[0];
  a.equal(result.unitPricing,15071);a.equal(result.pricingAmount,30142);
  a.equal(result.inventoryFoundation.status,'confirmed');a.equal(result.inventoryFoundation.invoiceType,'专票13%');
  price.standard_price=15999;
  a.equal((await F.applySalesPricing({},[line]))[0].unitPricing,15071);
  a.equal((await F.applySalesPricing({},[{...line,isSpecialPrice:true,specialPrice:123}]))[0].unitPricing,15071);
  product.gross_profit_cost_mode='COMPANY_PRICE';
  a.equal((await F.applySalesPricing({},[{...line,isSpecialPrice:true,specialPrice:123}]))[0].unitPricing,15071);
  row.source_data.observations[1].invoice_type='收据';
  a.equal((await F.load(['order_item:1'])).get('order_item:1').status,'conflict');
});

function returns(t, {ambiguous=false, invoiceType='收据', exact=true}={}) {
  t.mock.method(M.SalesReturnRequest,'findOne',async()=>({return_id:'R',order_id:'O'}));
  t.mock.method(M.SalesReturnRequestItem,'findAll',async()=>ambiguous?[{order_item_id:1},{order_item_id:2}]:[{order_item_id:1}]);
  t.mock.method(M.OrderItem,'findByPk',async()=>({item_id:1,product_id:'P',order_id:'O'}));
  t.mock.method(M.Order,'findByPk',async()=>({order_id:'O',store_id:'STORE',archive_time:'2026-10-30'}));
  t.mock.method(M.OrderGrossProfit,'findOne',async()=>({product_pricing_details:[{itemId:1,productId:'P',supplierId:'SUP',purchasePrice:51.29,
    pricingOrigin:exact?{sourceType:'purchase',receiptItemId:4066}:null}]}));
  t.mock.method(F,'salesBasis',async(o,lines)=>lines.map(x=>({...x,inventoryFoundation:{status:'pending'}})));
  t.mock.method(M.sequelize,'query',async()=>[{purchaseId:'PR',invoiceType,unitCost:50,productId:'P',storeId:'STORE',supplierId:'SUP'}]);
  return {itemId:9,productId:'P',quantity:2,purchasePrice:51.29,pricingOrigin:{sourceType:'sales_return',sourceNo:'RET'}};
}
test('return follows original sales item to exact purchase; freight-adjusted cost is preserved',async t=>{
  const line=returns(t),basis=(await V.resolveDocumentTaxBasis({store_id:'STORE'},[line]))[0].purchaseTaxBasis;
  a.equal(basis.status,'confirmed');a.equal(basis.invoiceType,'收据');a.equal(basis.purchaseAmount,102.58);
  a.equal(basis.originalItemId,1);a.equal(basis.source,'sales_return_original_purchase');
});
test('return without exact receipt accepts only unanimous original-store/supplier tax candidates',async t=>{
  const line=returns(t,{exact:false});
  a.equal((await V.resolveDocumentTaxBasis({store_id:'STORE'},[line]))[0].purchaseTaxBasis.status,'confirmed');
  t.mock.method(M.sequelize,'query',async()=>['收据','专票13%'].map(invoiceType=>({purchaseId:invoiceType,invoiceType,unitCost:50,productId:'P',storeId:'STORE',supplierId:'SUP'})));
  a.equal((await V.resolveDocumentTaxBasis({store_id:'STORE'},[line]))[0].purchaseTaxBasis.status,'pending');
});
test('ambiguous returned items remain pending rather than guessing the original purchase',async t=>{
  const line=returns(t,{ambiguous:true});
  a.equal((await V.resolveDocumentTaxBasis({},[line]))[0].purchaseTaxBasis.status,'pending');
});
