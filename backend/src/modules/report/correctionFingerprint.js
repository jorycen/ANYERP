const crypto=require('node:crypto');
const maintenance=new Set(['update_time','calculated_at','calculated_by']);
function canonical(value){
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!maintenance.has(k)).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function businessOrder(order={}) {
 const keys=['order_id','order_no','store_id','order_status','is_deleted','create_time','archive_time','invoice_amount','invoice_status','total_amount','discount_amount','national_subsidy','education_subsidy','actual_payment','create_staff_id','auxiliary_sales_list','customer_source'];
 return Object.fromEntries(keys.filter(key=>order[key]!==undefined).map(key=>[key,order[key]]));
}
function fingerprint(input,before,order){return crypto.createHash('sha256').update(JSON.stringify(canonical({input,before,order:businessOrder(order)}))).digest('hex');}
function matchesSavedBasis(saved, selected, adjustment) {
 if (saved.result?.orderBasis && JSON.stringify(canonical(saved.result.orderBasis))!==JSON.stringify(canonical(businessOrder(selected.order)))) return false;
 if (!saved.result?.before || String(selected.order.order_id)!==String(adjustment.order_id) || String(selected.order.store_id)!==String(adjustment.store_id)) return false;
 // Legacy hashes included mutable order metadata and used a different serializer.
 // Compare the retained evidence and every displayed financial outcome directly.
 if (JSON.stringify(canonical(saved.result.before))!==JSON.stringify(canonical(selected.result.before))) return false;
 const keys=['itemId','quantity','beforeUnitPrice','afterUnitPrice','salesBefore','salesAfter','salesDelta','productBefore','productAfter','productDelta','beforeInvoiceAmount','afterInvoiceAmount','beforeInvoiceStatus','afterInvoiceStatus','vatBefore','vatAfter'];
 return keys.every(key=>JSON.stringify(canonical(saved.result[key]))===JSON.stringify(canonical(selected.result[key])));
}
module.exports={fingerprint,matchesSavedBasis,businessOrder};
