// Explicitly authorized historical freight correction; defaults to a rollback-only preview.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || [];
const cents = value => Math.round(Number(value || 0) * 100);
const round = GP.roundMoney;
const frozenProfit = (snapshot, order) => {
  const value = GP.snapshotToResponse(snapshot, order);
  return round(value.grossProfitBeforeExternalAdjustment - value.externalAdjustmentFee);
};
const batch = 'FREIGHT-20261102-OCTOBER';
const dir = path.resolve(__dirname, '../backup/freight-corrections', batch);
const auditPath = path.resolve(__dirname, '../backup/october-external-pricing-audit/audit.json');

async function inspect(orderNo, transaction) {
  const order = await M.Order.findOne({ where: { order_no: orderNo }, transaction, lock: transaction.LOCK.UPDATE });
  assert(order && !order.is_deleted && ['已归档','archived','completed'].includes(order.order_status), '订单状态已变化');
  assert(order.archive_time, '缺少归档时间');
  const store = await M.Store.findByPk(order.store_id, { transaction });
  const period = await M.ExpenseAccountingPeriod.findOne({ where: { distributor_id: store.distributor_id, month_key: '2026-10' }, transaction, lock: transaction.LOCK.UPDATE });
  assert(!period || period.status === 'open', '10月已锁定');
  for (const [model, where] of [[M.SalesReturnRequest,{order_id:order.order_id}],
    [M.SalesReturnGrossProfitLedger,{order_id:order.order_id}],
    [M.SalesSettlementCostAdjustment,{sales_order_id:order.order_id}]]) {
    assert.equal(await model.count({where,transaction}),0, '存在退货或其他调整，需单独核对');
  }
  const adjustments = await M.PerformanceProfitAdjustment.findAll({where:{order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE,raw:true});
  assert(adjustments.every(row=>row.status==='approved' && ['invoice_amount','increase','decrease'].includes(row.adjustment_type)
    && !/运费|物流|闪送/.test(row.reason||'')), '存在未完成或可能关联运费的调整');
  const snapshot = await M.OrderGrossProfit.findOne({ where: {order_id:order.order_id}, transaction, lock: transaction.LOCK.UPDATE });
  assert(snapshot && snapshot.snapshot_status === 'final', '缺少最终快照');
  const before = snapshot.toJSON();
  const supplements = parse(before.supplement_details);
  assert(!supplements.some(line => line.source !== 'freight_cost' && /运费|物流|闪送/.test(`${line.itemName || ''} ${line.content || ''}`) && Number(line.amount)>0), '已有手工运费');
  assert.equal(cents(frozenProfit(before, order)),cents(before.gross_profit_amount),'原快照公式不一致');
  const items = await M.OrderItem.findAll({where:{order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE});
  const available = await GP.buildFreightCostDetails(order.toJSON(),transaction,parse(before.product_pricing_details));
  const findings = JSON.parse(fs.readFileSync(auditPath,'utf8')).freight.filter(row=>row.订单===orderNo && row.状态!=='returned' && !row.判断.startsWith('已有'));
  const next = supplements.filter(line=>line.source==='freight_cost').map(line=>({...line}));
  const changes=[];
  for(const finding of findings){
    const item=items.find(row=>row.sn_code===finding.SN && row.product_name===finding.商品);
    assert(item,'无法唯一匹配原商品');
    assert.equal(items.filter(row=>row.sn_code===finding.SN && row.product_name===finding.商品).length,1,'重复商品匹配');
    const fresh=available.find(row=>String(row.itemId)===String(item.item_id));
    assert(fresh && fresh.sourceNo===finding.来源单号 && cents(fresh.amount)===cents(finding.来源运费),'实时运费来源与清单不一致');
    const previous=next.filter(line=>String(line.itemId)===String(item.item_id));
    const old=round(previous.reduce((sum,line)=>sum+Number(line.amount),0));
    assert.equal(cents(old),cents(finding.原自动运费),'运费已被其他操作修改');
    assert.equal(cents(item.freight_cost),cents(old),'明细运费与最终快照不一致');
    assert(fresh.amount>old,'运费无需增加');
    for(let index=next.length-1;index>=0;index--) if(String(next[index].itemId)===String(item.item_id)) next.splice(index,1);
    next.push({...fresh,correctionId:batch});
    changes.push({itemId:item.item_id,SN:item.sn_code,sourceNo:fresh.sourceNo,freightId:fresh.freightId,before:old,after:fresh.amount});
  }
  assert(changes.length,'无待纠正运费');
  const oldTotal=round(supplements.filter(row=>row.source==='freight_cost').reduce((sum,row)=>sum+Number(row.amount),0));
  assert.equal(cents(oldTotal),cents(before.freight_cost_amount),'运费总额不一致');
  const total=round(next.reduce((sum,row)=>sum+Number(row.amount),0));
  const details=[...supplements.filter(row=>row.source!=='freight_cost'),...next];
  const after={...before,freight_cost_amount:total,supplement_details:details};
  after.gross_profit_amount=frozenProfit(after,order);
  assert(Number.isFinite(after.gross_profit_amount),'毛利非有效金额');
  assert.equal(JSON.stringify(after.product_pricing_details),JSON.stringify(before.product_pricing_details));
  return {order,snapshot,items,before,after,changes,adjustments,summary:{订单号:orderNo,门店:store.name,原运费:oldTotal,更新后运费:total,补计运费:round(total-oldTotal),原毛利:Number(before.gross_profit_amount),更新后毛利:after.gross_profit_amount,保留原审批调整:adjustments.length}};
}

async function run(){
  fs.mkdirSync(dir,{recursive:true});
  const audit=JSON.parse(fs.readFileSync(auditPath,'utf8'));
  const orderNos=[...new Set(audit.freight.filter(row=>row.状态!=='returned'&&!row.判断.startsWith('已有')).map(row=>row.订单))].sort();
  const apply=process.argv.includes('--apply');
  const results=[],skipped=[];
  for(const orderNo of orderNos){
    const transaction=await M.sequelize.transaction();
    try{
      if(await M.BusinessActionLog.count({where:{business_no:orderNo,action:'correct_freight',comment:batch},transaction})){
        await transaction.rollback();skipped.push({订单号:orderNo,原因:'本批次已执行'});continue;
      }
      const plan=await inspect(orderNo,transaction);
      if(apply){
        const backup=path.join(dir,`${orderNo}.json`);
        assert(!fs.existsSync(backup),'备份已存在，需核对执行状态');
        fs.writeFileSync(backup,JSON.stringify({batch,order:plan.order.toJSON(),before:plan.before,items:plan.items.map(row=>row.toJSON()),after:plan.after,changes:plan.changes,adjustments:plan.adjustments},null,2),{flag:'wx'});
        await plan.snapshot.update({freight_cost_amount:plan.after.freight_cost_amount,supplement_details:plan.after.supplement_details,
          gross_profit_amount:plan.after.gross_profit_amount,calculated_by:batch,calculated_at:new Date(),update_time:new Date()},{transaction});
        for(const change of plan.changes)await M.OrderItem.update({freight_cost:change.after},{where:{item_id:change.itemId,order_id:plan.order.order_id},transaction});
        await M.BusinessActionLog.create({log_id:randomUUID().replaceAll('-',''),business_type:'sales_order',business_id:plan.order.order_id,
          business_no:orderNo,action:'correct_freight',actor_name:'User confirmation via Codex chat',comment:batch,
          detail_json:JSON.stringify({authorization:'用户要求先将运费直接更新',batch,...plan.summary,changes:plan.changes,pricingUnchanged:true})},{transaction});
        await transaction.commit();
      }else await transaction.rollback();
      results.push(plan.summary);
    }catch(error){if(!transaction.finished)await transaction.rollback();skipped.push({订单号:orderNo,原因:error.message});}
  }
  if(apply){
    for(const result of results){
      const order=await M.Order.findOne({where:{order_no:result.订单号},raw:true});
      const fresh=await M.OrderGrossProfit.findOne({where:{order_id:order.order_id},raw:true});
      assert.equal(cents(fresh.freight_cost_amount),cents(result.更新后运费));
      assert.equal(cents(fresh.gross_profit_amount),cents(result.更新后毛利));
      const backup=JSON.parse(fs.readFileSync(path.join(dir,`${result.订单号}.json`),'utf8'));
      for(const field of ['product_pricing_details','receivable_amount','product_pricing_amount','payment_fee_amount','vat_amount','supplement_amount','snapshot_status'])assert.deepEqual(fresh[field],backup.before[field],field);
      const items=await M.OrderItem.findAll({where:{order_id:order.order_id},raw:true});
      for(const change of backup.changes)assert.equal(cents(items.find(row=>String(row.item_id)===String(change.itemId)).freight_cost),cents(change.after));
      const adjustments=await M.PerformanceProfitAdjustment.findAll({where:{order_id:order.order_id},raw:true});
      assert.deepEqual(JSON.parse(JSON.stringify(adjustments.sort((a,b)=>a.adjustment_id.localeCompare(b.adjustment_id)))),backup.adjustments.sort((a,b)=>a.adjustment_id.localeCompare(b.adjustment_id)));
    }
  }
  const output={batch,mode:apply?'applied':'preview',count:results.length,skipped,addedFreight:round(results.reduce((sum,row)=>sum+row.补计运费,0)),profitChange:round(results.reduce((sum,row)=>sum+row.更新后毛利-row.原毛利,0)),results};
  fs.writeFileSync(path.join(dir,apply?'result.json':'preview.json'),JSON.stringify(output,null,2));
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(results),'运费更新明细');
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(skipped),'暂未更新');
  XLSX.writeFile(workbook,path.join(dir,apply?'10月运费更新结果.xlsx':'运费更新预览.xlsx'));
  console.log(JSON.stringify({...output,results:undefined}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
