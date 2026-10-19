// One-time, guarded production correction. Run from the ANY-ERP repository root.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('../backend/node_modules/mysql2/promise');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', 'cloud-db.env'), 'utf8')
  .split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));

async function main() {
  const db = await mysql.createConnection({
    host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER,
    password: env.DB_PASSWORD, database: env.DB_NAME, connectTimeout: 10000
  });
  try {
    await db.beginTransaction();
    const requestNo = 'PR202609290225149120';
    const [payables] = await db.execute(
      'SELECT payable_id,source_no,total_amount,offset_amount,offset_payable_id,paid_amount,settled_amount,status FROM T_PAYABLE WHERE request_no=? FOR UPDATE',
      [requestNo]
    );
    const bySource = Object.fromEntries(payables.map(row => [row.source_no, row]));
    const original = bySource[requestNo];
    const returned = bySource.RTN20261019034436113;
    const duplicate = bySource.PRA2026101933939;
    if (!original || !returned || !duplicate || payables.length !== 3) throw new Error('应付记录已变化，停止修复');
    if (original.status === 'unpaid' && returned.status === 'credit' && duplicate.status === 'cancelled') {
      await db.rollback();
      console.log('该单已修复');
      return;
    }
    if (Number(original.total_amount) !== 240 || Number(original.offset_amount) !== 240 || original.status !== 'paid'
      || Number(original.paid_amount) !== 0 || Number(original.settled_amount) !== 0
      || Number(returned.total_amount) !== -240 || Number(returned.offset_amount) !== 240
      || returned.offset_payable_id !== original.payable_id || returned.status !== 'offset'
      || Number(duplicate.total_amount) !== -240 || duplicate.status !== 'credit') {
      throw new Error('应付状态或金额已变化，停止修复');
    }
    const [settlementItems] = await db.execute(
      'SELECT item_id FROM T_SETTLEMENT_ITEM WHERE payable_id IN (?,?,?) LIMIT 1',
      [original.payable_id, returned.payable_id, duplicate.payable_id]
    );
    if (settlementItems.length) throw new Error('已有结算明细，停止修复');
    const [adjustments] = await db.execute(
      'SELECT adjustment_id,status,total_quantity_delta,total_amount_delta FROM T_PURCHASE_ADJUSTMENT WHERE adjustment_no=? FOR UPDATE',
      ['PRA2026101933939']
    );
    if (adjustments.length !== 1 || adjustments[0].status !== 'completed'
      || Number(adjustments[0].total_quantity_delta) !== -1
      || Number(adjustments[0].total_amount_delta) !== -240) {
      throw new Error('采购调整单已变化，停止修复');
    }
    await db.execute('UPDATE T_PAYABLE SET offset_amount=0,status=? WHERE payable_id=?', ['unpaid', original.payable_id]);
    await db.execute('UPDATE T_PAYABLE SET offset_amount=0,offset_payable_id=NULL,status=? WHERE payable_id=?', ['credit', returned.payable_id]);
    await db.execute('UPDATE T_PAYABLE SET status=? WHERE payable_id=?', ['cancelled', duplicate.payable_id]);
    await db.execute('UPDATE T_PURCHASE_ADJUSTMENT SET status=? WHERE adjustment_id=?', ['cancelled', adjustments[0].adjustment_id]);
    await db.execute(
      'INSERT INTO T_BUSINESS_ACTION_LOG (log_id,business_type,business_id,business_no,action,from_status,to_status,actor_name,comment,detail_json,create_time) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
      [crypto.randomUUID().replace(/-/g, ''), 'purchase_request', '0f46f1647a014ae39be819db18412435',
        requestNo, 'duplicate_negative_payable_corrected', 'duplicated', 'ready_for_manual_settlement',
        'Codex', '取消重复待入库负单，恢复原正单及真实退库负单供手工结算',
        JSON.stringify({ originalPayableId: original.payable_id, returnPayableId: returned.payable_id,
          cancelledPayableId: duplicate.payable_id, cancelledAdjustmentNo: 'PRA2026101933939' })]
    );
    await db.commit();
    console.log('已恢复正向应付 ¥240、真实退货负向应付 ¥-240，并取消重复负单');
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
