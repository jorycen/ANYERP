const test=require('node:test'),a=require('node:assert/strict'),F=require('../src/modules/sales/grossProfitInputs');
const order={store_id:'S',invoice_status:'普通发票',invoice_amount:'1800.00',total_amount:'1800.00',actual_payment:'1800.00'};
const item={item_id:1,product_id:'P',sn_id:'SN',quantity:1,sale_price:'1800.00',subtotal:'1800.00',selected_resource_types:null};
const payments=[{payment_id:1,payment_method:'QR',amount:'1800.00',coupon_snapshot:null}];
test('相同财务值携带备注照片或状态不触发归档重算，金额类型与空资源格式归一',()=>{
  const before=F.fingerprint(order,[item],payments);
  const after=F.fingerprint({...order,remark:'补备注',order_status:'已归档',product_photo_urls:['image'],invoice_amount:1800},[{...item,selected_resource_types:'[]'}],[{...payments[0],payment_id:999,amount:1800}]);
  a.equal(before,after);a.equal(F.hasPayload({remark:'备注',product_photo_urls:['image']},false),false);
});
test('开票类型、金额、商品单价数量SN及实际优惠券依据变化仍触发财务校验',()=>{
  const before=F.fingerprint(order,[item],payments);
  for(const delta of [{invoice_amount:1900},{invoice_status:'不开票'},{store_id:'OTHER'},{deposit_deduction_total:100,deposit_items:[{depositId:'D',amount:100}]}])a.notEqual(before,F.fingerprint({...order,...delta},[item],payments));
  for(const delta of [{sale_price:1900},{quantity:2},{sn_id:'NEW'},{item_id:2},{supplier_id:'NEW-SUPPLIER'},{product_name:'清灰'}])a.notEqual(before,F.fingerprint(order,[{...item,...delta}],payments));
  a.notEqual(before,F.fingerprint(order,[item],[{...payments[0],amount:1700}]));
  a.notEqual(before,F.fingerprint(order,[item],[{...payments[0],coupon_snapshot:{companyAmount:10}}]));
  a.equal(F.hasPayload({payments},false),true);
});
