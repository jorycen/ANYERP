const M=require('../../models'),F=require('./foundation'),P=require('./foundationMigration'),R=require('../report/inventoryReview'),E=require('../report/inventoryEvidence'),{Op}=require('sequelize'),fs=require('fs'),path=require('path'),X=require('xlsx'),a=require('assert/strict');
const {recordBusinessAction}=require('../../utils/businessActionLog');
async function run(options={}){const apply=options.apply??process.argv.includes('--apply'),dir=path.resolve(__dirname,'../../../backup/inventory-foundation-20261105');if(!options.startup)fs.mkdirSync(dir,{recursive:true});
  const plan=await M.sequelize.transaction({isolationLevel:'REPEATABLE READ',readOnly:true},async transaction=>{
  const at=new Date();
  const [products,prices,sns,inventory,cycles,orders,reviews]=await Promise.all([
    M.Product.findAll({raw:true,transaction}),M.ProductPrice.findAll({where:{status:1,[Op.or]:[{effective_time:{[Op.lte]:at}},{effective_time:null}]},order:[['effective_time','DESC'],['price_id','DESC']],raw:true,transaction}),M.ProductSn.findAll({where:{is_deleted:0},raw:true,transaction}),
    M.Inventory.findAll({raw:true,transaction}),M.SnLog.findAll({where:{action:'stock_cycle_reentry'},raw:true,transaction}),
    M.Order.findAll({where:{is_deleted:0,create_time:{[Op.gte]:new Date('2026-10-01T00:00:00+08:00'),[Op.lt]:new Date('2026-12-01T00:00:00+08:00')}},raw:true,transaction}),R.load(transaction)]);
  const [items,snapshots,stores,zeroSnIds,evidence]=await Promise.all([
    M.OrderItem.findAll({where:{order_id:orders.map(x=>x.order_id)},raw:true,transaction}),M.OrderGrossProfit.findAll({where:{order_id:orders.map(x=>x.order_id)},raw:true,transaction}),
    M.Store.findAll({raw:true,transaction}),require('../../utils/costKnowledge').confirmedZeroSnIds(sns,transaction),E.loadEvidence(M.sequelize,products.map(x=>x.product_id),transaction,at)]);
  const sm=new Map(stores.map(x=>[x.store_id,x])),snEvidence=new Map();
  for(const sn of sns){const e=E.resolveSnEvidence(sn,evidence.receipts,sm.get(sn.store_id)?.distributor_id,evidence.invoices,at);if(e.status==='linked')snEvidence.set(sn.sn_id,e);}
  const locations=await M.Location.findAll({raw:true,transaction});
  return P.plan({products,prices,sns,inventory,cycles,orders,items,snapshots,reviews,zeroSnIds,snEvidence,locations});
  });
  if(!options.startup)fs.writeFileSync(path.join(dir,'migration-preview.json'),JSON.stringify(plan,null,2));
  if(!options.startup){
    const catalog=new Map((await F.currentCatalog(plan.rows)).map(row=>[row.basisId,row]));
    const w=X.utils.book_new();for(const[name,rows]of [['汇总',[plan.counts]],['待核对',plan.conflicts],['基础档案',plan.rows.map(x=>({基础标识:x.basis_id,商品:x.product_name,SN:x.sn_code||'',批次:x.batch_no||'',状态:x.status,采购凭证类型:x.invoice_type||'',实际采购成本:x.purchase_cost,当前计价方式:catalog.get(x.basis_id)?.costMode,当前公司定价:catalog.get(x.basis_id)?.companyPrice,关联数:x.references.length,原因:x.reason}))]])X.utils.book_append_sheet(w,X.utils.json_to_sheet(rows),name);
    X.writeFile(w,path.join(dir,'统一库存基础资料迁移预览.xlsx'));}
  if(apply){if(!options.schemaReady)await require('../../utils/dbMigration').ensureInventoryFoundationSchema({skipBootstrap:true});let created=0,existing=0;
    for(let offset=0;offset<plan.rows.length;offset+=200)await M.sequelize.transaction(async transaction=>{
      const rows=plan.rows.slice(offset,offset+200),found=await M.InventoryFoundation.findAll({where:{basis_id:rows.map(x=>x.basis_id)},raw:true,transaction,lock:transaction.LOCK.UPDATE}),known=new Map(found.map(x=>[x.basis_id,x]));
      const inserted=[];for(const r of rows){if(known.has(r.basis_id)){a.equal(known.get(r.basis_id).identity_key,r.identity_key);existing++;continue;}
        const {candidates,references,identityConflict,...data}=r;inserted.push({...data,updated_by:'migration'});created++;
      }if(inserted.length)await M.InventoryFoundation.bulkCreate(inserted,{transaction});
      const refs=rows.flatMap(x=>x.references),foundRefs=await M.InventoryFoundationRef.findAll({where:{reference_key:refs.map(x=>x.reference_key)},raw:true,transaction,lock:transaction.LOCK.UPDATE}),kr=new Map(foundRefs.map(x=>[x.reference_key,x]));
      const insertedRefs=[];for(const ref of refs){if(kr.has(ref.reference_key)){a.equal(kr.get(ref.reference_key).basis_id,ref.basis_id,'已关联其他档案，禁止覆盖');continue;}insertedRefs.push(ref);}if(insertedRefs.length)await M.InventoryFoundationRef.bulkCreate(insertedRefs,{transaction});
      await recordBusinessAction({businessType:'inventory_foundation_migration',businessId:'20261105-'+offset,action:'migrate_foundation',user:{name:'用户授权（Codex会话）'},comment:'导入库存/十月十一月已售基础资料统一，仅建档及关联，不改历史金额',detail:{offset,createdIds:rows.filter(x=>!known.has(x.basis_id)).map(x=>x.basis_id),references:refs},transaction});
    });
    const refs=await M.InventoryFoundationRef.findAll({where:{reference_key:{[Op.in]:plan.rows.flatMap(x=>x.references.map(r=>r.reference_key))}},raw:true});a.equal(refs.length,plan.counts.references);
    if(!options.startup)fs.writeFileSync(path.join(dir,'migration-result.json'),JSON.stringify({created,existing,verifiedReferences:refs.length,counts:plan.counts},null,2));
    if(!options.startup&&!await M.BusinessActionLog.findOne({where:{business_type:'inventory_foundation_migration',business_id:'bootstrap-v1',action:'bootstrap_completed'}})){
      await recordBusinessAction({businessType:'inventory_foundation_migration',businessId:'bootstrap-v1',action:'bootstrap_completed',user:{name:'用户授权（Codex会话）'},comment:'统一基础资料手动迁移并验证完成',detail:{created,existing,verifiedReferences:refs.length}});
    }
  }
  console.log(JSON.stringify({apply,counts:plan.counts,conflicts:plan.conflicts.length,dir}));
  return plan.counts;
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
module.exports={run};
