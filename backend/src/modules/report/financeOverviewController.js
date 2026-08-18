const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { RealtimeSqlDashboardDataSource } = require('./dashboardDataSource');
const { buildRanges, summarizeTrend, canViewProfit } = require('./dashboardService');

const dataSource = new RealtimeSqlDashboardDataSource();
const PAYMENT_SOURCE_TYPES = ['purchase', 'purchase_adjustment', 'purchase_return', 'expense', 'reimbursement'];

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function chinaToday() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function resolvePeriod(query = {}) {
  const periodType = ['day', 'month', 'year'].includes(query.periodType) ? query.periodType : 'month';
  const date = String(query.date || query.endDate || chinaToday()).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    const error = new Error('日期格式不正确');
    error.status = 400;
    throw error;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (periodType === 'day') return { periodType, date, startDate: date, endDate: date };
  if (periodType === 'year') {
    return {
      periodType,
      date,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`
    };
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodType,
    date,
    startDate: `${year}-${String(month).padStart(2, '0')}-01`,
    endDate: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  };
}

async function resolveStoreIds(user, regionId, storeId) {
  let storeIds = user?.accessibleStoreIds || [];
  if (storeIds.includes('*')) {
    const rows = await dataSource.query(
      'SELECT STORE_ID AS storeId FROM T_STORE WHERE IS_DELETED = 0 AND STATUS = 1'
    );
    storeIds = rows.map(row => String(row.storeId));
  } else {
    storeIds = storeIds.map(String).filter(Boolean);
  }

  if (storeId && !storeIds.includes(String(storeId))) {
    const error = new Error('无权访问该门店');
    error.status = 403;
    throw error;
  }

  if (regionId) {
    const rows = await dataSource.query(
      `SELECT STORE_ID AS storeId
         FROM T_STORE
        WHERE IS_DELETED = 0 AND STATUS = 1
          AND REGION_ID = :regionId
          AND STORE_ID IN (:storeIds)`,
      { regionId: String(regionId), storeIds: storeIds.length ? storeIds : ['__NO_STORE__'] }
    );
    storeIds = rows.map(row => String(row.storeId));
  }
  if (storeId) storeIds = storeIds.filter(id => id === String(storeId));
  return storeIds;
}

async function resolveAccessibleRegionIds(user, storeIds) {
  if (user?.accessibleStoreIds?.includes('*')) return null;
  if (!storeIds.length) return [];
  const rows = await dataSource.query(
    `SELECT DISTINCT REGION_ID AS regionId
       FROM T_STORE
      WHERE IS_DELETED = 0 AND STATUS = 1
        AND STORE_ID IN (:storeIds)
        AND REGION_ID IS NOT NULL`,
    { storeIds }
  );
  return rows.map(row => String(row.regionId)).filter(Boolean);
}

async function queryAccountSummary(regionId, accessibleRegionIds) {
  const regionClause = regionId
    ? 'AND sa.REGION_ID = :regionId'
    : accessibleRegionIds
      ? 'AND (sa.REGION_ID IN (:accessibleRegionIds) OR sa.REGION_ID IS NULL)'
      : '';
  const replacements = regionId
    ? { regionId }
    : accessibleRegionIds
      ? { accessibleRegionIds: accessibleRegionIds.length ? accessibleRegionIds : ['__NO_REGION__'] }
      : {};
  const accounts = await sequelize.query(
    `SELECT sa.ACCOUNT_ID AS accountId,
            sa.ACCOUNT_NAME AS accountName,
            sa.ACCOUNT_TYPE AS accountType,
            ROUND(COALESCE(SUM(CASE WHEN sat.TYPE = 'income' THEN sat.AMOUNT ELSE -sat.AMOUNT END), 0), 2) AS balance
       FROM T_SETTLEMENT_ACCOUNT sa
       LEFT JOIN T_SETTLEMENT_ACCOUNT_TRANSACTION sat ON sat.ACCOUNT_ID = sa.ACCOUNT_ID
      WHERE sa.STATUS = 1 ${regionClause}
      GROUP BY sa.ACCOUNT_ID, sa.ACCOUNT_NAME, sa.ACCOUNT_TYPE
      ORDER BY sa.SORT_ORDER ASC, sa.ACCOUNT_ID ASC`,
    { replacements, type: QueryTypes.SELECT }
  );

  const policyIds = accounts.filter(row => row.accountType === 'POLICY_RECEIVABLE').map(row => row.accountId);
  if (policyIds.length) {
    const outstanding = await sequelize.query(
      `SELECT SETTLEMENT_ACCOUNT_ID AS accountId,
              ROUND(SUM(GREATEST(AMOUNT - SETTLED, 0)), 2) AS balance
         FROM T_DAILY_STATEMENT_DETAIL
        WHERE SETTLEMENT_ACCOUNT_ID IN (:accountIds)
          AND (BUSINESS_TYPE = 'national_subsidy_receivable'
               OR PAYMENT_METHOD LIKE '国补POS%-政策补贴应收')
        GROUP BY SETTLEMENT_ACCOUNT_ID`,
      { replacements: { accountIds: policyIds }, type: QueryTypes.SELECT }
    );
    const outstandingMap = new Map(outstanding.map(row => [String(row.accountId), toNumber(row.balance)]));
    accounts.forEach(row => {
      if (row.accountType === 'POLICY_RECEIVABLE') row.balance = outstandingMap.get(String(row.accountId)) || 0;
    });
  }

  const typeNames = {
    FUND: '资金账户',
    POLICY_RECEIVABLE: '政策补贴应收',
    CARE_CREDIT: 'Care可用金',
    SUPPLIER_REBATE: '厂商返利'
  };
  const byType = new Map();
  accounts.forEach(row => {
    const name = typeNames[row.accountType] || row.accountName || '其他账户';
    byType.set(name, roundMoney((byType.get(name) || 0) + toNumber(row.balance)));
  });
  return {
    totalAmount: roundMoney(accounts.reduce((sum, row) => sum + toNumber(row.balance), 0)),
    byType: [...byType.entries()].map(([name, amount]) => ({ name, amount })),
    accounts: accounts.map(row => ({
      accountId: row.accountId,
      accountName: row.accountName,
      accountType: row.accountType,
      balance: roundMoney(row.balance)
    }))
  };
}

async function queryPaymentSummary(regionId, accessibleRegionIds) {
  const regionClause = regionId
    ? 'AND p.REGION_ID = :regionId'
    : accessibleRegionIds
      ? 'AND p.REGION_ID IN (:accessibleRegionIds)'
      : '';
  const settlementRegionClause = regionId
    ? 'AND s.REGION_ID = :regionId'
    : accessibleRegionIds
      ? 'AND s.REGION_ID IN (:accessibleRegionIds)'
      : '';
  const replacements = {
    sourceTypes: PAYMENT_SOURCE_TYPES,
    ...(regionId ? { regionId } : {}),
    ...(accessibleRegionIds ? { accessibleRegionIds: accessibleRegionIds.length ? accessibleRegionIds : ['__NO_REGION__'] } : {})
  };
  const [uncreatedRows, settlementRows] = await Promise.all([
    sequelize.query(
      `SELECT ROUND(SUM(GREATEST(
                p.TOTAL_AMOUNT - COALESCE(p.OFFSET_AMOUNT, 0) - COALESCE(p.PAID_AMOUNT, 0)
                - COALESCE(a.ALLOCATED_AMOUNT, 0), 0)), 2) AS amount
         FROM T_PAYABLE p
         LEFT JOIN (
           SELECT si.PAYABLE_ID, SUM(si.AMOUNT) AS ALLOCATED_AMOUNT
             FROM T_SETTLEMENT_ITEM si
             INNER JOIN T_SETTLEMENT s ON s.SETTLEMENT_ID = si.SETTLEMENT_ID
            WHERE s.IS_DELETED = 0 AND s.STATUS <> 'voided'
            GROUP BY si.PAYABLE_ID
         ) a ON a.PAYABLE_ID = p.PAYABLE_ID
        WHERE p.SOURCE_TYPE IN (:sourceTypes)
          AND p.STATUS NOT IN ('paid', 'offset', 'cancelled')
          ${regionClause}`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT ROUND(SUM(CASE WHEN s.PAYMENT_STATUS IN ('unpaid', 'partial_paid')
                            THEN GREATEST(s.TOTAL_AMOUNT - COALESCE(s.PAID_AMOUNT, 0), 0) ELSE 0 END), 2) AS createdAmount,
              ROUND(SUM(COALESCE(s.PAID_AMOUNT, 0)), 2) AS paidAmount
         FROM T_SETTLEMENT s
        WHERE s.IS_DELETED = 0
          AND s.STATUS <> 'voided'
          AND s.SETTLEMENT_TYPE IN ('supplier', 'expense', 'reimbursement')
          ${settlementRegionClause}`,
      { replacements, type: QueryTypes.SELECT }
    )
  ]);
  const uncreated = roundMoney(uncreatedRows[0]?.amount);
  const created = roundMoney(settlementRows[0]?.createdAmount);
  const paid = roundMoney(settlementRows[0]?.paidAmount);
  return { all: roundMoney(uncreated + created + paid), uncreated, created, paid };
}

