const {
  MonthlyTask,
  MonthlyTaskProductBatch,
  MonthlyTaskProduct,
  MonthlyTaskGrossProfitAllocation,
  Store,
  Staff,
  StaffStorePermission,
  Product,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { getUserRoles } = require('../../middleware/permission');
const { resolveReportStoreIds, resolveAllReadableStoreIds } = require('../../utils/storePermissions');
const { recordBusinessAction } = require('../../utils/businessActionLog');

function currentMonthKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '').trim());
}

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function taskPayload(row) {
  return {
    taskId: row.task_id,
    monthKey: row.month_key,
    targetType: row.target_type,
    targetId: String(row.target_id),
    targetName: row.targetName || '',
    storeId: row.storeId || '',
    storeName: row.storeName || '',
    salesTarget: money(row.sales_target),
    grossProfitTarget: money(row.gross_profit_target),
    productBatches: row.productBatches || [],
    grossProfitAllocations: row.grossProfitAllocations || [],
    allocationTotal: money((row.grossProfitAllocations || []).reduce((sum, item) => sum + money(item.allocatedTarget), 0)),
    status: Number(row.status || 0) === 1 ? 'active' : 'disabled',
    createUser: row.create_user || '',
    updateUser: row.update_user || '',
    updateTime: row.update_time || null
  };
}

async function visibleStoreIds(user, forManage = false) {
  const roles = getUserRoles(user);
  const canManageAllStores = roles.includes('boss') || roles.includes('admin');
  const raw = forManage && canManageAllStores
    ? await resolveAllReadableStoreIds(user)
    : await resolveReportStoreIds(user);
  if (raw.includes('*')) {
    const rows = await Store.findAll({
      where: { distributor_id: user.distributorId, is_deleted: 0, status: 1 },
      attributes: ['store_id'],
      raw: true
    });
    return rows.map(row => String(row.store_id));
  }
  return raw.map(String);
}

async function assertTargetScope(user, targetType, targetId) {
  const storeIds = await visibleStoreIds(user, true);
  if (targetType === 'store') {
    const store = await Store.findOne({
      where: { store_id: String(targetId), distributor_id: user.distributorId, is_deleted: 0, status: 1 }
    });
    if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 400 });
    if (!storeIds.includes(String(store.store_id))) throw Object.assign(new Error('无权配置该门店任务'), { status: 403 });
    return { store, staff: null };
  }
  if (targetType !== 'staff') throw Object.assign(new Error('任务对象类型不正确'), { status: 400 });
  const staff = await Staff.findOne({
    where: { staff_id: String(targetId), distributor_id: user.distributorId, is_deleted: 0, status: 1 },
    raw: true
  });
  if (!staff) throw Object.assign(new Error('员工不存在或已停用'), { status: 400 });
  const staffStoreIds = new Set();
  if (staff.store_id) staffStoreIds.add(String(staff.store_id));
  const permissionRows = await StaffStorePermission.findAll({
    where: { staff_id: staff.staff_id, store_id: { [Op.in]: storeIds.length ? storeIds : ['__NO_STORE__'] } },
    attributes: ['store_id'],
    raw: true
  });
  permissionRows.forEach(row => staffStoreIds.add(String(row.store_id)));
  if (storeIds.length && ![...staffStoreIds].some(storeId => storeIds.includes(storeId))) {
    throw Object.assign(new Error('无权配置该员工任务'), { status: 403 });
  }
  return { store: null, staff };
}

