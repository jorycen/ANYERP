// 一次性清理用户已确认的8条缺失库位库存；默认只预览，--apply执行。
const { sequelize } = require('../src/config/database');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const fields = ['NORMAL_QTY', 'REGULAR_QTY', 'SUBSIDY_QTY', 'SECOND_QTY', 'DISPLAY_QTY', 'DEMO_QTY', 'UNSELLABLE_QTY', 'PENDING_QTY', 'RENTAL_DEMO_QTY'];
const expected = new Map([
  ['SP04627|青羊鹏瑞利', 9], ['SP00889|万象城', 11], ['SP00889|北城天街', 16],
  ['SP00889|重庆光环', 9], ['SP00889|重庆龙兴天街', 10], ['SP00889|青羊鹏瑞利', 10],
  ['SP00907|青羊鹏瑞利', 1], ['SP04835|万象城', 1]
]);
const sql = `SELECT i.*, p.PRODUCT_CODE, p.NEED_SN, s.NAME AS STORE_NAME
  FROM T_INVENTORY i JOIN T_PRODUCT p ON p.PRODUCT_ID=i.PRODUCT_ID
  JOIN T_STORE s ON s.STORE_ID=i.STORE_ID
  LEFT JOIN T_LOCATION l ON l.LOCATION_ID=i.LOCATION_ID AND l.STATUS=1
  WHERE p.STATUS=1 AND p.IS_DELETED=0 AND l.LOCATION_ID IS NULL
  AND (${fields.map(field => `i.${field}>0`).join(' OR ')})`;

async function main() {
  const apply = process.argv.includes('--apply');
  await sequelize.transaction(async transaction => {
    const rows = await sequelize.query(`${sql} FOR UPDATE`, { type: 'SELECT', transaction });
    if (!rows.length) { console.log('无剩余缺失库位正库存；未作修改。'); return; }
    const keys = new Set();
    for (const row of rows) {
      const key = `${row.PRODUCT_CODE}|${row.STORE_NAME}`;
      if (keys.has(key) || expected.get(key) !== Number(row.NORMAL_QTY)
          || Number(row.NEED_SN) !== 0 || String(row.LOCATION_ID || '').trim()
          || fields.slice(1).some(field => Number(row[field] || 0) !== 0)) {
        throw new Error(`记录与已确认清单不一致，停止清理：${key}`);
      }
      keys.add(key);
    }
    if (rows.length !== expected.size) throw new Error('记录数量与已确认8条不一致，停止清理');
    console.log(JSON.stringify({ apply, count: rows.length, quantity: rows.reduce((sum, row) => sum + Number(row.NORMAL_QTY), 0), rows }));
    if (!apply) return;
    for (const row of rows) {
      await recordBusinessAction({
        businessType: 'inventory_cleanup', businessId: row.INVENTORY_ID,
        businessNo: 'MISSING-LOCATION-20260905', action: 'clear_missing_location',
        user: { name: 'Codex（用户确认执行）' },
        comment: '用户确认“直接清理”：仅清零缺失库位库存，保留商品和有效库位库存。',
        detail: { before: row, after: Object.fromEntries(fields.map(field => [field, 0])) }, transaction
      });
      await sequelize.query(`UPDATE T_INVENTORY SET ${fields.map(field => `${field}=0`).join(',')}, UPDATE_TIME=NOW() WHERE INVENTORY_ID=:id`, {
        replacements: { id: row.INVENTORY_ID }, transaction
      });
    }
    const remaining = await sequelize.query(sql, { type: 'SELECT', transaction });
    if (remaining.length) throw new Error('清理后仍有缺失库位正库存，回滚');
    console.log('清理及审计已完成：8条、67个；缺失库位正库存剩余0条。');
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
