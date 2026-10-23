// Targeted, user-authorized repair. Preview by default; --apply commits atomically.
const assert = require('node:assert/strict');
const M = require('../src/models');
const { buildFreightCostDetails } = require('../src/modules/sales/grossProfit');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const ORDER_NO = 'ORD202610210705283617';
const ACTION = 'correct_misattributed_freight';
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const cents = value => Math.round(Number(value) * 100);

async function run() {
  const apply = process.argv.includes('--apply');
  const result = await M.sequelize.transaction(async transaction => {
    const order = await M.Order.findOne({ where: { order_no: ORDER_NO }, transaction, lock: transaction.LOCK.UPDATE });
    assert(order, 'Order missing');
    assert.equal(order.order_id, '82f7d9ea8eb44c1794eef1747c5a164e');
    assert.equal(order.order_status, '已归档');
    assert.equal(Number(order.is_deleted), 0);
    // Use the same store lock as financial review/month close.
    await M.Store.findByPk(order.store_id, { transaction, lock: transaction.LOCK.UPDATE });
    const tables = await M.sequelize.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='T_FINANCIAL_PROFIT_PERIOD'",
      { type: M.sequelize.QueryTypes.SELECT, transaction });
    if (tables.length) {
      const closed = await M.sequelize.query(
        "SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY='2026-10' FOR UPDATE",
        { type: M.sequelize.QueryTypes.SELECT, transaction });
      assert.equal(closed.length, 0, 'Period closed; requires open-period adjustment');
    }
    assert.equal(await M.SalesReturnRequest.count({ where: { order_id: order.order_id }, transaction }), 0, 'Return exists; needs separate review');
    const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE });
    const item = await M.OrderItem.findByPk(46839, { transaction, lock: transaction.LOCK.UPDATE });
    assert(snapshot && item, 'Snapshot/item missing');
    assert.equal(item.order_id, order.order_id);
    assert.equal(item.sn_code, 'PF132AEZ');
    const existing = await M.BusinessActionLog.findOne({ where: { business_type: 'sales_order', business_id: order.order_id, action: ACTION }, transaction });
    if (existing) {
      assert.equal(cents(snapshot.freight_cost_amount), 0);
      assert.equal(cents(snapshot.gross_profit_amount), 32737);
      assert.equal(cents(item.freight_cost), 0);
      return { applied: false, alreadyCorrected: true, auditId: existing.log_id };
    }
    assert.equal(snapshot.snapshot_status, 'final');
    assert.equal(cents(snapshot.freight_cost_amount), 36000);
    assert.equal(cents(snapshot.gross_profit_amount), -3263);
    assert.equal(cents(item.freight_cost), 36000);
    const details = parse(snapshot.supplement_details) || [];
    const freight = details.filter(row => row.source === 'freight_cost');
    assert.equal(freight.length, 1);
    assert.equal(freight[0].freightId, '85c5b89fea314246801d117415eb75ed');
    assert.equal(freight[0].sourceNo, 'PR202610180947311824');
    assert.equal(cents(freight[0].amount), 36000);
    assert.deepEqual(await buildFreightCostDetails(order, transaction), [], 'Current source matching no longer supports zero freight');
    const actualSource = await M.PurchaseRequest.findOne({ where: { request_no: 'PR202610210700436185' }, transaction, lock: transaction.LOCK.UPDATE });
    assert(actualSource);
    assert.equal(cents(actualSource.freight_amount), 0);
    const before = snapshot.toJSON();
    const afterDetails = details.filter(row => row.source !== 'freight_cost');
    const preview = { orderNo: ORDER_NO, itemId: item.item_id, beforeFreight: 360, afterFreight: 0, beforeProfit: -32.63, afterProfit: 327.37 };
    if (!apply) return { ...preview, applied: false, preview: true };
    await snapshot.update({ freight_cost_amount: 0, gross_profit_amount: 327.37, supplement_details: afterDetails }, { transaction });
    await item.update({ freight_cost: 0 }, { transaction });
    const saved = await M.OrderGrossProfit.findByPk(snapshot.gross_profit_id, { transaction, raw: true });
    for (const key of Object.keys(before)) {
      if (['freight_cost_amount', 'gross_profit_amount', 'supplement_details', 'update_time'].includes(key)) continue;
      assert.deepEqual(saved[key], before[key], `Unexpected frozen field change: ${key}`);
    }
    const audit = await recordBusinessAction({ businessType: 'sales_order', businessId: order.order_id,
      businessNo: ORDER_NO, action: ACTION, fromStatus: order.order_status, toStatus: order.order_status,
      user: { name: 'Codex（用户授权执行）' },
      comment: '用户确认定向移除跨采购单误扣的360元运费；保留其他归档快照及原采购运费。',
      detail: { ...preview, authorization: '用户回复：执行', actualPurchaseNo: actualSource.request_no,
        wrongFreightRecordId: freight[0].freightId, beforeSnapshot: before, afterSnapshot: saved,
        beforeItemFreight: 360, afterItemFreight: 0 }, transaction });
    return { ...preview, applied: true, auditId: audit.log_id };
  });
  console.log(JSON.stringify(result, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => M.sequelize.close());
