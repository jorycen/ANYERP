const test=require('node:test'),a=require('node:assert/strict'),{classify}=require('../scripts/apply-october-category-tax'),V=require('../src/modules/sales/purchaseVat');
const line=(category,price=100)=>({category,productName:'测试商品',quantity:1,unitPricing:price,isCompanyPriced:true,
  purchaseTaxBasis:{version:V.VERSION,status:'confirmed',service:false,purchaseAmount:80,invoiceType:classify({category})}});
test('十月整机含税、配件未税按已有税费服务计算，服务抵减为零',()=>{
  a.equal(V.calculateVat([line('笔记本')],200,'普通发票').amount,13);
  a.equal(V.calculateVat([line('电脑配件')],200,'普通发票').amount,26);
  const service={...line('服务'),purchaseTaxBasis:{version:V.VERSION,status:'confirmed',service:true,purchaseAmount:0,invoiceType:'收据'}};
  a.equal(V.calculateVat([service],200,'普通发票').amount,26);
  a.equal(V.calculateVat([line('电脑配件')],200,'不开票').amount,0);
});
test('未授权类别保持例外，混合整机配件不猜测税额分配',()=>{
  a.equal(classify({category:'二手/联想/小新'}),null);a.equal(classify({category:''}),null);
  a.throws(()=>V.calculateVat([line('笔记本'),line('选件')],200,'普通发票'),/类型不一致/);
});