async function loadTaskRows(user, monthKey, includeDisabled = false) {
  const storeIds = await visibleStoreIds(user, false);
  if (!storeIds.length) return [];
  const [tasks, staffRows, permissionRows] = await Promise.all([
    MonthlyTask.findAll({
      where: {
        distributor_id: user.distributorId,
        month_key: monthKey,
        ...(includeDisabled ? {} : { status: 1 })
      },
      order: [['target_type', 'ASC'], ['target_id', 'ASC']],
      raw: true
    }),
    Staff.findAll({
      where: { distributor_id: user.distributorId, is_deleted: 0 },
      attributes: ['staff_id', 'name', 'store_id'],
      raw: true
    }),
    StaffStorePermission.findAll({
      attributes: ['staff_id', 'store_id'],
      where: { store_id: { [Op.in]: storeIds } },
      raw: true
    })
  ]);
  const visibleStaffIds = new Set(permissionRows.map(row => String(row.staff_id)));
  staffRows.forEach(row => {
    if (row.store_id && storeIds.includes(String(row.store_id))) visibleStaffIds.add(String(row.staff_id));
  });
  const stores = await Store.findAll({
    where: { store_id: { [Op.in]: storeIds }, is_deleted: 0, status: 1 },
    attributes: ['store_id', 'name'],
    raw: true
  });
  const storeMap = new Map(stores.map(row => [String(row.store_id), row]));
  const staffMap = new Map(staffRows.map(row => [String(row.staff_id), row]));
  const filtered = tasks.filter(task => task.target_type === 'store'
    ? storeMap.has(String(task.target_id))
    : visibleStaffIds.has(String(task.target_id)));
  if (!filtered.length) return [];
  const taskIds = filtered.map(task => task.task_id);
  const [batches, allocations] = await Promise.all([
    MonthlyTaskProductBatch.findAll({ where: { task_id: { [Op.in]: taskIds } }, order: [['sort_order', 'ASC']], raw: true }),
    MonthlyTaskGrossProfitAllocation.findAll({ where: { task_id: { [Op.in]: taskIds } }, order: [['staff_id', 'ASC']], raw: true })
  ]);
  const safeProducts = batches.length
    ? await MonthlyTaskProduct.findAll({ where: { batch_id: { [Op.in]: batches.map(row => row.batch_id) } }, raw: true })
    : [];
  const productsByBatch = new Map();
  safeProducts.forEach(row => {
    const list = productsByBatch.get(String(row.batch_id)) || [];
    list.push({ productId: row.product_id, productName: row.product_name, targetQuantity: Number(row.target_quantity || 0) });
    productsByBatch.set(String(row.batch_id), list);
  });
  const batchesByTask = new Map();
  batches.forEach(row => {
    const list = batchesByTask.get(String(row.task_id)) || [];
    list.push({ batchId: row.batch_id, batchName: row.batch_name, sortOrder: row.sort_order, products: productsByBatch.get(String(row.batch_id)) || [] });
    batchesByTask.set(String(row.task_id), list);
  });
  const allocationsByTask = new Map();
  allocations.forEach(row => {
    const list = allocationsByTask.get(String(row.task_id)) || [];
    const staff = staffMap.get(String(row.staff_id));
    list.push({ staffId: String(row.staff_id), staffName: staff?.name || '', allocatedTarget: money(row.allocated_target) });
    allocationsByTask.set(String(row.task_id), list);
  });
  return filtered.map(task => {
    const targetId = String(task.target_id);
    const store = task.target_type === 'store' ? storeMap.get(targetId) : null;
    const staff = task.target_type === 'staff' ? staffMap.get(targetId) : null;
    return taskPayload({
      ...task,
      targetName: store?.name || staff?.name || targetId,
      storeId: task.target_type === 'store' ? targetId : (staff?.store_id || ''),
      storeName: task.target_type === 'store' ? (store?.name || '') : (storeMap.get(String(staff?.store_id || ''))?.name || ''),
      productBatches: batchesByTask.get(String(task.task_id)) || [],
      grossProfitAllocations: allocationsByTask.get(String(task.task_id)) || []
    });
  });
}

