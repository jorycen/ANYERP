// The legacy unguarded refresh could turn a missing purchase price into zero cost.
// Use the scoped, transactional V11 migration instead.
console.error('请使用 migrate-final-order-gross-profit-to-current.js --scope=october [--execute]；其他月份毛利已定稿，缺少采购价的订单会保留旧快照。');
process.exitCode = 1;