async function getFinanceOverview(ctx) {
  const user = ctx.state.user;
  const period = resolvePeriod(ctx.query);
  const regionId = String(ctx.query.regionId || '').trim();
  const storeId = String(ctx.query.storeId || '').trim();
  const storeIds = await resolveStoreIds(user, regionId, storeId);
  if (!storeIds.length) {
    ctx.body = {
      code: 0,
      data: {
        period,
        revenue: 0,
        grossProfit: null,
        grossMargin: null,
        inventory: { totalAmount: 0, categories: [] },
        accounts: { totalAmount: 0, byType: [], accounts: [] },
        payments: { all: 0, uncreated: 0, created: 0, paid: 0 }
      }
    };
    return;
  }
  const accessibleRegionIds = await resolveAccessibleRegionIds(user, storeIds);

  const ranges = buildRanges({ startDate: period.startDate, endDate: period.endDate });
  const filters = { storeIds, storeId: storeId || '', employeeId: '', productLine: '' };
  const [trendRows, inventory, accounts, payments] = await Promise.all([
    dataSource.getTrend(filters, ranges.current, 'day'),
    dataSource.getInventory(filters),
    queryAccountSummary(regionId, accessibleRegionIds),
    queryPaymentSummary(regionId, accessibleRegionIds)
  ]);
  const summary = summarizeTrend(trendRows);
  const profitVisible = canViewProfit(user);

  ctx.body = {
    code: 0,
    data: {
      period,
      regionId,
      revenue: roundMoney(summary.salesAmount),
      grossProfit: profitVisible ? roundMoney(summary.grossProfit) : null,
      grossMargin: profitVisible && summary.salesAmount ? Number(((summary.grossProfit / summary.salesAmount) * 100).toFixed(2)) : null,
      inventory: {
        totalAmount: profitVisible ? roundMoney(inventory.inventoryAmount) : null,
        categories: profitVisible ? inventory.categories : []
      },
      accounts,
      payments
    }
  };
}

module.exports = { getFinanceOverview };