async function getMonthlyTaskOptions(ctx) {
  const user = ctx.state.user;
  const storeIds = await visibleStoreIds(user, true);
  const stores = await Store.findAll({
    where: { store_id: { [Op.in]: storeIds.length ? storeIds : ['__NO_STORE__'] }, is_deleted: 0, status: 1 },
    attributes: ['store_id', 'name'],
    order: [['name', 'ASC']],
    raw: true
  });
  const staffRows = await Staff.findAll({
    where: { distributor_id: user.distributorId, is_deleted: 0, status: 1 },
    attributes: ['staff_id', 'name', 'store_id'],
    order: [['name', 'ASC']],
    raw: true
  });
  const permissionRows = await StaffStorePermission.findAll({
    where: { store_id: { [Op.in]: storeIds.length ? storeIds : ['__NO_STORE__'] } },
    attributes: ['staff_id'],
    raw: true
  });
  const visibleStaffIds = new Set(permissionRows.map(row => String(row.staff_id)));
  staffRows.forEach(row => { if (row.store_id && storeIds.includes(String(row.store_id))) visibleStaffIds.add(String(row.staff_id)); });
  const staffStoreMap = new Map();
  permissionRows.forEach(row => {
    const list = staffStoreMap.get(String(row.staff_id)) || [];
    list.push(String(row.store_id));
    staffStoreMap.set(String(row.staff_id), list);
  });
  staffRows.forEach(row => {
    if (row.store_id) staffStoreMap.set(String(row.staff_id), [...new Set([...(staffStoreMap.get(String(row.staff_id)) || []), String(row.store_id)])]);
  });
  const products = await Product.findAll({
    where: { is_deleted: 0, status: 1 },
    attributes: ['product_id', 'product_code', 'name'],
    order: [['name', 'ASC']],
    limit: 1000,
    raw: true
  });
  return {
    stores: stores.map(row => ({ storeId: row.store_id, name: row.name })),
    staff: staffRows.filter(row => visibleStaffIds.has(String(row.staff_id))).map(row => ({ staffId: String(row.staff_id), name: row.name, storeId: row.store_id || '', storeIds: staffStoreMap.get(String(row.staff_id)) || [] })),
    products: products.map(row => ({ productId: row.product_id, productCode: row.product_code, name: row.name }))
  };
}

function normalizeBatches(batches) {
  if (!Array.isArray(batches)) return [];
  return batches.map((batch, batchIndex) => {
    const products = Array.isArray(batch.products) ? batch.products : [];
    const seen = new Set();
    return {
      name: String(batch.batchName || batch.name || `批次${batchIndex + 1}`).trim().slice(0, 128),
      sortOrder: batchIndex,
      products: products.map(item => ({
        productId: String(item.productId || item.product_id || '').trim(),
        targetQuantity: positiveInteger(item.targetQuantity ?? item.target_quantity)
      })).filter(item => item.productId && item.targetQuantity > 0 && !seen.has(item.productId) && seen.add(item.productId))
    };
  }).filter(batch => batch.products.length > 0);
}

async function validateAllocations({ taskType, store, allocations, grossProfitTarget, user }) {
  if (taskType !== 'store') return [];
  if (!Array.isArray(allocations)) return [];
  const rows = allocations.map(item => ({ staffId: String(item.staffId || item.staff_id || '').trim(), allocatedTarget: money(item.allocatedTarget ?? item.allocated_target) }))
    .filter(item => item.staffId && item.allocatedTarget > 0);
  if (new Set(rows.map(row => row.staffId)).size !== rows.length) throw Object.assign(new Error('同一员工不能重复分摊毛利目标'), { status: 400 });
  const total = money(rows.reduce((sum, row) => sum + row.allocatedTarget, 0));
  if (total > money(grossProfitTarget)) throw Object.assign(new Error('员工毛利分摊合计不能超过门店毛利目标'), { status: 400 });
  if (!rows.length) return [];
  const storeIds = [String(store.store_id)];
  const staffRows = await Staff.findAll({
    where: { staff_id: { [Op.in]: rows.map(row => row.staffId) }, distributor_id: user.distributorId, is_deleted: 0, status: 1 },
    attributes: ['staff_id', 'store_id'],
    raw: true
  });
  const direct = new Set(staffRows.filter(row => row.store_id && storeIds.includes(String(row.store_id))).map(row => String(row.staff_id)));
  const permissions = await StaffStorePermission.findAll({ where: { staff_id: { [Op.in]: rows.map(row => row.staffId) }, store_id: storeIds }, attributes: ['staff_id'], raw: true });
  permissions.forEach(row => direct.add(String(row.staff_id)));
  if (direct.size !== new Set(rows.map(row => row.staffId)).size) throw Object.assign(new Error('毛利分摊员工必须属于当前门店'), { status: 400 });
  return rows;
}

