const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

function amount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseDetails(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function summarizeAllocatedExpenses({ storeIds = [], dateMode = 'date', startDate, endDate, monthKeys = [] } = {}) {
  const selectedStoreIds = [...new Set((storeIds || []).map(String).filter(Boolean))];
  if (!selectedStoreIds.length) return { amount: 0, expenseCount: 0, byType: [], byStore: [] };

  const selectedStores = await sequelize.query(
    'SELECT STORE_ID AS storeId, NAME AS storeName, DISTRIBUTOR_ID AS distributorId FROM T_STORE WHERE STORE_ID IN (:storeIds)',
    { replacements: { storeIds: selectedStoreIds }, type: QueryTypes.SELECT }
  );
  const distributorIds = [...new Set(selectedStores.map(row => String(row.distributorId || '')).filter(Boolean))];
  const distributorStores = distributorIds.length
    ? await sequelize.query(
      'SELECT STORE_ID AS storeId, NAME AS storeName, DISTRIBUTOR_ID AS distributorId FROM T_STORE WHERE DISTRIBUTOR_ID IN (:distributorIds) AND STATUS = 1 AND IS_DELETED = 0',
      { replacements: { distributorIds }, type: QueryTypes.SELECT }
    )
    : [];
  const storesByDistributor = new Map();
  distributorStores.forEach(row => {
    const key = String(row.distributorId || '');
    const list = storesByDistributor.get(key) || [];
    list.push(String(row.storeId));
    storesByDistributor.set(key, list);
  });
  const storeNameMap = new Map([...selectedStores, ...distributorStores].map(row => [String(row.storeId), row.storeName || String(row.storeId)]));

  const dateClause = dateMode === 'accounting_month'
    ? 'AND e.ACCOUNTING_MONTH IN (:monthKeys)'
    : 'AND e.EXPENSE_DATE BETWEEN :startDate AND :endDate';
  const replacements = { storeIds: selectedStoreIds, distributorIds, startDate, endDate, monthKeys };
  const rows = await sequelize.query(
    `SELECT e.EXPENSE_ID AS expenseId, e.EXPENSE_TYPE AS expenseType, e.AMOUNT AS amount,
            e.STORE_ID AS sourceStoreId, e.DISTRIBUTOR_ID AS distributorId,
            e.ATTRIBUTION_TYPE AS attributionType, e.ATTRIBUTION_DETAILS_JSON AS attributionDetails
       FROM T_EXPENSE e
      WHERE e.IS_DELETED = 0
        AND e.AFFECTS_STORE_PROFIT = 1
        AND e.STATUS NOT IN ('draft', 'pending_approval', 'rejected', 'cancelled')
        AND (e.STORE_ID IN (:storeIds) OR e.DISTRIBUTOR_ID IN (:distributorIds)
          OR (e.ATTRIBUTION_TYPE = 'STORE' AND JSON_VALID(e.ATTRIBUTION_DETAILS_JSON)
            AND EXISTS (SELECT 1 FROM JSON_TABLE(CASE WHEN JSON_VALID(e.ATTRIBUTION_DETAILS_JSON) THEN e.ATTRIBUTION_DETAILS_JSON ELSE '[]' END, '$[*]' COLUMNS (target_id VARCHAR(64) PATH '$.target_id')) allocation_target
              WHERE allocation_target.target_id IN (:storeIds))))
        ${dateClause}`,
    { replacements, type: QueryTypes.SELECT }
  );

  const byType = new Map();
  const byStore = new Map();
  const byStoreType = new Map();
  const countedExpenses = new Set();
  let total = 0;

  rows.forEach(row => {
    const expenseAmount = amount(row.amount);
    const type = String(row.attributionType || 'STORE').toUpperCase();
    const details = parseDetails(row.attributionDetails);
    let allocations = [];
    let distributorExpense = false;

    if (type === 'STORE' || (type === 'COMPANY' && details.some(item => String(item.target_type || item.targetType || '').toLowerCase() === 'store'))) {
      allocations = details
        .filter(item => String(item.target_type || item.targetType || 'store').toLowerCase() === 'store')
        .map(item => ({ storeId: String(item.target_id || item.targetId || ''), storeName: item.target_name || item.targetName || '', amount: amount(item.amount) }))
        .filter(item => item.storeId);
    } else if (type === 'COMPANY' && details.some(item => String(item.target_type || item.targetType || '').toLowerCase() === 'distributor')) {
      const target = details.find(item => String(item.target_type || item.targetType || '').toLowerCase() === 'distributor');
      const distributorId = String(target.target_id || target.targetId || row.distributorId || '');
      const allStores = storesByDistributor.get(distributorId) || [];
      distributorExpense = allStores.length > 0 && allStores.every(id => selectedStoreIds.includes(id));
      if (distributorExpense) allocations = [{ storeId: '', storeName: target.target_name || target.targetName || '公司费用', amount: expenseAmount }];
    } else if (row.sourceStoreId) {
      // Product side costs have no store allocation target; preserve their established source-store reporting.
      allocations = [{ storeId: String(row.sourceStoreId), storeName: storeNameMap.get(String(row.sourceStoreId)) || '', amount: expenseAmount }];
    }

    const selectedAllocations = allocations.filter(item => !item.storeId || selectedStoreIds.includes(item.storeId));
    if (!selectedAllocations.length) return;
    const allocatedTotal = amount(selectedAllocations.reduce((sum, item) => sum + item.amount, 0));
    if (allocatedTotal <= 0) return;
    total += allocatedTotal;
    countedExpenses.add(String(row.expenseId));

    const typeSummary = byType.get(row.expenseType || '其他') || { amount: 0, expenseIds: new Set() };
    typeSummary.amount += allocatedTotal;
    typeSummary.expenseIds.add(String(row.expenseId));
    byType.set(row.expenseType || '其他', typeSummary);

    selectedAllocations.filter(item => item.storeId).forEach(item => {
      const storeSummary = byStore.get(item.storeId) || { storeId: item.storeId, storeName: item.storeName || storeNameMap.get(item.storeId) || item.storeId, amount: 0, expenseIds: new Set() };
      storeSummary.amount += item.amount;
      storeSummary.expenseIds.add(String(row.expenseId));
      byStore.set(item.storeId, storeSummary);

      const storeTypeKey = `${item.storeId}\u0000${row.expenseType || '其他'}`;
      const storeTypeSummary = byStoreType.get(storeTypeKey) || {
        storeId: item.storeId,
        storeName: item.storeName || storeNameMap.get(item.storeId) || item.storeId,
        expenseType: row.expenseType || '其他',
        amount: 0,
        expenseIds: new Set()
      };
      storeTypeSummary.amount += item.amount;
      storeTypeSummary.expenseIds.add(String(row.expenseId));
      byStoreType.set(storeTypeKey, storeTypeSummary);
    });
  });

  return {
    amount: amount(total),
    expenseCount: countedExpenses.size,
    byType: [...byType.entries()].map(([expenseType, row]) => ({ expenseType, amount: amount(row.amount), expenseCount: row.expenseIds.size })).sort((a, b) => b.amount - a.amount),
    byStore: [...byStore.values()].map(row => ({ storeId: row.storeId, storeName: row.storeName, amount: amount(row.amount), expenseCount: row.expenseIds.size })).sort((a, b) => b.amount - a.amount),
    byStoreType: [...byStoreType.values()].map(row => ({
      storeId: row.storeId,
      storeName: row.storeName,
      expenseType: row.expenseType,
      amount: amount(row.amount),
      expenseCount: row.expenseIds.size
    })).sort((a, b) => a.storeId.localeCompare(b.storeId) || a.expenseType.localeCompare(b.expenseType, 'zh-CN'))
  };
}

module.exports = { summarizeAllocatedExpenses };
