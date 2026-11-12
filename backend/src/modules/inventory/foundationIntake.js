// Source writes feed the canonical foundation. Readers never perform migration
// or mutate it. Quantity changes do not replace confirmed tax attributes.
let ready=false;
const enable=()=>{ready=true;};
async function captureSn(value,options={}){
  if(!ready)return;
  const M=require('../../models'),F=require('./foundation'),V=require('../sales/purchaseVat'),sn=value.toJSON?value.toJSON():value;
  if(!['in_stock','reserved','occupied'].includes(sn.status)||Number(sn.is_deleted))return;
  const previous=options.previousSn||(value.isNewRecord===false?value._previousDataValues:null);
  if(!options.transaction)return M.sequelize.transaction(transaction=>captureSn(sn,{...options,previousSn:previous,transaction}));
  const transaction=options.transaction,cycles=await M.SnLog.findAll({where:{sn_id:sn.sn_id,action:'stock_cycle_reentry'},raw:true,transaction}),key=F.snKey(sn.sn_id,cycles),basisId=F.id(key);
  let basis=await M.InventoryFoundation.findByPk(basisId,{transaction,lock:transaction.LOCK.UPDATE});
  const newlyCreated=!basis;
  const zeroConfirmed=Number(sn.inbound_price)===0&&(['GIFT','SALES_COMPONENT_RECOVERY'].includes(String(sn.source_type||'').toUpperCase())||
    (await require('../../utils/costKnowledge').confirmedZeroSnIds([sn],transaction)).has(String(sn.sn_id)));
  if(!basis){const product=await M.Product.findByPk(sn.product_id,{raw:true,transaction});
    const line={productId:sn.product_id,snCode:sn.sn_code,productName:product?.name||'',quantity:1,purchasePrice:F.money(sn.inbound_price)};
    const docs=await V.resolveDocumentTaxBasis({store_id:sn.store_id},[line],transaction),tax=docs[0].purchaseTaxBasis;
    basis=await M.InventoryFoundation.create({basis_id:basisId,identity_key:key,product_id:sn.product_id,product_name:product?.name||'',entity_type:'sn_cycle',sn_code:sn.sn_code,batch_no:sn.batch_no,
      purchase_cost:Number(sn.inbound_price)>0||zeroConfirmed?F.money(sn.inbound_price):null,
      cost_mode:product?.gross_profit_cost_mode||null,
      invoice_type:tax.status==='confirmed'?tax.invoiceType:null,status:tax.status==='confirmed'?'confirmed':'pending',
      source_data:{source:'sn_intake',purchaseBasis:tax},revision:1,updated_by:'system'}, {transaction});
  }
  if(!newlyCreated&&previous&&previous.status!=='out_stock'&&basis.product_id===sn.product_id){
    const patch={};
    if(String(previous.inbound_price)!==String(sn.inbound_price))patch.purchase_cost=Number(sn.inbound_price)>0||zeroConfirmed?F.money(sn.inbound_price):null;
    if(Object.keys(patch).length){const before=basis.toJSON();await basis.update({...patch,revision:Number(basis.revision)+1,updated_by:'system',update_time:new Date()},{transaction});
      await require('../../utils/businessActionLog').recordBusinessAction({businessType:'inventory_foundation',businessId:basisId,action:'sync_inventory_fact',user:{name:'system'},comment:'原库存业务确认的同周期基础信息变更',detail:{before,after:basis.toJSON(),snId:sn.sn_id},transaction});}
  }
  await F.clearScopedTax(basis,transaction);
  const ref=await M.InventoryFoundationRef.findByPk('sn_current:'+sn.sn_id,{transaction,lock:transaction.LOCK.UPDATE});
  if(ref)await ref.update({basis_id:basisId,store_id:sn.store_id},{transaction});
  else await M.InventoryFoundationRef.create({reference_key:'sn_current:'+sn.sn_id,basis_id:basisId,store_id:sn.store_id},{transaction});
}
async function captureInventory(value,options={}){
  if(!ready)return;const M=require('../../models'),F=require('./foundation'),inv=value.toJSON?value.toJSON():value;
  const previous=options.previousInventory||(value.isNewRecord===false?value._previousDataValues:null);
  if(!options.transaction)return M.sequelize.transaction(transaction=>captureInventory(inv,{...options,previousInventory:previous,transaction}));
  const transaction=options.transaction,product=await M.Product.findByPk(inv.product_id,{raw:true,transaction});if(!product||Number(product.need_sn)===1)return;
  const price=await M.ProductPrice.findOne({where:{product_id:inv.product_id,status:1},raw:true,transaction});
  const location=inv.location_id?await M.Location.findByPk(inv.location_id,{raw:true,transaction}):null;
  const quantities=require('../../utils/inventoryQuantities').getInventoryQuantitySnapshot(inv,location?.type);
  const oldQuantities=previous?require('../../utils/inventoryQuantities').getInventoryQuantitySnapshot(previous,location?.type):null;
  for(const field of require('../../utils/inventoryQuantities').FIELDS){if(!(Number(quantities[field])>0))continue;
    const referenceKey='inventory:'+inv.inventory_id+':'+field;
    const ref=await M.InventoryFoundationRef.findByPk(referenceKey,{transaction,lock:transaction.LOCK.UPDATE});
    const increased=!!ref&&!!oldQuantities&&Number(quantities[field])>Number(oldQuantities[field]);
    const key='import_inventory:'+inv.inventory_id+':'+field+(increased?':event:'+require('node:crypto').randomUUID():''),basisId=increased?F.id(key):ref?.basis_id||F.id(key),existing=await M.InventoryFoundation.findByPk(basisId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!existing)await M.InventoryFoundation.create({basis_id:basisId,identity_key:key,product_id:inv.product_id,product_name:product.name,entity_type:'import_inventory',batch_no:key,
      purchase_cost:increased?null:Number(price?.cost_price)>0||Number(price?.cost_price_locked)===1?F.money(price?.cost_price):null,
      cost_mode:increased?null:product.gross_profit_cost_mode||null,invoice_type:null,status:'pending',
      reason:increased?'非SN聚合库存增加，不能沿用旧批次含税属性，需核实本次批次':'聚合非SN库存没有明确批次，需在统一基础资料确认',source_data:{source:'inventory_intake',inventoryId:inv.inventory_id,previousBasisId:ref?.basis_id||null},revision:1,updated_by:'system'}, {transaction});
    if(ref&&ref.basis_id!==basisId)await ref.update({basis_id:basisId,store_id:inv.store_id},{transaction});
    else await F.bind(referenceKey,basisId,inv.store_id,transaction);
  }
}
function install(M){
  const attach=(model,capture)=>{
    model.addHook('afterSave','inventoryFoundation',capture);
    model.addHook('afterBulkCreate','inventoryFoundation',async(rows,opts)=>{for(const row of rows)await capture(row,opts);});
    model.addHook('beforeBulkUpdate','inventoryFoundationBefore',async opts=>{if(!ready||opts.individualHooks)return;opts.foundationBefore=await model.findAll({where:opts.where,raw:true,transaction:opts.transaction});});
    model.addHook('afterBulkUpdate','inventoryFoundation',async opts=>{if(!ready||opts.individualHooks)return;const rows=await model.findAll({where:opts.where,transaction:opts.transaction});for(const row of rows)await capture(row,{...opts,
      previousInventory:model===M.Inventory?opts.foundationBefore?.find(x=>x.inventory_id===row.inventory_id):null,
      previousSn:model===M.ProductSn?opts.foundationBefore?.find(x=>x.sn_id===row.sn_id):null});});
  };
  attach(M.ProductSn,captureSn);attach(M.Inventory,captureInventory);
  const cycle=async(log,opts)=>{if(!ready||log.action!=='stock_cycle_reentry')return;const sn=await M.ProductSn.findByPk(log.sn_id,{transaction:opts.transaction});if(sn)await captureSn(sn,opts);};
  M.SnLog.addHook('afterCreate','inventoryFoundationCycle',cycle);
  M.SnLog.addHook('afterBulkCreate','inventoryFoundationCycle',async(logs,opts)=>{if(opts.individualHooks)return;for(const log of logs)await cycle(log,opts);});
}
module.exports={enable,install,captureSn,captureInventory};
