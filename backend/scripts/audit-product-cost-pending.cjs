// Read-only business audit. Output files are confined to backend/backup.
const fs = require('node:fs'), path = require('node:path');
const M = require('../src/models');
const { QueryTypes } = require('sequelize');
async function main() {
  const statusCounts = await M.sequelize.query(`SELECT s.STATUS status,COUNT(*) orders FROM T_PRODUCT_SETTLEMENT_ORDER s
    JOIN T_ORDER o ON o.ORDER_ID=s.SOURCE_ORDER_ID WHERE o.IS_DELETED=0
    AND o.ORDER_STATUS IN ('已归档','completed','archived') GROUP BY s.STATUS`, { type: QueryTypes.SELECT });
  const rows = await M.sequelize.query(`SELECT s.SETTLEMENT_ID settlementId,s.SOURCE_ORDER_NO orderNo,
    s.SOURCE_ORDER_ID orderId,s.BUSINESS_DATE businessDate,s.STORE_ID storeId,st.NAME storeName,
    i.SETTLEMENT_ITEM_ID itemId,i.SOURCE_ORDER_ITEM_ID orderItemId,i.SN_CODE snCode,i.PRODUCT_NAME productName,
    i.PN_CODE pnCode,i.COST_STATUS costStatus,i.PRODUCT_UNIT_PRICE productPrice,i.PURCHASE_UNIT_COST cost,
    i.COST_SOURCE costSource
    FROM T_PRODUCT_SETTLEMENT_ORDER s JOIN T_ORDER o ON o.ORDER_ID=s.SOURCE_ORDER_ID
    JOIN T_PRODUCT_SETTLEMENT_ITEM i ON i.SETTLEMENT_ID=s.SETTLEMENT_ID
    LEFT JOIN T_STORE st ON st.STORE_ID=s.STORE_ID
    WHERE s.STATUS='cost_pending' AND o.IS_DELETED=0 AND o.ORDER_STATUS IN ('已归档','completed','archived')
    ORDER BY s.BUSINESS_DATE,s.SOURCE_ORDER_NO,i.SETTLEMENT_ITEM_ID`, { type: QueryTypes.SELECT });
  const orders = new Map();
  for (const row of rows) {
    if (!orders.has(row.orderId)) orders.set(row.orderId, { orderNo: row.orderNo, businessDate: row.businessDate,
      storeName: row.storeName, items: [] });
    orders.get(row.orderId).items.push(row);
  }
  function summarize(list) {
    const blockedSn = new Set(), ownPendingSn = new Set(), collateralSn = new Set(), accessoryOnlySn = new Set();
    let pendingLines = 0, pendingSnLines = 0, pendingNonSnLines = 0, accessoryOnlyOrders = 0, noPendingOrders = 0;
    for (const order of list) {
      const pending = order.items.filter(row => row.costStatus !== 'ready');
      pendingLines += pending.length;
      pendingSnLines += pending.filter(row => row.snCode).length;
      pendingNonSnLines += pending.filter(row => !row.snCode).length;
      if (!pending.length) noPendingOrders++;
      if (pending.length && pending.every(row => !row.snCode)) accessoryOnlyOrders++;
      for (const item of order.items.filter(row => row.snCode)) {
        blockedSn.add(item.snCode);
        if (item.costStatus !== 'ready') ownPendingSn.add(item.snCode);
        else if (pending.length) collateralSn.add(item.snCode);
        if (item.costStatus === 'ready' && pending.length && pending.every(row => !row.snCode)) accessoryOnlySn.add(item.snCode);
      }
    }
    return { orders: list.length, distinctSn: blockedSn.size, ownPendingSn: ownPendingSn.size, collateralSn: collateralSn.size,
      collateralOnlySn: [...collateralSn].filter(sn => !ownPendingSn.has(sn)).length,
      accessoryOnlySnExcludingOwnPending: [...accessoryOnlySn].filter(sn => !ownPendingSn.has(sn)).length,
      accessoryOnlySn: accessoryOnlySn.size, accessoryOnlyOrders, noPendingOrders, pendingLines, pendingSnLines, pendingNonSnLines };
  }
  const list = [...orders.values()];
  const date = value => value instanceof Date ? new Date(value.getTime()+28800000).toISOString().slice(0,10) : String(value).slice(0,10);
  const target = list.find(order => order.orderNo === 'ORD202610240752386254');
  const pendingProducts = new Map();
  for (const row of rows.filter(row => row.costStatus !== 'ready')) {
    const key = `${row.pnCode}|${row.productName}`;
    const current = pendingProducts.get(key) || { pn: row.pnCode, product: row.productName, lines: 0, orders: new Set() };
    current.lines++; current.orders.add(row.orderId); pendingProducts.set(key,current);
  }
  const summary = { auditedAt: new Date().toISOString(), scope: 'not-deleted archived orders with product settlement cost_pending; no business writes',
    statusCounts, all: summarize(list), october: summarize(list.filter(order => date(order.businessDate).startsWith('2026-10'))),
    target, topPendingProducts: [...pendingProducts.values()].map(row => ({ ...row, orders: row.orders.size })).sort((a,b)=>b.lines-a.lines).slice(0,12) };
  const directory = path.resolve(__dirname, '../backup'); fs.mkdirSync(directory,{recursive:true});
  const output = path.join(directory,'product-cost-pending-audit-20261029.json');
  fs.writeFileSync(output,JSON.stringify({summary,orders:list},null,2));
  const textOutput = { ...summary, target: target ? { orderNo: target.orderNo, items: target.items } : null, output };
  process.stdout.write(JSON.stringify(textOutput));
}
main().catch(error => { process.stderr.write(error.stack); process.exitCode=1; }).finally(()=>M.sequelize.close());
