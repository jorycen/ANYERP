// User-authorized one-off repair. Default is preview; execution requires the saved plan hash.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const config = require('../src/config').database;
const { audit } = require('./audit-zero-inventory-cost');
const { fifoRemainingAverageCost, remainingCostLayersSql } = require('../src/utils/inventoryCostLayers');
const dir = path.resolve(__dirname, '../../backup/zero-cost-average-repair-20261027');
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const uid = () => crypto.randomUUID().replace(/-/g, '');
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function csv(name, headers, rows) {
  const quote = v => '"'+String(v??'').replace(/"/g,'""')+'"';
  const file = path.join(dir,name+'.csv');
  fs.writeFileSync(file,'\uFEFF'+[headers,...rows].map(row=>row.map(quote).join(',')).join('\r\n')); return file;
}
function classify(row, batches = [], layers = null) {
  if (Number(row.COST_PRICE_LOCKED) === 1) return { decision:'LOCKED' };
  const receipts=row.inbounds.filter(i=>i.SOURCE_TYPE==='purchase' && ['completed','executed'].includes(i.STATUS) && Number(i.RECEIVED_QUANTITY)>0);
  const prices=[...new Set(receipts.map(i=>Number(i.UNIT_PRICE)))];
  if (row.classification === 'SN_MASTER_REFRESH_CANDIDATE') {
    if (row.sns.some(sn=>sn.STATUS && sn.STATUS !== 'in_stock')) return { decision:'SN_STATUS_REVIEW' };
    return { decision:'REPAIR', cost:row.proposedCost, basis:'CURRENT_SN_COMPLETE' };
  }
  if (Number(row.NEED_SN) === 1 || row.sns.length || !row.PRICE_ID || row.stockQty<=0) return { decision:'REVIEW' };
  if (row.COST_PRICE !== null && Number(row.COST_PRICE)!==0) return { decision:'REVIEW' };
  if (row.conversions.some(c=>c.STATUS==='completed') || row.resources.length || row.priceLogs.some(l=>Number(l.NEW_PRICE)===0)) return { decision:'REVIEW' };
  if (layers) {
    const cost = fifoRemainingAverageCost(layers, row.stockQty, { requireComplete: true });
    if (cost === null) return { decision:'INSUFFICIENT_COVERAGE' };
    if (!Number.isFinite(cost) || cost <= 0) return { decision:'REVIEW' };
    return { decision:'REPAIR', cost, basis:'CURRENT_FIFO_REMAINING_AVERAGE', prices };
  }
  if (prices.length!==1 || !Number.isFinite(prices[0]) || prices[0]<=0) return { decision:'REVIEW' };
  const cost=prices[0];
  if (batches.some(b=>!Number.isFinite(Number(b.UNIT_PRICE)) || Number(b.UNIT_PRICE)<=0 || Number(b.UNIT_PRICE)!==cost)) return { decision:'SOURCE_CONFLICT', prices };
  if (row.inbounds.some(i=>['GIFT','SALES_COMPONENT_RECOVERY'].includes(i.SOURCE_TYPE) && ['completed','executed'].includes(i.STATUS))) return { decision:'REVIEW' };
  const coverage=receipts.reduce((n,i)=>n+Math.max(0,Math.min(Number(i.QUANTITY),Number(i.RECEIVED_QUANTITY))),0)
    + batches.reduce((n,b)=>n+Math.max(0,Number(b.QUANTITY)),0);
  if (coverage<row.stockQty) return { decision:'INSUFFICIENT_COVERAGE', cost, coverage };
  return { decision:'REPAIR', cost:round(cost), basis:'SINGLE_RECEIVED_PURCHASE_PRICE', coverage };
}
function realZero(row, sn) {
  if (sn.INBOUND_PRICE===null || Number(sn.INBOUND_PRICE)!==0) return null;
  const sources=row.conversions.filter(c=>c.STATUS==='completed' && c.CONVERSION_TYPE==='split' && c.LINE_ROLE==='source'
    && String(c.SN_ID)===String(sn.SN_ID) && round(Number(c.TOTAL_SOURCE_COST)-Number(c.TOTAL_TARGET_COST))===0);
  const latest=sources.sort((a,b)=>new Date(b.CREATE_TIME)-new Date(a.CREATE_TIME))[0];
  if (!latest || (sn.INBOUND_TIME && new Date(sn.INBOUND_TIME)>new Date(latest.CREATE_TIME))) return null;
  return { reason:'已完成拆分单证明剩余成本为0', sourceNo:latest.CONVERSION_NO };
}
async function snapshot(db) {
  const result=await audit(db);
  const ids=result.rows.map(r=>r.PRODUCT_ID);
  const [batches]=ids.length ? await db.query(`SELECT item.PRODUCT_ID,item.ITEM_ID,item.UNIT_PRICE,item.QUANTITY,app.APPLICATION_NO,app.STATUS
    FROM T_INVENTORY_BATCH_APPLICATION_ITEM item JOIN T_INVENTORY_BATCH_APPLICATION app ON app.APPLICATION_ID=item.APPLICATION_ID
    WHERE item.PRODUCT_ID IN (?) AND app.STATUS='executed' AND item.OPERATION_TYPE='INBOUND' AND COALESCE(item.NEED_SN,0)=0`,[ids]) : [[]];
  const layersByProduct = {};
  for (const row of result.rows) {
    if (Number(row.NEED_SN) !== 1 && !row.sns.length) {
      const [layers] = await db.query(remainingCostLayersSql, [row.PRODUCT_ID,row.PRODUCT_ID]);
      layersByProduct[row.PRODUCT_ID] = layers;
    }
  }
  return { ...result, batches, layersByProduct };
}
function planFrom(data) {
  const rows=data.rows.map(r=>{
    const batches=data.batches.filter(b=>b.PRODUCT_ID===r.PRODUCT_ID);
    const layers=data.layersByProduct?.[r.PRODUCT_ID] ?? null;
    const assessment=classify(r,batches,layers);
    return { productId:r.PRODUCT_ID, productCode:r.PRODUCT_CODE, pn:r.MANUFACTURER_CODE, name:r.NAME,
      priceId:r.PRICE_ID, before:r.COST_PRICE, stockQty:r.stockQty, ...assessment, fingerprint:hash({row:r,batches,layers}) };
  });
  const plan={version:1,createdAt:new Date().toISOString(),rows};
  return { ...plan, hash:hash(plan) };
}
function exportLists(data,plan,resultRows=null) {
  const multi=[],locked=[],zero=[],unknown=[];
  for (const row of data.rows) {
    const rec=plan.rows.find(p=>p.productId===row.PRODUCT_ID);
    const base=[row.PRODUCT_CODE,row.MANUFACTURER_CODE,row.NAME,row.COST_PRICE,row.stockQty];
    if(Number(row.COST_PRICE_LOCKED)===1) locked.push([...base,'人工锁定，未修改',row.priceLogs.map(l=>`${l.NEW_PRICE}:${l.CHANGE_REASON||l.SOURCE}`).join('；')]);
    const receipts=row.inbounds.filter(i=>i.SOURCE_TYPE==='purchase'&&['completed','executed'].includes(i.STATUS)&&Number(i.RECEIVED_QUANTITY)>0);
    const prices=[...new Set(receipts.map(i=>i.UNIT_PRICE))];
    if(prices.length>1) multi.push([...base,prices.join(' / '),receipts.map(i=>`${i.INBOUND_NO}:${i.UNIT_PRICE}×${i.RECEIVED_QUANTITY}`).join('；'),rec.decision,rec.cost??'',resultRows?.find(r=>r.productId===row.PRODUCT_ID)?.status??'未执行']);
    for(const sn of row.sns.filter(s=>s.INBOUND_PRICE===null||Number(s.INBOUND_PRICE)===0)) {
      const proof=realZero(row,sn);
      const line=[row.PRODUCT_CODE,row.MANUFACTURER_CODE,row.NAME,sn.STORE_NAME,sn.SN_CODE,sn.INBOUND_PRICE,sn.ORIGINAL_PICKUP_PRICE];
      if(proof) zero.push([...line,proof.reason,proof.sourceNo]);
      else unknown.push([...line,'当前为0或缺失，但没有足够来源证明是真实0成本','待核对，不修改']);
    }
  }
  const common=['商品编码','PN','商品名称','当前商品成本','库存数量'];
  const files={
    multi:csv('多采购价_平均成本核对',[...common,'已验收采购价','依据入库单','核对结论','在库平均成本','执行结果'],multi),
    locked:csv('人工锁定_未修改',[...common,'处理','已知价格日志'],locked),
    zero:csv('有明确来源的真实零成本_未修改',['商品编码','PN','商品名称','门店','SN','当前SN成本','原提货价','零成本依据','来源单号'],zero),
    unknown:csv('零成本待核对_未修改',['商品编码','PN','商品名称','门店','SN','当前SN成本','原提货价','待核对原因','处理'],unknown),
    review:csv('其他来源不足或冲突_未修改',[...common,'待核对原因'],plan.rows.filter(r=>!['REPAIR','MULTIPLE_PRICES','LOCKED'].includes(r.decision)).map(r=>[r.productCode,r.pn,r.name,r.before,r.stockQty,r.decision]))
  };
  if(resultRows) files.repaired=csv('明确来源_修复结果',['商品编码','PN','商品名称','原商品成本','修复后成本','库存数量','成本依据','结果'],resultRows.map(r=>[r.productCode,r.pn,r.name,r.before,r.cost,r.stockQty,r.basis,r.status]));
  return {files,counts:{multiProducts:multi.length,lockedProducts:locked.length,provenZeroSns:zero.length,unprovenZeroSns:unknown.length}};
}
async function main() {
  fs.mkdirSync(dir,{recursive:true});
  const args=process.argv.slice(2),execute=args.includes('--execute');
  const planFile=path.join(dir,'preview-plan.json');
  const db=await mysql.createConnection({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database,connectTimeout:10000,timezone:'+08:00'});
  let committed=false;
  try {
    if(!execute) {
      await db.query('SET TRANSACTION READ ONLY');await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      const data=await snapshot(db);await db.rollback();const plan=planFrom(data);
      fs.writeFileSync(planFile,JSON.stringify(plan,null,2));fs.writeFileSync(path.join(dir,'preview-evidence.json'),JSON.stringify(data,null,2));
      const lists=exportLists(data,plan),repairs=plan.rows.filter(r=>r.decision==='REPAIR');
      console.log(JSON.stringify({mode:'preview',planFile,hash:plan.hash,repairCount:repairs.length,snBasis:repairs.filter(r=>r.basis==='CURRENT_SN_COMPLETE').length,fifoBasis:repairs.filter(r=>r.basis==='CURRENT_FIFO_REMAINING_AVERAGE').length,...lists,sample:repairs.find(r=>String(r.pn).includes('GL62M7RDX'))},null,2));return;
    }
    const plan=JSON.parse(fs.readFileSync(planFile,'utf8')),expected=args[args.indexOf('--expected-hash')+1];
    const {hash:planHash,...unsigned}=plan;
    if(!args.includes('--expected-hash')||expected!==planHash||hash(unsigned)!==planHash) throw new Error('预览哈希缺失或不一致，禁止执行');
    const targets=plan.rows.filter(r=>r.decision==='REPAIR');if(!targets.length) throw new Error('没有已确认范围内的可修复记录');
    const ids=targets.map(r=>r.productId);
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await db.beginTransaction();
    const [beforePrices]=await db.query('SELECT * FROM T_PRODUCT_PRICE WHERE PRODUCT_ID IN (?) FOR UPDATE',[ids]);
    await db.query('SELECT INVENTORY_ID FROM T_INVENTORY WHERE PRODUCT_ID IN (?) FOR UPDATE',[ids]);
    await db.query('SELECT SN_ID FROM T_PRODUCT_SN WHERE PRODUCT_ID IN (?) FOR UPDATE',[ids]);
    const current=await snapshot(db),rechecked=planFrom(current),batchNo='ICR20261027-'+uid().slice(0,8);
    const backup={batchNo,planHash,authorization:'用户确认优化：多采购价按已有在库平均成本逻辑刷新，保护人工锁定及来源不足记录',beforePrices,evidence:current};
    const backupFile=path.join(dir,batchNo+'-before.json');fs.writeFileSync(backupFile,JSON.stringify(backup,null,2));
    const results=[];
    for(const original of targets) {
      const now=rechecked.rows.find(r=>r.productId===original.productId);
      if(!now||now.decision!=='REPAIR'||now.fingerprint!==original.fingerprint||now.cost!==original.cost) {results.push({...original,status:'SKIPPED_SOURCE_CHANGED'});continue;}
      const [updated]=await db.execute('UPDATE T_PRODUCT_PRICE SET COST_PRICE=? WHERE PRICE_ID=? AND PRODUCT_ID=? AND COALESCE(COST_PRICE_LOCKED,0)=0 AND (COST_PRICE=0 OR COST_PRICE IS NULL)',[now.cost,now.priceId,now.productId]);
      if(updated.affectedRows!==1) throw new Error('条件更新失败，整批回滚：'+now.productCode);
      await db.execute(`INSERT INTO T_PRODUCT_PRICE_CHANGE_LOG (CHANGE_ID,BATCH_NO,ROW_NO,PRODUCT_ID,PRODUCT_CODE,PRODUCT_NAME,MANUFACTURER_CODE,PRICE_FIELD,OLD_PRICE,NEW_PRICE,EFFECTIVE_TIME,SOURCE,CHANGE_REASON,STATUS,CREATE_USER,CREATE_TIME,APPLIED_TIME)
        VALUES (?,?,?,?,?,?,?,'cost_price',?,?,NOW(3),'cost_repair',?,'applied',?,NOW(3),NOW(3))`,[uid(),batchNo,results.length+1,now.productId,now.productCode,now.name,now.pn,now.before,now.cost,'用户确认的明确来源库存成本补齐；依据:'+now.basis,'Codex（用户授权）']);
      await db.execute(`INSERT INTO T_BUSINESS_ACTION_LOG (LOG_ID,BUSINESS_TYPE,BUSINESS_ID,BUSINESS_NO,ACTION,ACTOR_NAME,COMMENT,DETAIL_JSON,CREATE_TIME)
        VALUES (?,'inventory_cost_repair',?,?,'refresh_evidenced_zero_cost',?,?,?,NOW(3))`,[uid(),now.productId,batchNo,'Codex（用户授权）','仅补商品成本；不改SN、采购、结算定价、数量或历史毛利',JSON.stringify({beforeCost:now.before,afterCost:now.cost,basis:now.basis,planHash,sourceFingerprint:now.fingerprint,backupFile})]);
      results.push({...now,status:'UPDATED'});
    }
    const [afterPrices]=await db.query('SELECT * FROM T_PRODUCT_PRICE WHERE PRODUCT_ID IN (?)',[ids]);
    for(const before of beforePrices) {
      const after=afterPrices.find(r=>r.PRICE_ID===before.PRICE_ID);if(!after)throw new Error('修复后价格记录丢失');
      for(const field of Object.keys(before).filter(k=>k!=='COST_PRICE')) if(hash(before[field])!==hash(after[field])) throw new Error('非目标字段变化，回滚：'+field);
      const result=results.find(r=>r.priceId===before.PRICE_ID&&r.status==='UPDATED');
      if(result&&round(after.COST_PRICE)!==result.cost)throw new Error('修复后成本核对失败');
    }
    const report={batchNo,planHash,backupFile,status:'pending_commit',results,afterPrices};
    const reportFile=path.join(dir,batchNo+'-result.json');fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
    await db.commit();committed=true;report.status='committed';fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
    const lists=exportLists(current,rechecked,results);
    console.log(JSON.stringify({mode:'execute',batchNo,reportFile,backupFile,updated:results.filter(r=>r.status==='UPDATED').length,skipped:results.filter(r=>r.status!=='UPDATED').length,...lists,sample:results.find(r=>String(r.pn).includes('GL62M7RDX'))},null,2));
  }catch(error){if(!committed)await db.rollback();else console.error('数据库已提交，结果文件后处理异常');throw error;}finally{await db.end();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.name,error.message);process.exitCode=1});
module.exports={classify,realZero,hash,planFrom};
