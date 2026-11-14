const fs=require('fs'),path=require('path'),X=require('xlsx');
const M=require('../src/models'),V=require('../src/modules/report/inventoryReview'),R=require('../src/modules/report/inventoryReport');
const {recordBusinessAction}=require('../src/utils/businessActionLog'),{generateUUID}=require('../src/utils');
const source='C:/Users/Administrator/Downloads/库存核实回填表(3).xlsx';
const base=path.resolve(__dirname,'../backup/inventory-report-review/INV-REVIEW-20261103-068e94');
const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
const w=X.readFile(source),rows=n=>X.utils.sheet_to_json(w.Sheets[n],{defval:''});
const batch='INV-FILL-20261103-068e94',out=path.join(base,'applied');fs.mkdirSync(out,{recursive:true});
const result={batch,applied:[],skipped:[],before:[],errors:[]};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),str=v=>String(v??'');
function original(r,kind){const o=manifest.rows[r['行标识']];if(!o||o.kind!==kind)throw Error('Invalid original '+r['行标识']);const p=o.product||o.detail;
 if(str(r['商品编码'])!==str(p.product_code||p.productCode))throw Error('Changed product identity '+r['行标识']);
 if(o.detail&&r['门店']!==undefined&&str(r['门店'])!==str(o.detail.storeName))throw Error('Changed store identity');
 if(o.sn&&r.SN!==undefined&&str(r.SN)!==str(o.sn.sn_code))throw Error('Changed SN identity');return o;}