async function saveMonthlyTask(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  if (ctx.params.taskId) {
    const existingTask = await MonthlyTask.findOne({ where: { task_id: ctx.params.taskId, distributor_id: user.distributorId } });
    if (!existingTask) ctx.throw(404, '月度任务不存在');
    if (body.monthKey && String(body.monthKey) !== String(existingTask.month_key)) ctx.throw(400, '编辑任务不能修改所属月份');
    if (body.targetType && String(body.targetType) !== String(existingTask.target_type)) ctx.throw(400, '编辑任务不能修改任务类型');
    if (body.targetId && String(body.targetId) !== String(existingTask.target_id)) ctx.throw(400, '编辑任务不能修改任务对象');
  }
  const monthKey = String(body.monthKey || body.month_key || '').trim();
  const targetType = String(body.targetType || body.target_type || '').trim();
  const targetId = String(body.targetId || body.target_id || '').trim();
  if (!validMonth(monthKey)) ctx.throw(400, '月份格式不正确');
  if (monthKey < currentMonthKey()) ctx.throw(400, '历史月份任务只读，不能修改');
  if (!targetId) ctx.throw(400, '请选择任务对象');
  const target = await assertTargetScope(user, targetType, targetId);
  const salesTarget = money(body.salesTarget ?? body.sales_target);
  const grossProfitTarget = money(body.grossProfitTarget ?? body.gross_profit_target);
  if (salesTarget < 0 || grossProfitTarget < 0) ctx.throw(400, '任务目标不能为负数');
  const productBatches = normalizeBatches(body.productBatches || body.product_batches);
  const productIds = [...new Set(productBatches.flatMap(batch => batch.products.map(item => item.productId)))];
  if (productIds.length) {
    const count = await Product.count({ where: { product_id: { [Op.in]: productIds }, is_deleted: 0, status: 1 } });
    if (count !== productIds.length) ctx.throw(400, '指定商品中存在无效或已停用商品');
  }
  const allocations = await validateAllocations({ taskType: targetType, store: target.store, allocations: body.grossProfitAllocations || body.gross_profit_allocations, grossProfitTarget, user });
  const transaction = await sequelize.transaction();
  try {
    let task = await MonthlyTask.findOne({ where: { distributor_id: user.distributorId, month_key: monthKey, target_type: targetType, target_id: targetId }, transaction, lock: transaction.LOCK.UPDATE });
    const existed = Boolean(task);
    if (task && Number(task.status || 0) !== 1) ctx.throw(400, '任务已停用，请重新建立任务');
    const oldSnapshot = task ? task.toJSON() : null;
    if (!task) {
      task = await MonthlyTask.create({ task_id: generateUUID(), distributor_id: user.distributorId, month_key: monthKey, target_type: targetType, target_id: targetId, sales_target: salesTarget, gross_profit_target: grossProfitTarget, status: 1, create_staff_id: user.staffId || null, create_user: user.name || user.phone || '', update_staff_id: user.staffId || null, update_user: user.name || user.phone || '' }, { transaction });
    } else {
      await task.update({ sales_target: salesTarget, gross_profit_target: grossProfitTarget, update_staff_id: user.staffId || null, update_user: user.name || user.phone || '', update_time: new Date() }, { transaction });
    }
    await MonthlyTaskProductBatch.destroy({ where: { task_id: task.task_id }, transaction });
    await MonthlyTaskGrossProfitAllocation.destroy({ where: { task_id: task.task_id }, transaction });
    for (const batch of productBatches) {
      const batchRow = await MonthlyTaskProductBatch.create({ batch_id: generateUUID(), task_id: task.task_id, batch_name: batch.name, sort_order: batch.sortOrder, create_time: new Date(), update_time: new Date() }, { transaction });
      const productRows = batch.products.map(item => ({ batch_id: batchRow.batch_id, product_id: item.productId, product_name: '', target_quantity: item.targetQuantity, create_time: new Date() }));
      if (productRows.length) {
        const names = await Product.findAll({ where: { product_id: { [Op.in]: productRows.map(row => row.product_id) } }, attributes: ['product_id', 'name'], raw: true, transaction });
        const nameMap = new Map(names.map(row => [String(row.product_id), row.name]));
        await MonthlyTaskProduct.bulkCreate(productRows.map(row => ({ ...row, product_name: nameMap.get(String(row.product_id)) || row.product_id })), { transaction });
      }
    }
    if (allocations.length) {
      await MonthlyTaskGrossProfitAllocation.bulkCreate(allocations.map(item => ({ allocation_id: generateUUID(), task_id: task.task_id, staff_id: item.staffId, allocated_target: item.allocatedTarget, create_staff_id: user.staffId || null, create_user: user.name || user.phone || '', update_staff_id: user.staffId || null, update_user: user.name || user.phone || '', create_time: new Date(), update_time: new Date() })), { transaction });
    }
    await recordBusinessAction({ businessType: 'monthly_task', businessId: task.task_id, businessNo: `${monthKey}-${targetType}-${targetId}`, action: existed ? 'update' : 'create', user, detail: { before: oldSnapshot, after: { monthKey, targetType, targetId, salesTarget, grossProfitTarget, productBatches, allocations } }, transaction });
    await transaction.commit();
    ctx.body = { code: 0, message: existed ? '月度任务已更新' : '月度任务已保存', data: { taskId: task.task_id } };
  } catch (error) {
    await transaction.rollback();
    if (error.status) ctx.throw(error.status, error.message);
    if (error.name === 'SequelizeUniqueConstraintError') ctx.throw(400, '同一月份和任务对象已存在任务');
    throw error;
  }
}

