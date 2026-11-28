const M=require('../../models'),F=require('./foundation'),{Op}=require('sequelize');
const { getUserRoles }=require('../../middleware/permission');
const {distributorWhere}=require('../../utils/distributorScope');
async function scope(ctx){
  const roles=getUserRoles(ctx.state.user);
  if(!roles.includes('boss')){
    const rs=await M.Role.findAll({where:{role_code:{[Op.in]:roles},status:1},raw:true});
    const links=await M.RoleMenu.findAll({where:{role_id:{[Op.in]:rs.map(x=>x.role_id)}},raw:true});
    const menu=await M.Menu.findOne({where:{menu_id:{[Op.in]:links.map(x=>x.menu_id)},path:'/products/price',status:1}});
    if(!menu)ctx.throw(403,'需要价格管理权限');
  }
  return (await M.Store.findAll({where:{...distributorWhere(ctx.state.user),is_deleted:0},attributes:['store_id'],raw:true})).map(x=>x.store_id);
}
async function authorized(ctx,basisId,stores,transaction,write=false){
  const refs=await M.InventoryFoundationRef.findAll({where:{basis_id:basisId},raw:true,transaction});
  if(!refs.length||!refs.some(x=>stores.includes(x.store_id)))ctx.throw(404,'基础档案不存在或无权操作');
  if(write&&refs.some(x=>!stores.includes(x.store_id)))ctx.throw(403,'关联记录跨越授权门店，需完整数据范围核实');
  return refs;
}
async function list(ctx){const stores=await scope(ctx),q=ctx.query,page=Math.max(1,Number(q.page)||1),size=Math.min(100,Math.max(1,Number(q.pageSize)||20));
  const refs=await M.InventoryFoundationRef.findAll({where:{store_id:{[Op.in]:stores},...(q.referenceKey?{reference_key:String(q.referenceKey)}:{})},raw:true});
  const where={basis_id:{[Op.in]:[...new Set(refs.map(x=>x.basis_id))]}};
  if(q.productId)where.product_id=String(q.productId);
  if(q.status)where.status=String(q.status);
  if(q.keyword){const k='%'+String(q.keyword).slice(0,100)+'%';where[Op.or]=[{product_name:{[Op.like]:k}},{sn_code:{[Op.like]:k}},{batch_no:{[Op.like]:k}},{identity_key:{[Op.like]:k}}];}
  const result=await M.InventoryFoundation.findAndCountAll({where,order:[['identity_key','ASC']],limit:size,offset:(page-1)*size,raw:true});
  const pageIds=new Set(result.rows.map(x=>x.basis_id)),pageRefs=refs.filter(x=>pageIds.has(x.basis_id));
  const saleIds=pageRefs.filter(x=>x.reference_key.startsWith('order_item:')).map(x=>x.reference_key.slice(11));
  const items=saleIds.length?await M.OrderItem.findAll({where:{item_id:saleIds},attributes:['item_id','order_id'],raw:true}):[];
  const orders=items.length?await M.Order.findAll({where:{order_id:items.map(x=>x.order_id)},attributes:['order_id','order_no'],raw:true}):[];
  const orderNames=new Map(orders.map(x=>[x.order_id,x.order_no])),names=new Map(items.map(x=>['order_item:'+x.item_id,'订单 '+orderNames.get(x.order_id)]));
  const current = new Map((await F.currentCatalog(result.rows)).map(x=>[x.basisId,x]));
  ctx.body={code:0,data:{list:result.rows.map(r=>({...current.get(r.basis_id),productName:r.product_name,entityType:r.entity_type,
    references:pageRefs.filter(x=>x.basis_id===r.basis_id).map(x=>({referenceKey:x.reference_key,storeId:x.store_id,
      label:names.get(x.reference_key)||(x.reference_key.startsWith('sn_current:')?'当前SN库存':'导入库存批次')}))})),total:result.count,page,pageSize:size}};
}
async function update(ctx){const stores=await scope(ctx);await M.sequelize.transaction(async transaction=>{
  await authorized(ctx,ctx.params.basisId,stores,transaction,true);
  ctx.body={code:0,data:await F.update(ctx.params.basisId,ctx.request.body||{},ctx.state.user,transaction)};
});}
async function history(ctx){const stores=await scope(ctx);await authorized(ctx,ctx.params.basisId,stores);
  ctx.body={code:0,data:await require('../../utils/businessActionLog').listBusinessActions('inventory_foundation',ctx.params.basisId)};
}
// Explicit rebinding solves an identified imported batch; never accept a
// same-product guess. Move all references only after proving same physical batch.
async function link(ctx){const stores=await scope(ctx),b=ctx.request.body||{};
  if(!b.referenceKey||!b.sourceBasisId||!b.targetBasisId||!String(b.reason||'').trim())ctx.throw(400,'请选择关联记录并填写批次依据');
  await M.sequelize.transaction(async transaction=>{const opts={transaction,lock:transaction.LOCK.UPDATE};
    const ref=await M.InventoryFoundationRef.findByPk(b.referenceKey,opts);if(!ref||!stores.includes(ref.store_id))ctx.throw(404,'关联记录不存在或无权操作');
    if(ref.basis_id!==b.sourceBasisId)ctx.throw(409,'关联已变化，请刷新后重试');
    await authorized(ctx,ref.basis_id,stores,transaction,true);await authorized(ctx,b.targetBasisId,stores,transaction,true);
    const source=await M.InventoryFoundation.findByPk(ref.basis_id,opts),target=await M.InventoryFoundation.findByPk(b.targetBasisId,opts);
    if(source.product_id!==target.product_id)ctx.throw(409,'不同商品不能关联同一基础档案');
    if(source.entity_type==='sn_cycle'||target.entity_type==='sn_cycle')ctx.throw(409,'SN周期由库存事实确定，不能手工跨周期关联');
    if(Number(b.sourceRevision)!==Number(source.revision)||Number(b.targetRevision)!==Number(target.revision))ctx.throw(409,'基础资料已变化，请刷新');
    const before=ref.toJSON();await ref.update({basis_id:target.basis_id},{transaction});
    await require('../../utils/businessActionLog').recordBusinessAction({businessType:'inventory_foundation',businessId:target.basis_id,action:'link_imported_reference',user:ctx.state.user,comment:b.reason,detail:{before,after:ref.toJSON(),note:'只修改明确批次关联，历史金额不自动重算'},transaction});
    ctx.body={code:0,data:{referenceKey:b.referenceKey,basisId:target.basis_id}};
  });
}
module.exports={list,update,history,link};
