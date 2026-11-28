const F=require('./foundation'),V=require('../sales/purchaseVat');
function plan(data){
  const groups=new Map(),refs=new Map(),conflicts=[];
  const add=(key,identity,candidate,reference,storeId)=>{
    let identityConflict=false;
    if(groups.has(key)&&groups.get(key).product_id!==identity.product_id){
      groups.get(key).identityConflict=true;identityConflict=true;
      conflicts.push({identityKey:key,product:identity.product_name,reason:'同一SN周期关联不同商品，隔离历史记录待核对'});
      key='conflict:'+key+':'+identity.product_id;
    }
    if(!groups.has(key))groups.set(key,{...identity,identity_key:key,basis_id:F.id(key),candidates:[],references:[]});
    const g=groups.get(key);if(identityConflict||candidate.identityConflict)g.identityConflict=true;
    g.candidates.push(candidate);if(refs.has(reference)&&refs.get(reference)!==key)throw Error('关联记录对应多个批次');
    if(!refs.has(reference)){refs.set(reference,key);g.references.push({reference_key:reference,basis_id:g.basis_id,store_id:storeId});}
  };
  const products=new Map(data.products.map(x=>[x.product_id,x])),prices=new Map();for(const price of data.prices)if(!prices.has(price.product_id))prices.set(price.product_id,price);
  const sns=new Map(data.sns.map(x=>[x.sn_id,x])),byCode=new Map(),locations=new Map((data.locations||[]).map(x=>[x.location_id,x]));for(const sn of data.sns){if(!byCode.has(sn.sn_code))byCode.set(sn.sn_code,[]);byCode.get(sn.sn_code).push(sn);}
  const cycles=data.cycles||[],reviews=data.reviews||new Map(),review=require('../report/inventoryReview');
  for(const sn of data.sns.filter(x=>['in_stock','reserved','occupied'].includes(x.status)&&!Number(x.is_deleted))){
    const p=products.get(sn.product_id)||{};
    const old=review.taxOverride(reviews,'sn:'+sn.sn_id,review.snState(sn));
    const evidence=data.snEvidence?.get(sn.sn_id);
    const type=old?.invoiceType||evidence?.invoiceType||V.normalizeInvoiceType(sn.tax_type);
    const key=F.snKey(sn.sn_id,cycles);
    add(key,{product_id:sn.product_id,product_name:p.name||'',entity_type:'sn_cycle',sn_code:sn.sn_code,batch_no:sn.batch_no},
      {purchase_cost:F.money(sn.inbound_price)>0||data.zeroSnIds?.has(String(sn.sn_id))?F.money(sn.inbound_price):null,
        cost_mode:p.gross_profit_cost_mode||null,
        invoice_type:V.normalizeInvoiceType(type),source:'current_sn',reference:sn.sn_id,reviewBatch:old?.reviewBatch||null},
      'sn_current:'+sn.sn_id,sn.store_id);
  }
  for(const inv of data.inventory){const p=products.get(inv.product_id)||{};if(Number(p.need_sn)===1)continue;const price=prices.get(inv.product_id)||{};
    const quantities=require('../../utils/inventoryQuantities').getInventoryQuantitySnapshot(inv,locations.get(inv.location_id)?.type);
    for(const field of require('../../utils/inventoryQuantities').FIELDS){if(!(Number(quantities[field])>0))continue;
      const old=review.taxOverride(reviews,'inventory:'+inv.inventory_id+':'+field,review.inventoryState(inv));
      const key='import_inventory:'+inv.inventory_id+':'+field;
      add(key,{product_id:inv.product_id,product_name:p.name||'',entity_type:'import_inventory',batch_no:key},
        {purchase_cost:Number(price.cost_price)>0||Number(price.cost_price_locked)===1?F.money(price.cost_price):null,
          cost_mode:p.gross_profit_cost_mode||null,
          invoice_type:V.normalizeInvoiceType(old?.invoiceType),cost_estimated:Number(price.cost_price_locked)!==1,source:'import_inventory',reference:inv.inventory_id,reviewBatch:old?.reviewBatch||null},
        'inventory:'+inv.inventory_id+':'+field,inv.store_id);
    }
  }
  const items=new Map(data.items.map(x=>[String(x.item_id),x])),orders=new Map(data.orders.map(x=>[x.order_id,x]));
  for(const snapshot of data.snapshots){const o=orders.get(snapshot.order_id);if(!o)continue;const lines=typeof snapshot.product_pricing_details==='string'?JSON.parse(snapshot.product_pricing_details):snapshot.product_pricing_details||[];
    for(const l of lines){const item=items.get(String(l.itemId));if(!item||item.product_id!==l.productId){conflicts.push({orderNo:o.order_no,itemId:l.itemId,reason:'销售商品行缺失或身份不一致'});continue;}
      const options=item.sn_id&&sns.has(item.sn_id)?[sns.get(item.sn_id)]:(byCode.get(l.snCode)||[]).filter(x=>x.product_id===l.productId);
      const sn=options.length===1?options[0]:null;
      const identityConflict=!!(sn&&sn.product_id!==l.productId)||!!(l.snCode&&options.length!==1);
      const key=identityConflict?'identity_conflict_sale:'+item.item_id:sn?F.snKey(sn.sn_id,cycles,o.archive_time||o.create_time):'import_sale:'+item.item_id;
      const b=l.purchaseTaxBasis||{};
      add(key,{product_id:l.productId,product_name:l.productName,entity_type:sn?'sn_cycle':'import_sale',sn_code:l.snCode||'',batch_no:sn?.batch_no||'销售导入明细 '+item.item_id},
        {invoice_type:b.status==='confirmed'?V.normalizeInvoiceType(b.invoiceType):null,identityConflict,
          purchase_cost:l.purchasePriceKnown===false?null:F.money(l.purchasePrice)??(Number(item.original_inventory_cost)>0?F.money(item.original_inventory_cost):null),
          source:'sales_snapshot',reference:o.order_no,
          correctionId:l.correctionId||null,confirmationBatch:b.confirmationBatch||b.reviewBatch||null,
          taxScope:b.source==='user_october_category_confirmation'?'2026-10':null,
          missingBatch:!sn,reason:!sn?'历史非SN无明确批次，保留独立档案，禁止按商品强行合并':null},
        'order_item:'+item.item_id,o.store_id);
    }
  }
  const rows=[...groups.values()].map(g=>{
    const sharedOutsideOctober=g.candidates.some(x=>x.source==='current_sn'||x.source==='import_inventory'||String(x.reference||'').startsWith('ORD202611'));
    const applicable=g.candidates.map(x=>sharedOutsideOctober&&x.taxScope==='2026-10'?{...x,invoice_type:null}:x);
    const merged=F.mergeCandidates(applicable);
    const scopedOnly=!sharedOutsideOctober&&g.candidates.some(x=>x.taxScope==='2026-10'&&x.invoice_type)&&!g.candidates.some(x=>!x.taxScope&&x.invoice_type);
    if(g.identityConflict){merged.status='conflict';merged.reason='同一SN周期存在商品身份冲突';}
    if(merged.status==='conflict')conflicts.push({basisId:g.basis_id,identityKey:g.identity_key,product:g.product_name,reason:merged.reason});
    const costEstimated=g.candidates.some(x=>x.cost_estimated===true)&&!g.candidates.some(x=>x.purchase_cost!=null&&x.cost_estimated!==true);
    return {...g,...merged,source_data:{observations:g.candidates,imported:true,costEstimated,identityConflict:!!g.identityConflict,taxScope:scopedOnly?'2026-10':null},revision:1};});
  return {rows,conflicts,counts:{records:rows.length,references:refs.size,confirmed:rows.filter(x=>x.status==='confirmed').length,
    pending:rows.filter(x=>x.status==='pending').length,conflict:rows.filter(x=>x.status==='conflict').length,unlinkedNonSnSales:rows.filter(x=>x.entity_type==='import_sale').length}};
}
module.exports={plan};
