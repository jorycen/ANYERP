const { QueryTypes, Op } = require('sequelize');
const {
  sequelize,
  MonthlyTask,
  MonthlyTaskProductBatch,
  MonthlyTaskProduct,
  MonthlyTaskGrossProfitAllocation,
  Store,
  Staff,
  StaffStorePermission
} = require('../../models');
const { resolveReportStoreIds } = require('../../utils/storePermissions');
const { normalizeParticipants } = require('./dashboardDataSource');
const { canViewProfit } = require('./dashboardService');

const ARCHIVED_STATUSES = ['已归档', 'completed', 'archived', 'returned'];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return Number(number(value).toFixed(2));
}

function monthRange(monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey || ''))) {
    const error = new Error('月份格式不正确');
    error.status = 400;
    throw error;
  }
  const startAt = new Date(`${monthKey}-01T00:00:00.000+08:00`);
  const [year, month] = monthKey.split('-').map(Number);
  const endAt = new Date(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01T00:00:00.000+08:00`);
  return { startAt, endAt };
}

async function resolveStores(user, requestedStoreId) {
  let storeIds = await resolveReportStoreIds(user);
  if (storeIds.includes('*')) {
    const rows = await Store.findAll({ where: { distributor_id: user.distributorId, is_deleted: 0, status: 1 }, attributes: ['store_id'], raw: true });
    storeIds = rows.map(row => String(row.store_id));
  } else {
    storeIds = storeIds.map(String);
  }
  if (requestedStoreId) {
    if (!storeIds.includes(String(requestedStoreId))) {
      const error = new Error('无权访问该门店任务达成');
      error.status = 403;
      throw error;
    }
    storeIds = [String(requestedStoreId)];
  }
  return storeIds;
}

function createActual() {
  return { salesAmount: 0, grossProfit: 0, productQuantities: new Map() };
}

function addProductQuantity(actual, productId, quantity) {
  if (!productId) return;
  actual.productQuantities.set(String(productId), number(actual.productQuantities.get(String(productId))) + number(quantity));
}

function addActual(actual, salesAmount, grossProfit, productId, quantity) {
  actual.salesAmount += number(salesAmount);
  actual.grossProfit += number(grossProfit);
  addProductQuantity(actual, productId, quantity);
}

function employeeKey(staffId, name) {
  return staffId ? `id:${staffId}` : `name:${String(name || '').trim()}`;
}

async function loadActuals(storeIds, startAt, endAt) {
  if (!storeIds.length) return { storeActuals: new Map(), employeeActuals: new Map() };
  const replacements = { storeIds, startAt, endAt, archivedStatuses: ARCHIVED_STATUSES };
  const orderRows = await sequelize.query(`
    SELECT o.ORDER_ID AS orderId,
           o.ORDER_NO AS orderNo,
           o.STORE_ID AS storeId,
           o.CREATE_TIME AS createTime,
           o.CREATE_STAFF_ID AS createStaffId,
           o.CREATE_USER AS createUser,
           o.AUXILIARY_SALES_LIST AS auxiliarySalesList,
           o.TOTAL_AMOUNT AS orderTotalAmount,
           oi.PRODUCT_ID AS productId,
           oi.PRODUCT_NAME AS productName,
           oi.QUANTITY AS quantity,
           oi.SUBTOTAL AS subtotal,
           CASE WHEN gp.GROSS_PROFIT_ID IS NOT NULL
                THEN COALESCE(gp.GROSS_PROFIT_AMOUNT, 0) * COALESCE(oi.SUBTOTAL, 0) / NULLIF(o.TOTAL_AMOUNT, 0)
                ELSE COALESCE(oi.SALES_GROSS_PROFIT, 0)
           END AS itemGrossProfit
      FROM T_ORDER o
      INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
      LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID
        AND gp.FORMULA_VERSION = 'ORDER_GP_V5_20260706'
     WHERE o.IS_DELETED = 0
       AND o.ORDER_STATUS IN (:archivedStatuses)
       AND o.STORE_ID IN (:storeIds)
       AND o.CREATE_TIME >= :startAt
       AND o.CREATE_TIME < :endAt
     ORDER BY o.CREATE_TIME ASC, o.ORDER_ID ASC, oi.ITEM_ID ASC`, replacements, { type: QueryTypes.SELECT });

  const storeActuals = new Map();
  const employeeActuals = new Map();
  const orders = new Map();
  for (const row of orderRows) {
    const order = orders.get(String(row.orderId)) || { ...row, create_staff_id: row.createStaffId, create_user: row.createUser, auxiliary_sales_list: row.auxiliarySalesList, items: [] };
    order.items.push(row);
    orders.set(String(row.orderId), order);
  }
  for (const order of orders.values()) {
    const participants = normalizeParticipants(order);
    const participantCount = participants.length || 1;
    const storeActual = storeActuals.get(String(order.storeId)) || createActual();
    order.items.forEach(item => addActual(storeActual, item.subtotal, item.itemGrossProfit, item.productId, item.quantity));
    storeActuals.set(String(order.storeId), storeActual);
    participants.forEach(participant => {
      const key = employeeKey(participant.staffId, participant.name);
      const actual = employeeActuals.get(key) || { ...createActual(), staffId: participant.staffId, employeeName: participant.name, storeIds: new Set() };
      actual.storeIds.add(String(order.storeId));
      order.items.forEach(item => addActual(actual, number(item.subtotal) / participantCount, number(item.itemGrossProfit) / participantCount, item.productId, number(item.quantity) / participantCount));
      employeeActuals.set(key, actual);
    });
  }

  const adjustmentRows = await sequelize.query(`
    SELECT pa.ORDER_ID AS orderId, SUM(pa.SIGNED_AMOUNT) AS signedAmount, o.STORE_ID AS storeId
      FROM T_PERFORMANCE_PROFIT_ADJUSTMENT pa
      INNER JOIN T_ORDER o ON o.ORDER_ID = pa.ORDER_ID
     WHERE pa.STATUS = 'approved'
       AND o.IS_DELETED = 0
       AND o.ORDER_STATUS IN (:archivedStatuses)
       AND o.STORE_ID IN (:storeIds)
       AND o.CREATE_TIME >= :startAt
       AND o.CREATE_TIME < :endAt
     GROUP BY pa.ORDER_ID, o.STORE_ID`, replacements, { type: QueryTypes.SELECT });
  for (const row of adjustmentRows) {
    const storeActual = storeActuals.get(String(row.storeId)) || createActual();
    storeActual.grossProfit += number(row.signedAmount);
    storeActuals.set(String(row.storeId), storeActual);
    const order = orders.get(String(row.orderId));
    const participants = order ? normalizeParticipants(order) : [];
    const count = participants.length || 1;
    participants.forEach(participant => {
      const key = employeeKey(participant.staffId, participant.name);
      const actual = employeeActuals.get(key) || { ...createActual(), staffId: participant.staffId, employeeName: participant.name, storeIds: new Set() };
      actual.grossProfit += number(row.signedAmount) / count;
      employeeActuals.set(key, actual);
    });
  }

  const returnItems = await sequelize.query(`
    SELECT srs.ORDER_ID AS orderId,
           srs.STORE_ID AS storeId,
           o.CREATE_STAFF_ID AS createStaffId,
           o.CREATE_USER AS createUser,
           o.AUXILIARY_SALES_LIST AS auxiliarySalesList,
           sri.PRODUCT_ID AS productId,
           sri.QUANTITY AS quantity,
           sri.USER_RECEIVABLE_AMOUNT AS salesAmount
      FROM T_SALES_RETURN_SETTLEMENT srs
      INNER JOIN T_SALES_RETURN_SETTLEMENT_ITEM sri ON sri.SETTLEMENT_ID = srs.SETTLEMENT_ID
      LEFT JOIN T_ORDER o ON o.ORDER_ID = srs.ORDER_ID
     WHERE srs.STORE_ID IN (:storeIds)
       AND srs.CREATE_TIME >= :startAt
       AND srs.CREATE_TIME < :endAt`, replacements, { type: QueryTypes.SELECT });
  for (const row of returnItems) {
    const storeActual = storeActuals.get(String(row.storeId)) || createActual();
    addActual(storeActual, row.salesAmount, 0, row.productId, row.quantity);
    storeActuals.set(String(row.storeId), storeActual);
    const order = orders.get(String(row.orderId)) || {
      create_staff_id: row.createStaffId,
      create_user: row.createUser,
      auxiliary_sales_list: row.auxiliarySalesList
    };
    const participants = order ? normalizeParticipants(order) : [];
    const count = participants.length || 1;
    participants.forEach(participant => {
      const key = employeeKey(participant.staffId, participant.name);
      const actual = employeeActuals.get(key) || { ...createActual(), staffId: participant.staffId, employeeName: participant.name, storeIds: new Set() };
      actual.storeIds.add(String(row.storeId));
      addProductQuantity(actual, row.productId, number(row.quantity) / count);
      employeeActuals.set(key, actual);
    });
  }

  const returnLedgerRows = await sequelize.query(`
    SELECT STORE_ID AS storeId,
           STAFF_ID AS staffId,
           EMPLOYEE_NAME AS employeeName,
           RETURNED_SALES_AMOUNT AS salesAmount,
           GROSS_PROFIT_AMOUNT AS grossProfitAmount
      FROM T_SALES_RETURN_GROSS_PROFIT
     WHERE STORE_ID IN (:storeIds)
       AND CREATE_TIME >= :startAt
       AND CREATE_TIME < :endAt`, replacements, { type: QueryTypes.SELECT });
  for (const row of returnLedgerRows) {
    const key = employeeKey(row.staffId, row.employeeName);
    const actual = employeeActuals.get(key) || { ...createActual(), staffId: row.staffId ? String(row.staffId) : null, employeeName: row.employeeName || '', storeIds: new Set() };
    actual.storeIds.add(String(row.storeId));
    actual.salesAmount += number(row.salesAmount);
    actual.grossProfit += number(row.grossProfitAmount);
    employeeActuals.set(key, actual);
    const storeActual = storeActuals.get(String(row.storeId)) || createActual();
    storeActual.grossProfit += number(row.grossProfitAmount);
    storeActuals.set(String(row.storeId), storeActual);
  }
  return { storeActuals, employeeActuals };
}

function rate(actual, target) {
  const goal = number(target);
  return goal > 0 ? Number(((number(actual) / goal) * 100).toFixed(2)) : null;
}

function buildAchievement({ task, actual, grossProfitTarget, name, storeId, storeName, allocationTotal = null, profitVisible = true }) {
  const metrics = [];
  const sales = { actual: money(actual.salesAmount), target: money(task.salesTarget), rate: rate(actual.salesAmount, task.salesTarget) };
  const grossProfit = profitVisible
    ? { actual: money(actual.grossProfit), target: money(grossProfitTarget), rate: rate(actual.grossProfit, grossProfitTarget) }
    : { actual: null, target: null, rate: null };
  if (sales.target > 0) metrics.push(sales.rate);
  if (profitVisible && grossProfit.target > 0) metrics.push(grossProfit.rate);
  const productBatches = (task.productBatches || []).map(batch => {
    const products = (batch.products || []).map(product => ({
      productId: product.productId,
      productName: product.productName,
      targetQuantity: Number(product.targetQuantity || 0),
      actualQuantity: Number(number(actual.productQuantities.get(String(product.productId))).toFixed(2)),
      rate: rate(actual.productQuantities.get(String(product.productId)), product.targetQuantity)
    }));
    const rates = products.map(product => product.rate).filter(value => value !== null);
    const batchRate = rates.length ? Number(Math.min(...rates).toFixed(2)) : null;
    if (batchRate !== null) metrics.push(batchRate);
    return { batchId: batch.batchId, batchName: batch.batchName, rate: batchRate, products };
  });
  const overallRate = metrics.length ? Number((metrics.reduce((sum, value) => sum + number(value), 0) / metrics.length).toFixed(2)) : null;
  return {
    targetType: task.targetType,
    targetId: String(task.targetId),
    targetName: name,
    storeId: storeId || '',
    storeName: storeName || '',
    overallRate,
    status: overallRate === null ? '未设置目标' : (overallRate >= 100 ? '已达成' : '进行中'),
    sales,
    grossProfit,
    productBatches,
    unallocatedGrossProfit: allocationTotal === null ? 0 : money(number(grossProfitTarget) - number(allocationTotal))
  };
}

function summarizeAchievements(rows, profitVisible) {
  const salesActual = rows.reduce((sum, row) => sum + number(row.sales?.actual), 0);
  const salesTarget = rows.reduce((sum, row) => sum + number(row.sales?.target), 0);
  const grossActual = rows.reduce((sum, row) => sum + number(row.grossProfit?.actual), 0);
  const grossTarget = rows.reduce((sum, row) => sum + number(row.grossProfit?.target), 0);
  return {
    taskCount: rows.length,
    sales: {
      actual: money(salesActual),
      target: money(salesTarget),
      rate: rate(salesActual, salesTarget)
    },
    grossProfit: profitVisible
      ? {
          actual: money(grossActual),
          target: money(grossTarget),
          rate: rate(grossActual, grossTarget)
        }
      : { actual: null, target: null, rate: null }
  };
}

async function getMonthlyTaskAchievement(ctx) {
  const user = ctx.state.user;
  const profitVisible = canViewProfit(user);
  const monthKey = String(ctx.query.monthKey || ctx.query.month_key || '').trim() || new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const storeIds = await resolveStores(user, ctx.query.storeId || ctx.query.store_id);
  const { startAt, endAt } = monthRange(monthKey);
  if (!storeIds.length) {
    ctx.body = { code: 0, data: { monthKey, stores: [], employees: [] } };
    return;
  }
  const [stores, tasks, staffRows, permissions, allocations, batches, products, actuals] = await Promise.all([
    Store.findAll({ where: { store_id: { [Op.in]: storeIds }, is_deleted: 0, status: 1 }, attributes: ['store_id', 'name'], raw: true }),
    MonthlyTask.findAll({ where: { distributor_id: user.distributorId, month_key: monthKey, status: 1 }, raw: true }),
    Staff.findAll({ where: { distributor_id: user.distributorId, is_deleted: 0, status: 1 }, attributes: ['staff_id', 'name', 'store_id'], raw: true }),
    StaffStorePermission.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['staff_id', 'store_id'], raw: true }),
    MonthlyTaskGrossProfitAllocation.findAll({ raw: true }),
    MonthlyTaskProductBatch.findAll({ raw: true }),
    MonthlyTaskProduct.findAll({ raw: true }),
    loadActuals(storeIds, startAt, endAt)
  ]);
  const storeMap = new Map(stores.map(row => [String(row.store_id), row]));
  const staffMap = new Map(staffRows.map(row => [String(row.staff_id), row]));
  const visibleStaffIds = new Set(permissions.map(row => String(row.staff_id)));
  staffRows.forEach(row => {
    if (row.store_id && storeIds.includes(String(row.store_id))) visibleStaffIds.add(String(row.staff_id));
  });
  const batchesByTask = new Map();
  const productsByBatch = new Map();
  products.forEach(row => {
    const list = productsByBatch.get(String(row.batch_id)) || [];
    list.push({ productId: row.product_id, productName: row.product_name, targetQuantity: Number(row.target_quantity || 0) });
    productsByBatch.set(String(row.batch_id), list);
  });
  batches.forEach(row => {
    if (!tasks.some(task => String(task.task_id) === String(row.task_id))) return;
    const list = batchesByTask.get(String(row.task_id)) || [];
    list.push({ batchId: row.batch_id, batchName: row.batch_name, products: productsByBatch.get(String(row.batch_id)) || [] });
    batchesByTask.set(String(row.task_id), list);
  });
  const taskMap = new Map(tasks.map(task => [String(task.task_id), { ...task, targetId: String(task.target_id), targetType: task.target_type, salesTarget: task.sales_target, grossProfitTarget: task.gross_profit_target, productBatches: batchesByTask.get(String(task.task_id)) || [] }]));
  const visibleTasks = tasks.filter(task => task.target_type === 'store'
    ? storeMap.has(String(task.target_id))
    : visibleStaffIds.has(String(task.target_id)));
  const allocationMap = new Map();
  const allocationTotalByTask = new Map();
  allocations.forEach(row => {
    const task = taskMap.get(String(row.task_id));
    if (!task || task.targetType !== 'store' || !storeMap.has(String(task.targetId))) return;
    const list = allocationMap.get(String(row.staff_id)) || [];
    list.push({ task, allocatedTarget: money(row.allocated_target) });
    allocationMap.set(String(row.staff_id), list);
    allocationTotalByTask.set(String(row.task_id), number(allocationTotalByTask.get(String(row.task_id))) + money(row.allocated_target));
  });
  const storesResult = visibleTasks.filter(task => task.target_type === 'store').map(task => buildAchievement({
    task,
    actual: actuals.storeActuals.get(String(task.target_id)) || createActual(),
    grossProfitTarget: task.gross_profit_target,
    name: storeMap.get(String(task.target_id))?.name || task.target_id,
    storeId: task.target_id,
    storeName: storeMap.get(String(task.target_id))?.name || '',
    allocationTotal: allocationTotalByTask.get(String(task.task_id)) || 0,
    profitVisible
  }));
  const selectedStaffId = ctx.query.staffId || ctx.query.staff_id;
  const employeesResult = visibleTasks.filter(task => task.target_type === 'staff' && (!selectedStaffId || String(task.target_id) === String(selectedStaffId))).map(task => {
    const staff = staffMap.get(String(task.target_id));
    const allocationsForStaff = allocationMap.get(String(task.target_id)) || [];
    const allocated = allocationsForStaff.reduce((sum, row) => sum + row.allocatedTarget, 0);
    const grossTarget = number(task.gross_profit_target) > 0 ? task.gross_profit_target : allocated;
    const actual = actuals.employeeActuals.get(employeeKey(task.target_id, staff?.name))
      || actuals.employeeActuals.get(employeeKey('', staff?.name))
      || createActual();
    return buildAchievement({ task, actual, grossProfitTarget: grossTarget, name: staff?.name || task.target_id, storeId: staff?.store_id || '', storeName: storeMap.get(String(staff?.store_id || ''))?.name || '', profitVisible });
  });
  const sort = (left, right) => (number(right.overallRate) - number(left.overallRate)) || (number(right.sales.actual) - number(left.sales.actual)) || String(left.targetName).localeCompare(String(right.targetName), 'zh-CN');
  storesResult.sort(sort);
  employeesResult.sort(sort);
  ctx.body = {
    code: 0,
    data: {
      monthKey,
      meta: {
        source: 'monthly_tasks',
        canViewProfit: profitVisible,
        calculation: 'ANY-ERP 按自然月实时汇总已归档销售与已完成退货，前端只负责展示'
      },
      summary: {
        stores: summarizeAchievements(storesResult, profitVisible),
        employees: summarizeAchievements(employeesResult, profitVisible)
      },
      stores: storesResult,
      employees: employeesResult,
      updatedAt: new Date().toISOString()
    }
  };
}

module.exports = { getMonthlyTaskAchievement };
