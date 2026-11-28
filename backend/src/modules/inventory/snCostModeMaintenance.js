const M=require('../../models'),{normalizeSnCode}=require('../../utils/snCode');
const {recordBusinessAction}=require('../../utils/businessActionLog');
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const parse=x=>typeof x==='string'?JSON.parse(x):x||{};
const modes={'按公司定价':'COMPANY_PRICE','按采购价':'PURCHASE_PRICE',COMPANY_PRICE:'COMPANY_PRICE',PURCHASE_PRICE:'PURCHASE_PRICE'};
async function inspect(snCode,mode,transaction){
 const rows=await M.ProductSn.findAll({where:{sn_code:normalizeSnCode(snCode),is_deleted:0},transaction,lock:transaction?.LOCK?.UPDATE});
 if(rows.length!==1)fail('SN不存在或不唯一');const sn=rows[0];
 if(sn.status!=='in_stock')fail('SN不在库，不能调整计价方式');
 if(!modes[mode])fail('计价方式须为按公司定价或按采购价');
 const ref=await M.InventoryFoundationRef.findByPk('sn_current:'+sn.sn_id,{transaction,lock:transaction?.LOCK?.UPDATE});
 const basis=ref&&await M.InventoryFoundation.findByPk(ref.basis_id,{transaction,lock:transaction?.LOCK?.UPDATE});
 if(!basis||basis.product_id!==sn.product_id)fail('当前SN基础档案缺失或商品关联不一致，请先核实');
 const target=modes[mode];
 if(target==='COMPANY_PRICE'){
  const price=await M.ProductPrice.findOne({where:{product_id:sn.product_id,status:1},order:[['effective_time','DESC'],['price_id','DESC']],transaction});
  if(price?.standard_price==null||!Number.isFinite(Number(price.standard_price))||Number(price.standard_price)<0)fail('缺少有效公司定价');
 }else if(basis.purchase_cost==null||!Number.isFinite(Number(basis.purchase_cost))||Number(basis.purchase_cost)<0)fail('采购成本尚未确认');
 return {sn,basis,target};
}
async function validate(ctx,rows,transaction,assertVisible){
 const validRows=[],errors=[],seen=new Set();
 for(const [i,row]of rows.entries())try{
  const code=normalizeSnCode(row.SN||row.sn||row.snCode||''),mode=row['计价方式']||row['调整后计价方式']||row.costMode,reason=String(row['调整原因']||row['备注']||'').trim();
  if(!code)fail('请填写SN');if(seen.has(code))fail('文件内SN重复');seen.add(code);if(!reason)fail('请填写调整原因');
  const {sn,basis,target}=await inspect(code,mode,transaction);assertVisible(ctx,sn.store_id);
  const store=await M.Store.findByPk(sn.store_id,{transaction}),product=await M.Product.findByPk(sn.product_id,{transaction});
  if(!store||Number(store.is_deleted)||Number(store.status)!==1)fail('门店已停用');
  validRows.push({rowNo:i+2,operationType:'COST_MODE',sn,snCode:sn.sn_code,product,store,location:{location_id:sn.location_id},inventoryType:sn.inventory_type,quantity:1,unitPrice:0,originalPickupPrice:0,resourceTypes:[],triggerResourceRights:false,remark:reason,pnCode:sn.pn_code,raw:{...row,_costMode:{target,basisId:basis.basis_id,revision:Number(basis.revision),before:basis.cost_mode,reason}}});
 }catch(e){errors.push({rowNo:i+2,message:e.message,raw:row});}
 return {validRows,errors};
}
async function execute(item,application,transaction){
 const draft=parse(item.raw_json)._costMode;if(!draft)fail('计价方式申请数据缺失');
 const {sn,basis,target}=await inspect(item.sn_code,draft.target,transaction);
 if(sn.sn_id!==item.sn_id||sn.store_id!==item.store_id||sn.product_id!==item.product_id||String(sn.location_id||'')!==String(item.location_id||''))fail('SN归属或库位已变化，请重新申请');
 if(basis.basis_id!==draft.basisId||Number(basis.revision)!==draft.revision||basis.cost_mode!==draft.before)fail('基础档案已变化，请重新申请');
 const source=parse(basis.source_data),before=basis.cost_mode;
 await basis.update({cost_mode:target,revision:Number(basis.revision)+1,source_data:JSON.stringify({...source,pricingModeOverride:true}),update_time:new Date()},{transaction});
 await recordBusinessAction({businessType:'inventory_foundation',businessId:basis.basis_id,businessNo:application.application_no,action:'batch_sn_cost_mode',user:{staffId:application.reviewer_staff_id,name:application.reviewer_name},comment:draft.reason,detail:{sn:sn.sn_code,before,after:target,applicationId:application.application_id},transaction});
 await item.update({before_qty:1,after_qty:1,execute_status:'success',execute_error:null,execute_time:new Date(),result_json:JSON.stringify({snId:sn.sn_id,beforeCostMode:before,afterCostMode:target})},{transaction});
}
module.exports={validate,execute,inspect};