async function listMonthlyTasks(ctx) {
  const monthKey = String(ctx.query.monthKey || ctx.query.month_key || currentMonthKey()).trim();
  if (!validMonth(monthKey)) ctx.throw(400, '月份格式不正确');
  ctx.body = { code: 0, data: { monthKey, list: await loadTaskRows(ctx.state.user, monthKey) } };
}

async function disableMonthlyTask(ctx) {
  const task = await MonthlyTask.findOne({ where: { task_id: ctx.params.taskId, distributor_id: ctx.state.user.distributorId, status: 1 } });
  if (!task) ctx.throw(404, '月度任务不存在');
  if (task.month_key < currentMonthKey()) ctx.throw(400, '历史月份任务只读，不能停用');
  await assertTargetScope(ctx.state.user, task.target_type, task.target_id);
  await task.update({ status: 0, update_staff_id: ctx.state.user.staffId || null, update_user: ctx.state.user.name || ctx.state.user.phone || '', update_time: new Date() });
  await recordBusinessAction({ businessType: 'monthly_task', businessId: task.task_id, businessNo: `${task.month_key}-${task.target_type}-${task.target_id}`, action: 'disable', fromStatus: 'active', toStatus: 'disabled', user: ctx.state.user });
  ctx.body = { code: 0, message: '月度任务已停用' };
}

module.exports = { getMonthlyTaskOptions, listMonthlyTasks, saveMonthlyTask, disableMonthlyTask, currentMonthKey };
