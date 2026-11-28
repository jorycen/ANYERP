const { DataTypes, Op } = require('sequelize');
const M = require('../../models');
const { resolveReportStoreIds } = require('../../utils/storePermissions');
const { getUserRoles } = require('../../middleware/permission');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const Config = M.sequelize.define('EmployeeCommissionConfig', {
  config_id: { type: DataTypes.STRING(100), primaryKey: true },
  month_key: { type: DataTypes.STRING(7), allowNull: false },
  entity_type: { type: DataTypes.STRING(8), allowNull: false },
  entity_id: { type: DataTypes.STRING(32), allowNull: false },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  updated_by: { type: DataTypes.STRING(64) },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_EMPLOYEE_COMMISSION_CONFIG', timestamps: false });
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function month(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value))) fail('请选择配置月份');
  return value;
}
function canConfigure(user) { return getUserRoles(user).some(x => ['boss', 'admin', 'system_admin'].includes(x)); }
async function scope(user, storeId = '') {
  let ids = await resolveReportStoreIds(user);
  const stores = await M.Store.findAll({ where: { is_deleted: 0, status: 1,
    ...(ids.includes('*') ? {} : { store_id: { [Op.in]: ids } }) }, raw: true });
  ids = stores.map(x => String(x.store_id));
  if (storeId && !ids.includes(String(storeId))) fail('无权访问该门店', 403);
  return stores.filter(x => !storeId || String(x.store_id) === String(storeId));
}
async function options(user, monthKey, storeId = '') {
  month(monthKey);
  const stores = await scope(user, storeId), ids = stores.map(x => x.store_id);
  const staff = ids.length ? await M.sequelize.query(`SELECT s.STAFF_ID staffId,s.NAME employeeName,s.STORE_ID storeId,
    GROUP_CONCAT(DISTINCT COALESCE(r.ROLE_CODE,s.ROLE_CODE)) roles,
    GROUP_CONCAT(DISTINCT COALESCE(r.NAME,s.ROLE_CODE)) roleNames
    FROM T_STAFF s LEFT JOIN T_STAFF_ROLE sr ON sr.STAFF_ID=s.STAFF_ID
    LEFT JOIN T_ROLE r ON r.ROLE_ID=sr.ROLE_ID AND r.STATUS=1
    WHERE s.IS_DELETED=0 AND s.STATUS=1 AND s.STORE_ID IN (:ids)
    GROUP BY s.STAFF_ID,s.NAME,s.STORE_ID`, { replacements: { ids }, type: M.sequelize.QueryTypes.SELECT }) : [];
  const configs = await Config.findAll({ where: { month_key: monthKey, [Op.or]: [
    { entity_type: 'store', entity_id: { [Op.in]: ids } },
    { entity_type: 'staff', entity_id: { [Op.in]: staff.map(x => String(x.staffId)) } }
  ] }, raw: true });
  const find = (type, id) => configs.find(x => x.entity_type === type && x.entity_id === String(id));
  return { month: monthKey, canConfigure: canConfigure(user),
    stores: stores.map(s => ({ storeId: s.store_id, storeName: s.name, managerStaffId: String(s.manager_staff_id || ''),
      breakEvenLine: find('store', s.store_id)?.amount ?? null, revision: find('store', s.store_id)?.revision ?? 0 })),
    employees: staff.map(s => ({ ...s, staffId: String(s.staffId),
      commissionBase: find('staff', s.staffId)?.amount ?? null, revision: find('staff', s.staffId)?.revision ?? 0 })) };
}
async function save(ctx, externalTransaction = null) {
  const user = ctx.state.user, body = ctx.request.body;
  if (!canConfigure(user)) fail('仅系统管理员或经销商管理员可设置提成参数', 403);
  const data = await options(user, month(body.month));
  const type = body.entityType, id = String(body.entityId || '');
  if (!['staff', 'store'].includes(type) || !(type === 'staff' ? data.employees.some(x => x.staffId === id) : data.stores.some(x => x.storeId === id))) fail('配置对象不在授权范围', 403);
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(body.amount ?? ''))) fail('请输入非负金额，最多两位小数');
  const key = `${body.month}:${type}:${id}`;
  const run=async transaction => {
    const old = await Config.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
    if (Number(body.revision) !== Number(old?.revision || 0)) fail('配置已更新，请刷新后重试', 409);
    const before = old?.toJSON() || null;
    const payload = { config_id: key, month_key: body.month, entity_type: type, entity_id: id,
      amount: Number(body.amount), revision: Number(old?.revision || 0) + 1, updated_by: user.name || String(user.staffId), update_time: new Date() };
    if (old) await old.update(payload, { transaction }); else await Config.create(payload, { transaction });
    await recordBusinessAction({ businessType: 'employee_commission_config', businessId: key, action: 'save', user,
      detail: { before, after: payload }, transaction });
  };
  if(externalTransaction&&typeof externalTransaction==='object')await run(externalTransaction);else await M.sequelize.transaction(run);
  ctx.body = { code: 0, message: '提成参数已保存' };
}
async function staffConfigs(monthKey,staffIds){month(monthKey);const ids=[...new Set(staffIds.filter(Boolean).map(String))];return ids.length?Config.findAll({where:{month_key:monthKey,entity_type:'staff',entity_id:{[Op.in]:ids}},raw:true}):[];}
module.exports = { Config, month, scope, options, save, canConfigure,staffConfigs };