async function run(){
 const exists=await M.BusinessActionLog.count({where:{business_type:'inventory_review_batch',business_id:batch}});if(exists){console.log('Already applied; no writes');return;}
 const staff=await M.Staff.findByPk(3);if(!staff||staff.name!=='段超')throw Error('Actor mismatch');const user={staffId:3,name:staff.name};
 const before=await R.load({dimensions:'product'},{roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']});fs.writeFileSync(path.join(out,'report-before.json'),JSON.stringify(before));
 await M.sequelize.transaction(async transaction=>{
 const execute=process.argv.includes('--execute');
 const log=async(key,detail,action='valuation_confirmed',businessType='inventory_review')=>{if(execute)await recordBusinessAction({businessType,businessId:key,action,user,comment:'用户回填表及对话确认：真实零成本、专票统一13%，仅库存估值依据',detail:{batch,...detail},transaction});};
 const changedSns=new Set(),seen=new Set();
 for(const [sheet,kind] of [['SN成本','sn_cost'],['非SN成本','product_cost'],['实物属性','physical_scope']])for(const r of rows(sheet)){
  if(r['是否处理']!=='是')continue;const o=original(r,kind),key=r['行标识'];if(seen.has(key))throw Error('Duplicate '+key);seen.add(key);
  if(kind==='sn_cost'){
   const sn=await M.ProductSn.findByPk(o.sn.sn_id,{transaction,lock:transaction.LOCK.UPDATE});if(!sn||sn.status!=='in_stock'||Number(sn.is_deleted)||!same(V.snState(sn),V.snState({...o.sn,status:'in_stock'}))){result.skipped.push({key,reason:'SN状态或原值已变化'});continue;}
   const cost=Number(r['确认采购单价']);if(r['确认采购单价']===''||!Number.isFinite(cost)||cost<0||(cost===0&&r['确认真实零成本']!=='是'))throw Error('Invalid cost '+key);
   result.before.push({key,sn:sn.toJSON()});if(execute)await sn.update({inbound_price:cost},{transaction});
   await log(sn.sn_id,{before:o.sn,after:{inbound_price:cost},row:key},'sn_purchase_cost_corrected','sn');changedSns.add(sn.sn_id);
  }else{
   const p=await M.Product.findByPk(o.product.product_id,{transaction,lock:transaction.LOCK.UPDATE});if(!p||['product_code','name','need_sn','category','brand','unit'].some(k=>str(p[k])!==str(o.product[k]))){result.skipped.push({key,reason:'商品主档已变化'});continue;}
   if(kind==='physical_scope'){await log('scope:'+p.product_id,{scope:r['确认属性'],row:key});}
   else{
    const prices=await M.ProductPrice.findAll({where:{product_id:p.product_id,status:1},transaction,lock:transaction.LOCK.UPDATE});
    if(prices.length>1||prices.some(v=>{const old=o.prices.find(a=>a.price_id===v.price_id);return !old||Number(old.cost_price)!==Number(v.cost_price)||Number(old.cost_price_locked)!==Number(v.cost_price_locked);})){result.skipped.push({key,reason:'成本档案已变化或多条有效记录'});continue;}
    const cost=Number(r['确认采购单价']),zero=r['确认真实零成本']==='是'||r['商品编码']==='SP01383';if(r['确认采购单价']===''||!Number.isFinite(cost)||cost<0||(cost===0&&!zero))throw Error('Invalid cost '+key);
    result.before.push({key,prices:prices.map(v=>v.toJSON())});
    // Zero must be explicitly protected from automatic FIFO refresh; nonzero retains existing lock setting.
    const update={cost_price:cost,...(cost===0||r['是否锁定确认成本']==='是'?{cost_price_locked:1}:{})};
    if(execute){if(prices[0])await prices[0].update(update,{transaction});else await M.ProductPrice.create({price_id:generateUUID(),product_id:p.product_id,...update,status:1},{transaction});}
    await log('cost:'+p.product_id,{row:key,after:update},'cost_confirmed');
   }
  }result.applied.push({key,kind});
 }
 for(const [sheet,kind] of [['SN税务','sn_tax'],['非SN批次','non_sn_batch']])for(const r of rows(sheet)){
  if(!r['确认票种']||r['是否处理']==='否'||r['是否处理']==='暂不处理')continue;
  const o=original(r,kind),key=r['行标识'];if(seen.has(key))throw Error('Duplicate '+key);seen.add(key);
  const isSn=kind==='sn_tax',model=isSn?M.ProductSn:M.Inventory,id=isSn?o.sn.sn_id:o.inventory.inventory_id;
  const item=await model.findByPk(id,{transaction,lock:transaction.LOCK.UPDATE});
  let state=isSn?V.snState:V.inventoryState;let old=isSn?{...o.sn,status:'in_stock'}:o.inventory;
  if(!item||(isSn&&(item.status!=='in_stock'||Number(item.is_deleted)))||(!changedSns.has(id)&&!same(state(item),state(old)))){result.skipped.push({key,reason:'库存状态、数量或原值已变化'});continue;}
  const invoiceType=r['确认票种']==='增值税专用发票'?'专票13%':r['确认票种']==='收据'?'收据':r['确认票种']==='普通发票'?'普通发票':null;if(!invoiceType){result.skipped.push({key,reason:'票种待核对'});continue;}
  result.before.push({key,inventory:item.toJSON()});await log((isSn?'sn:'+id:'inventory:'+id+':'+o.detail.type),{row:key,invoiceType,signature:V.signature(state(item)),manualEstimateOnly:true});result.applied.push({key,kind,invoiceType});
 }
 fs.writeFileSync(path.join(out,execute?'execution.json':'preview.json'),JSON.stringify(result,null,2));
 if(execute){await log(batch,{counts:result.applied.reduce((a,r)=>(a[r.kind]=(a[r.kind]||0)+1,a),{})},'batch_completed','inventory_review_batch');}else throw Object.assign(Error('PREVIEW_ROLLBACK'),{preview:true});
 }).catch(e=>{if(!e.preview)throw e;});
 if(process.argv.includes('--execute')){const after=await R.load({dimensions:'product'},{roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']});fs.writeFileSync(path.join(out,'report-after.json'),JSON.stringify(after));}
 console.log(JSON.stringify({counts:result.applied.reduce((a,r)=>(a[r.kind]=(a[r.kind]||0)+1,a),{}),skipped:result.skipped.length,dir:out}));
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>M.sequelize.close());
