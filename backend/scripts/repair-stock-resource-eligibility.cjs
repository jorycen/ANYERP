const M = require('../src/models');
const { Op } = require('sequelize');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const uid = () => require('node:crypto').randomUUID().replaceAll('-', '');
const types = ['EDU_SUBSIDY', 'SALES_BONUS', 'MANUFACTURER_REBATE', 'SALES_REPORT'];
const apply = process.argv.includes('--apply');
const batch = 'RESOURCE-ELIGIBILITY-' + Date.now();
const dir = path.resolve(__dirname, '../backup/resource-eligibility', batch);
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const result = await M.sequelize.transaction(async transaction => {
    const opts = { transaction, ...(apply ? { lock: transaction.LOCK.UPDATE } : {}) };
    const sns = await M.ProductSn.findAll({ where: { status: 'in_stock', is_deleted: 0 }, ...opts });
    const ids = sns.map(x => x.sn_id);
    const rights = ids.length ? await M.InventoryResourceRight.findAll({ where: { sn_id: ids }, ...opts }) : [];
    const itemIds = [...new Set(rights.map(r => r.source_request_item_id).filter(Boolean))];
    const items = itemIds.length ? await M.PurchaseRequestItem.findAll({ where: { item_id: itemIds }, ...opts }) : [];
    const changes = ids.length ? await M.ResourceRightChangeOrder.findAll({ where: { sn_id: ids, resource_type: types }, ...opts }) : [];
    const plan = [], skipped = [];
    for (const sn of sns) {
      const own = rights.filter(r => r.sn_id === sn.sn_id);
      const sources = [...new Set(own.map(r => String(r.source_request_item_id || '')).filter(Boolean))];
      const item = sources.length === 1 ? items.find(i => String(i.item_id) === sources[0] && i.product_id === sn.product_id) : null;
      const full = item && (item.goods_type_id === 'GT_SERVICE_FULL_RESOURCE' || item.product_type === '服务商全资源货');
      const template = own.find(r => r.source_request_item_id && String(r.source_request_item_id) === sources[0]);
      for (const type of types) {
        const right = own.find(r => r.resource_type === type);
        const history = changes.filter(c => c.sn_id === sn.sn_id && c.resource_type === type);
        if (right?.locked_source_id || right?.locked_source_type) { skipped.push({ sn: sn.sn_code, type, reason: '权益锁定' }); continue; }
        if (right) {
          if (!['AVAILABLE', 'NOT_APPLICABLE'].includes(right.current_status)) continue;
          const expired = type === 'EDU_SUBSIDY' && right.initial_status === 'AVAILABLE' && (
            right.source === 'EDUCATION_POLICY_EXPIRED' || (right.source === 'EDUCATION_POLICY_IMPORT' && right.effective_end && new Date(right.effective_end) < new Date()));
          if (expired) plan.push({ sn, right, type, before: right.toJSON(), item: null, template: null });
        } else if (full && template && history.length === 0) {
          plan.push({ sn, right: null, type, before: null, item, template });
        } else if (!right) skipped.push({ sn: sn.sn_code, type, reason: history.length ? '历史存在该权益变更，禁止重建' : '缺少唯一全资源采购依据' });
      }
    }
    const report = { batch, apply, scanned: sns.length, changes: plan.map(p => ({ sn: p.sn.sn_code, snId: p.sn.sn_id, type: p.type, before: p.before, reason: p.right ? '教育活动过期保留资格' : '明确全资源采购缺失资格' })), skipped };
    fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    if (apply) for (const p of plan) {
      const values = { current_status: 'AVAILABLE', amount: 0, effective_start: null, effective_end: null, rule_config_id: null, source: 'ELIGIBILITY_REPAIR', remark: batch + '；无当前活动金额0，保留资格', version: Number(p.right?.version || 0) + 1, update_time: new Date() };
      if (p.right) await p.right.update(values, { transaction });
      else {
        const t = p.template;
        p.right = await M.InventoryResourceRight.create({ ...values, right_id: uid(), sn_id: p.sn.sn_id, sn_code: p.sn.sn_code, product_id: p.sn.product_id, resource_type: p.type, initial_status: 'AVAILABLE', source_request_id: t.source_request_id, source_request_item_id: t.source_request_item_id, source_inbound_id: t.source_inbound_id, supplier_id: t.supplier_id, supplier_name: t.supplier_name }, { transaction });
      }
      await M.ResourceRightChangeOrder.create({ change_id: uid(), change_order_no: 'RRC' + Date.now() + uid().slice(0, 8), sn_id: p.sn.sn_id, sn_code: p.sn.sn_code, product_id: p.sn.product_id, resource_type: p.type, before_status: p.before?.current_status || 'NOT_APPLICABLE', after_status: 'AVAILABLE', change_amount: 0, change_reason: 'ELIGIBILITY_REPAIR', approval_status: 'approved', applicant_name: 'Codex用户授权操作', reviewer_name: 'Codex用户授权操作', review_time: new Date(), remark: batch }, { transaction });
      const check = await M.InventoryResourceRight.findByPk(p.right.right_id, { transaction });
      assert.equal(check.current_status, 'AVAILABLE'); assert.equal(Number(check.amount), 0);
    }
    return { batch, scanned: sns.length, changed: plan.length, affectedSNs: new Set(plan.map(p => p.sn.sn_id)).size, skipped: skipped.length, byType: Object.fromEntries(types.map(t => [t, plan.filter(p => p.type === t).length])), dir };
  });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ...result, committed: apply }, null, 2));
  console.log(JSON.stringify({ ...result, committed: apply }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => M.sequelize.close());
