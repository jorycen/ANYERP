const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const XLSX=require('xlsx');
const M=require('../src/models');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const {summarize}=require('../src/modules/inventory/receiptProgress');
const dir=path.resolve(__dirname,'../backup/partial-inbound-repair');
async function run(){
  fs.mkdirSync(dir,{recursive:true});
  const no='IN202610310609139625';
  const result=await M.sequelize.transaction(async transaction=>{
    const inbound=await M.Inbound.findOne({where:{inbound_no:no},transaction,lock:transaction.LOCK.UPDATE});
    const items=await M.InboundItem.findAll({where:{inbound_id:inbound.inbound_id},transaction,lock:transaction.LOCK.UPDATE,raw:true});
    const links=await M.InboundItemSn.findAll({where:{inbound_id:inbound.inbound_id},transaction,raw:true});
    const progress=summarize(items);
    assert.equal(progress.expectedQuantity,5);assert.equal(progress.receivedQuantity,3);assert.equal(progress.remainingQuantity,2);
    assert.equal(items.length,1);assert.equal(links.length,3);
    assert.deepEqual(JSON.parse(items[0].received_sn_codes).sort(),links.map(row=>row.sn_code).sort());
    const inventory=await M.Inventory.findAll({where:{product_id:items[0].product_id,store_id:inbound.store_id},transaction,raw:true});
    if(inbound.status==='pending')return {alreadyRestored:true,no,...progress};
    assert.equal(inbound.status,'completed');
    const backup=path.join(dir,`${no}.json`);
    fs.writeFileSync(backup,JSON.stringify({inbound:inbound.toJSON(),items,links,inventory},null,2),{flag:'wx'});
    await inbound.update({status:'pending',update_time:new Date()},{transaction});
    await recordBusinessAction({businessType:'inbound',businessId:inbound.inbound_id,businessNo:no,action:'restore_partial_receipt',
      fromStatus:'completed',toStatus:'pending',user:{name:'User confirmation via Codex chat'},transaction,
      comment:'修正部分收货误完成，保留3台已入库和2台待入库，不增减库存',detail:progress});
    // Import the existing verified receipt as history; this is not another stock receipt.
    await M.BusinessActionLog.create({log_id:require('crypto').randomUUID().replaceAll('-',''),business_type:'inbound',business_id:inbound.inbound_id,
      business_no:no,action:'receipt_batch',actor_name:items[0].receive_user,create_time:items[0].receive_time,comment:'verified_historical_receipt',
      detail_json:JSON.stringify({historicalImport:true,items:links.map(row=>({snCode:row.sn_code,quantity:1})),response:{code:0,data:progress}})},{transaction});
    assert.deepEqual(await M.Inventory.findAll({where:{product_id:items[0].product_id,store_id:inbound.store_id},transaction,raw:true}),inventory);
    return {no,status:inbound.status,...progress};
  });
  const fresh=await M.Inbound.findOne({where:{inbound_no:no},raw:true});assert.equal(fresh.status,'pending');
  fs.writeFileSync(path.join(dir,'repair-result.json'),JSON.stringify(result,null,2));
  const candidates=JSON.parse(fs.readFileSync(path.join(dir,'candidates.json'),'utf8'));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(candidates.map(row=>({...row,result:row.no===no?'已核实恢复部分入库':'待核实历史实际收货及已结算影响，未自动修改'}))),'历史核查');
  XLSX.writeFile(wb,path.join(dir,'部分入库历史核查.xlsx'));
  console.log(JSON.stringify(result));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
