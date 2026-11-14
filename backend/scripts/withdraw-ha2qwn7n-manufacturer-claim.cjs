const M = require('../src/models');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const id = 'ca3590131ddd4408add35bce88f2a4d9';
const reason = '用户在Codex会话明确要求直接撤回HA2QWN7N厂商返利0.01元，不恢复审批，不操作其他权益';
const uid = () => crypto.randomUUID().replaceAll('-', '');
(async () => {
  await M.sequelize.transaction(async transaction => {
    const opt = { transaction, lock: transaction.LOCK.UPDATE };
    const change = await M.ResourceRightChangeOrder.findByPk(id, opt);
    assert.equal(change.sn_code, 'HA2QWN7N');
    assert.equal(change.resource_type, 'MANUFACTURER_REBATE');
    assert.equal(change.approval_status, 'approved');
    assert.equal(Number(change.change_amount), 0.01);
    const sn = await M.ProductSn.findByPk(change.sn_id, opt);
    const right = await M.InventoryResourceRight.findOne({ where: { sn_id: change.sn_id, resource_type: change.resource_type }, ...opt });
    assert.equal(right.current_status, 'CLAIMED_BACK');
    const adjustments = await M.InventoryResourceCostAdjustment.findAll({ where: { sn_id: change.sn_id }, ...opt });
    const original = adjustments.filter(x => x.source_type === 'RESOURCE_CLAIM' && x.source_id === id);
    assert.equal(original.length, 1);
    assert.equal(Number(original[0].adjustment_amount), -0.01);
    assert.equal(adjustments.filter(x => x.source_type === 'CLAIM_WITHDRAWAL' && x.source_id === id).length, 0);
    const settlements = await M.ResourceSettlement.findAll({ where: { source_id: [id, 'PRICE_CLAIM_' + id] }, ...opt });
    assert.equal(settlements.length, 1, '存在额外价保关联，停止自动撤回');
    for (const s of settlements) {
      assert.equal(s.status, 'PENDING');
      assert.equal(Number(s.matched_amount), 0);
      assert.equal(s.settled_at, null);
      assert.equal(await M.RebateSettlementAllocation.count({ where: { settlement_id: s.settlement_id }, transaction }), 0);
      assert.equal(await M.SettlementAccountTransaction.count({ where: { related_ref: s.settlement_no }, transaction }), 0);
    }
    const instances = await M.ApprovalFlowInstance.findAll({ where: { business_type: 'resource_claim', business_id: id }, ...opt });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].status, 'approved');
    const dir = path.resolve(__dirname, '../backup/claim-withdrawal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ reason, change, sn, right, adjustments, settlements, instances }, null, 2), { flag: 'wx' });
    const before = Math.round((Number(sn.inbound_price) + adjustments.reduce((s, x) => s + Number(x.adjustment_amount), 0)) * 100) / 100;
    await M.InventoryResourceCostAdjustment.create({ adjustment_id: uid(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
      resource_type: change.resource_type, adjustment_amount: 0.01, before_product_cost: before, after_product_cost: Math.round((before + 0.01) * 100) / 100,
      source_type: 'CLAIM_WITHDRAWAL', source_id: id, affect_sales_settlement_cost: 0, operator_id: null, operator_name: 'Codex用户授权操作', remark: reason }, { transaction });
    for (const s of settlements) await s.update({ status: 'CANCELLED', cancelled_at: new Date(), cancelled_by_name: 'Codex用户授权操作', correction_reason: reason }, { transaction });
    await right.update({ current_status: 'AVAILABLE', locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1 }, { transaction });
    await change.update({ approval_status: 'cancelled', remark: (change.remark || '') + '；已按用户要求撤回（原审批记录保留）' }, { transaction });
    await instances[0].update({ status: 'cancelled', update_time: new Date() }, { transaction });
    await recordBusinessAction({ businessType: 'resource_claim', businessId: id, businessNo: change.change_order_no, action: 'withdraw_approved_claim', fromStatus: 'approved', toStatus: 'cancelled', user: { name: 'Codex用户授权操作' }, comment: reason, detail: { amount: 0.01, originalAdjustmentId: original[0].adjustment_id, settlementIds: settlements.map(x => x.settlement_id) }, transaction });
  });
  console.log('撤回事务已提交');
  console.log(JSON.stringify({ claim: await M.ResourceRightChangeOrder.findByPk(id, { raw: true }), settlements: await M.ResourceSettlement.findAll({ where: { source_id: id }, raw: true }), right: await M.InventoryResourceRight.findOne({ where: { sn_id: '3b1ed380960042bebf1ce3c335ea5b0a', resource_type: 'MANUFACTURER_REBATE' }, raw: true }) }, null, 2));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
