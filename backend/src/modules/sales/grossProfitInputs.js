const M=require('../../models');
const orderNumbers=['total_amount','actual_payment','discount_amount','national_subsidy','education_subsidy','invoice_amount','deposit_deduction_total'];
const itemNumbers=['quantity','sale_price','subtotal','original_inventory_cost','original_pickup_price','current_pickup_price_at_sale','p0_difference_amount','cost_adjustment_amount','sales_settlement_cost','freight_cost','use_gov_subsidy','use_edu_subsidy','education_subsidy_amount'];
const num=v=>v===null||v===undefined||v===''?null:Number(v);
function canonical(value){
  if(value===null||value===undefined)return null;
  if(Array.isArray(value))return value.map(canonical);
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
function parsed(value){if(typeof value!=='string')return value??null;try{return JSON.parse(value);}catch{return value;}}
function resources(value){const v=parsed(value);return Array.isArray(v)?[...new Set(v)].sort():v===null||v===''?[]:v;}
function entries(value){const v=parsed(value);return v===null||v===''?[]:v;}
function fingerprint(order,items,payments){
  const data=order.toJSON?order.toJSON():order;
  return JSON.stringify(canonical({order:{...Object.fromEntries(orderNumbers.map(k=>[k,num(data[k])])),
    store_id:data.store_id,invoice_status:data.invoice_status,deposit_items:entries(data.deposit_items)},
    items:items.map(x=>({...Object.fromEntries(itemNumbers.map(k=>[k,num(x[k])])),item_id:String(x.item_id),
      product_id:x.product_id||null,product_name:x.product_name||'',supplier_id:x.supplier_id||null,sn_id:x.sn_id||null,sn_code:x.sn_code||'',pn_code:x.pn_code||'',
      selected_resource_types:resources(x.selected_resource_types)})).sort((a,b)=>a.item_id.localeCompare(b.item_id)),
    // Recreated payment row IDs are not an amount/rate change. Coupon snapshots
    // are business inputs and remain part of the comparison.
    payments:payments.map(x=>({method:x.payment_method,amount:num(x.amount),coupon:parsed(x.coupon_snapshot)}))
      .sort((a,b)=>JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))))}));
}
function hasPayload(data,hasItems){return hasItems||Array.isArray(data.payments)||[
  ...orderNumbers,'totalAmount','actualPayment','discount','discountAmount','nationalSubsidy','educationSubsidy','invoiceAmount','invoice_status','invoiceStatus','store_id','storeId','depositItems','deposit_items','deposits','depositDeductionTotal'
].some(k=>data[k]!==undefined);}
async function capture(order,transaction){
  const [items,payments]=await Promise.all([
    M.OrderItem.findAll({where:{order_id:order.order_id},raw:true,transaction}),
    M.OrderPayment.findAll({where:{order_id:order.order_id},raw:true,transaction})]);
  return fingerprint(order,items,payments);
}
module.exports={fingerprint,hasPayload,capture};
