const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
async function events(filters, range, query) {
  if (!filters.storeIds?.length) return [];
  // Product-specific analysis must not absorb unrelated gift income.
  const select = query || ((sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT }));
  const rows = await select(`SELECT r.id, r.exchange_id, r.store_id, s.NAME AS store_name,
    r.staff_id, st.NAME AS staff_name, r.created_at, r.cash_received, r.sales_profit, r.operations_profit, r.cost_amount,
    JSON_UNQUOTE(JSON_EXTRACT(e.snapshot, '$.product_id')) AS product_id
    FROM T_REWARD_REDEMPTION r JOIN T_REWARD_EXCHANGE e ON e.id = r.exchange_id
    LEFT JOIN T_STORE s ON s.STORE_ID = r.store_id LEFT JOIN T_STAFF st ON st.STAFF_ID = r.staff_id
    LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = JSON_UNQUOTE(JSON_EXTRACT(e.snapshot, '$.product_id'))
    WHERE r.sales_profit IS NOT NULL AND r.operations_profit IS NOT NULL
      AND r.store_id IN (:storeIds) AND r.created_at >= :startAt AND r.created_at <= :endAt
      ${filters.employeeId ? 'AND r.staff_id = :employeeId' : ''}
      ${filters.storeId ? 'AND r.store_id = :storeId' : ''}
      ${filters.productLine ? "AND (p.CATEGORY = :productLine OR p.CATEGORY LIKE :productLinePrefix)" : ''}
    ORDER BY r.created_at DESC`, { ...filters, productLinePrefix: `${filters.productLine}/%`, startAt: range.startAt, endAt: range.endAt });
  return rows.map(r => ({ ...r, order_id: `reward:${r.id}`, order_no: `REWARD-${r.exchange_id}`, entry_type: 'reward_redemption',
    create_time: r.created_at, create_staff_id: r.staff_id, create_user: r.staff_name || String(r.staff_id), auxiliary_sales_list: '[]',
    sales_amount: Number(r.cash_received), base_gross_profit: Number(r.sales_profit) }));
}
async function operations(filters, range) {
  const rows = await events(filters, range);
  return { rows, operationsGrossProfit: Math.round(rows.reduce((s, r) => s + Number(r.operations_profit), 0) * 100) / 100,
    costAmount: Math.round(rows.reduce((s, r) => s + Number(r.cost_amount), 0) * 100) / 100 };
}
module.exports = { events, operations };
