// Read-only inventory cost audit. No schema changes or business writes.
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../src/config').database;
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const key = value => String(value || '');
const qty = row => Math.max(Number(row.NORMAL_QTY || 0), Number(row.REGULAR_QTY || 0) + Number(row.SUBSIDY_QTY || 0) + Number(row.SECOND_QTY || 0))
  + ['DISPLAY_QTY','DEMO_QTY','UNSELLABLE_QTY','PENDING_QTY','RENTAL_DEMO_QTY'].reduce((n,k) => n + Number(row[k] || 0), 0);
async function audit(db) {
  const [products] = await db.query(`SELECT p.PRODUCT_ID,p.PRODUCT_CODE,p.MANUFACTURER_CODE,p.NAME,p.NEED_SN,p.STATUS,
    pp.PRICE_ID,pp.COST_PRICE,pp.COST_PRICE_LOCKED,pp.STANDARD_PRICE
    FROM T_PRODUCT p LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID=p.PRODUCT_ID
    WHERE p.IS_DELETED=0 AND (pp.COST_PRICE IS NULL OR pp.COST_PRICE<=0 OR EXISTS
      (SELECT 1 FROM T_PRODUCT_SN sn WHERE sn.PRODUCT_ID=p.PRODUCT_ID AND sn.IS_DELETED=0
       AND sn.STATUS IN ('in_stock','reserved','occupied') AND (sn.INBOUND_PRICE IS NULL OR sn.INBOUND_PRICE<=0)))
    AND (EXISTS (SELECT 1 FROM T_INVENTORY i WHERE i.PRODUCT_ID=p.PRODUCT_ID AND
       (i.NORMAL_QTY>0 OR i.REGULAR_QTY>0 OR i.SUBSIDY_QTY>0 OR i.SECOND_QTY>0 OR i.DISPLAY_QTY>0 OR i.DEMO_QTY>0 OR i.UNSELLABLE_QTY>0 OR i.PENDING_QTY>0 OR i.RENTAL_DEMO_QTY>0))
      OR EXISTS (SELECT 1 FROM T_PRODUCT_SN sn WHERE sn.PRODUCT_ID=p.PRODUCT_ID AND sn.IS_DELETED=0 AND sn.STATUS IN ('in_stock','reserved','occupied')))
    ORDER BY p.PRODUCT_CODE,p.PRODUCT_ID`);
  if (!products.length) return { rows: [], summary: {} };
  const ids = products.map(row => row.PRODUCT_ID);
  const [inventory] = await db.query('SELECT i.*,s.NAME STORE_NAME FROM T_INVENTORY i LEFT JOIN T_STORE s ON s.STORE_ID=i.STORE_ID WHERE i.PRODUCT_ID IN (?)', [ids]);
  const [sns] = await db.query("SELECT sn.SN_ID,sn.SN_CODE,sn.PRODUCT_ID,sn.STORE_ID,s.NAME STORE_NAME,sn.STATUS,sn.INBOUND_PRICE,sn.ORIGINAL_PICKUP_PRICE,sn.BATCH_NO,sn.SOURCE_TYPE,sn.INBOUND_TIME FROM T_PRODUCT_SN sn LEFT JOIN T_STORE s ON s.STORE_ID=sn.STORE_ID WHERE sn.PRODUCT_ID IN (?) AND sn.IS_DELETED=0 AND sn.STATUS IN ('in_stock','reserved','occupied') ORDER BY sn.SN_ID", [ids]);
  const [inbounds] = await db.query(`SELECT ii.ITEM_ID,ii.PRODUCT_ID,ii.SN_ID,ii.SN_CODE,ii.UNIT_PRICE,ii.ORIGINAL_PICKUP_PRICE,ii.QUANTITY,ii.RECEIVED_QUANTITY,
    i.INBOUND_NO,i.SOURCE_TYPE,i.STATUS,i.RECEIVE_TIME FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID
    WHERE ii.PRODUCT_ID IN (?) ORDER BY i.RECEIVE_TIME DESC,i.INBOUND_NO DESC`, [ids]);
  const [conversions] = await db.query(`SELECT ci.PRODUCT_ID,ci.LINE_ROLE,ci.SN_ID,ci.SN_CODE,ci.UNIT_COST,c.CONVERSION_NO,c.CONVERSION_TYPE,c.STATUS,c.TOTAL_SOURCE_COST,c.TOTAL_TARGET_COST,c.CREATE_TIME
    FROM T_INVENTORY_CONVERSION_ITEM ci JOIN T_INVENTORY_CONVERSION c ON c.CONVERSION_ID=ci.CONVERSION_ID WHERE ci.PRODUCT_ID IN (?)`, [ids]);
  const [adjustments] = await db.query('SELECT PRODUCT_ID,SN_ID,AFTER_PRODUCT_COST,SOURCE_TYPE,SOURCE_ID,CREATE_TIME FROM T_INVENTORY_RESOURCE_COST_ADJUSTMENT WHERE PRODUCT_ID IN (?)', [ids]);
  const [priceLogs] = await db.query("SELECT PRODUCT_ID,PRICE_FIELD,OLD_PRICE,NEW_PRICE,SOURCE,CHANGE_REASON,CREATE_TIME FROM T_PRODUCT_PRICE_CHANGE_LOG WHERE PRODUCT_ID IN (?) AND LOWER(PRICE_FIELD) LIKE '%cost%' ORDER BY CREATE_TIME DESC", [ids]);
  const rows = products.map(p => {
    const stock = inventory.filter(i => i.PRODUCT_ID === p.PRODUCT_ID);
    const currentSns = sns.filter(sn => sn.PRODUCT_ID === p.PRODUCT_ID);
    const events = conversions.filter(c => c.PRODUCT_ID === p.PRODUCT_ID);
    const resources = adjustments.filter(a => a.PRODUCT_ID === p.PRODUCT_ID);
    const costs = currentSns.map(sn => sn.INBOUND_PRICE === null ? null : Number(sn.INBOUND_PRICE));
    const storeQty = new Map(); for (const i of stock) storeQty.set(key(i.STORE_ID), (storeQty.get(key(i.STORE_ID)) || 0) + qty(i));
    const storeSnCount = new Map(); for (const sn of currentSns) storeSnCount.set(key(sn.STORE_ID), (storeSnCount.get(key(sn.STORE_ID)) || 0) + 1);
    const stockQty = [...storeQty.values()].reduce((n,v) => n + v, 0);
    const stores = [...new Set([...storeQty.keys(), ...storeSnCount.keys()])];
    const countsMatch = stores.every(s => (storeQty.get(s) || 0) === (storeSnCount.get(s) || 0));
    const validSnCosts = costs.length > 0 && costs.every(c => c !== null && Number.isFinite(c) && c >= 0);
    const weightedCost = validSnCosts ? money(costs.reduce((n,c) => n + c, 0) / costs.length) : null;
    const masterZero = p.COST_PRICE === null || Number(p.COST_PRICE) === 0;
    let classification, proposedCost = null;
    const explicitZeroLog = priceLogs.some(log => log.PRODUCT_ID === p.PRODUCT_ID && Number(log.NEW_PRICE) === 0);
    if (!masterZero) classification = 'SN_COST_REVIEW';
    else if (Number(p.COST_PRICE_LOCKED) === 1) classification = 'LOCKED_COST_KEEP';
    else if (events.some(c => c.STATUS === 'completed' || c.STATUS === 'processing') || resources.some(a => Number(a.AFTER_PRODUCT_COST) === 0) || explicitZeroLog) classification = 'COST_EVENT_REVIEW';
    else if (validSnCosts && countsMatch && stockQty > 0 && costs.every(c => c > 0) && p.PRICE_ID) { classification = 'SN_MASTER_REFRESH_CANDIDATE'; proposedCost = weightedCost; }
    else if (validSnCosts && countsMatch && stockQty > 0 && costs.some(c => c === 0)) classification = 'SN_ZERO_REVIEW';
    else classification = 'SOURCE_OR_QUANTITY_REVIEW';
    return { ...p, classification, proposedCost, stockQty, snCount: currentSns.length, countsMatch,
      stores: stock.filter(i => qty(i) > 0).map(i => ({ storeId:i.STORE_ID,storeName:i.STORE_NAME,quantity:qty(i) })),
      sns:currentSns, inbounds:inbounds.filter(i => i.PRODUCT_ID===p.PRODUCT_ID), conversions:events, resources,
      priceLogs:priceLogs.filter(log => log.PRODUCT_ID===p.PRODUCT_ID) };
  });
  const summary = {}; for (const row of rows) summary[row.classification] = (summary[row.classification] || 0) + 1;
  return { rows, summary };
}
async function main() {
  const db = await mysql.createConnection({ host:config.host,port:config.port,user:config.username,password:config.password,database:config.database,connectTimeout:10000 });
  try {
    await db.query('SET TRANSACTION READ ONLY'); await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const result = await audit(db); await db.rollback();
    const dir=path.resolve(__dirname,'../../backup'); fs.mkdirSync(dir,{recursive:true});
    const filename=path.join(dir,'zero-inventory-cost-audit-20261027.json');
    fs.writeFileSync(filename,JSON.stringify({auditTime:new Date().toISOString(),...result},null,2));
    const labels = { SN_MASTER_REFRESH_CANDIDATE:'主档成本为0，完整在库SN为正成本，待确认刷新', SN_COST_REVIEW:'主档有成本但存在零成本SN，待核对',
      SN_ZERO_REVIEW:'SN含零成本，待核对，不能自动采用采购价覆盖', COST_EVENT_REVIEW:'存在拆装或成本调整记录，保留待核对',
      LOCKED_COST_KEEP:'人工锁定成本，保留', SOURCE_OR_QUANTITY_REVIEW:'缺少完整来源或库存数量不一致，待核对' };
    const headers=['商品编码','PN','商品名称','SN管理标记','当前商品成本','按当前正成本SN核对候选值','库存数量','当前SN数量','数量逐店一致','核查分类','已验收采购价记录','门店'];
    const csvRows=result.rows.map(r=>[r.PRODUCT_CODE,r.MANUFACTURER_CODE,r.NAME,r.NEED_SN,r.COST_PRICE,r.proposedCost,r.stockQty,r.snCount,r.countsMatch?'是':'否',labels[r.classification],
      r.inbounds.filter(i=>i.SOURCE_TYPE==='purchase'&&i.STATUS==='completed'&&Number(i.RECEIVED_QUANTITY)>0).map(i=>`${i.INBOUND_NO}:${i.UNIT_PRICE}`).join('；'),
      r.stores.map(s=>`${s.storeName}:${s.quantity}`).join('；')]);
    const quote=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
    const csvPath=path.join(dir,'zero-inventory-cost-products-20261027.csv');
    fs.writeFileSync(csvPath,'\uFEFF'+[headers,...csvRows].map(row=>row.map(quote).join(',')).join('\r\n'));
    const view = result.rows.map(r=>({code:r.PRODUCT_CODE,pn:r.MANUFACTURER_CODE,name:r.NAME,needSn:r.NEED_SN,cost:r.COST_PRICE,proposed:r.proposedCost,quantity:r.stockQty,sns:r.snCount,classification:r.classification}));
    const nonSn=result.rows.filter(r=>Number(r.NEED_SN)===0 && r.inbounds.some(i=>i.SOURCE_TYPE==='purchase'&&i.STATUS==='completed'&&Number(i.RECEIVED_QUANTITY)>0&&Number(i.UNIT_PRICE)>0));
    const pendingRows = nonSn.filter(r=>Number(r.COST_PRICE_LOCKED)!==1).map(r=>{
      const receipts=r.inbounds.filter(i=>i.SOURCE_TYPE==='purchase'&&i.STATUS==='completed'&&Number(i.RECEIVED_QUANTITY)>0);
      const prices=[...new Set(receipts.map(i=>i.UNIT_PRICE))];
      return [r.PRODUCT_CODE,r.MANUFACTURER_CODE,r.NAME,r.COST_PRICE,r.stockQty,prices.join(' / '),prices.length===1?prices[0]:'待确认：多批次价格',receipts.map(i=>i.INBOUND_NO).join('；')];
    });
    const pendingPath=path.join(dir,'non-sn-zero-cost-purchase-candidates-20261027.csv');
    fs.writeFileSync(pendingPath,'\uFEFF'+[['商品编码','PN','商品名称','当前商品成本','库存数量','已验收采购单价','候选修复单价（未执行）','依据入库单'],...pendingRows].map(row=>row.map(quote).join(',')).join('\r\n'));
    console.log(JSON.stringify({report:filename,csv:csvPath,purchaseCandidatesCsv:pendingPath,summary:result.summary,sample:view.find(r=>String(r.pn).includes('GL62M7RDX')),
      nonSnWithReceivedPurchase:nonSn.length,nonSnUnlockedWithReceivedPurchase:nonSn.filter(r=>Number(r.COST_PRICE_LOCKED)!==1).length,
      nonSnUnlockedSingleReceivedPrice:nonSn.filter(r=>Number(r.COST_PRICE_LOCKED)!==1&&new Set(r.inbounds.filter(i=>i.SOURCE_TYPE==='purchase'&&i.STATUS==='completed'&&Number(i.RECEIVED_QUANTITY)>0).map(i=>i.UNIT_PRICE)).size===1).length,
      candidateExamples:view.filter(r=>r.classification==='SN_MASTER_REFRESH_CANDIDATE').slice(0,8)},null,2));
  } finally { await db.end(); }
}
if(require.main===module) main().catch(error=>{console.error(error.code||error.name,error.message);process.exitCode=1});
module.exports={audit,qty};
