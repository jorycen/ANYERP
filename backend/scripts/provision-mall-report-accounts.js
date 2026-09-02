const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const {
  sequelize,
  Staff,
  Role,
  StaffRole,
  StaffStorePermission,
  StaffDistributorPermission
} = require('../src/models');
const { resolveAccessibleStoreIds } = require('../src/utils/storePermissions');

const SOURCE_ROLE_CODES = ['manager', 'store_manager', 'store_admin'];
const TARGET_ROLE_CODE = 'mall_report_viewer';
const ACCOUNT_SUFFIX = '260';
const LEGACY_ACCOUNT_SUFFIX = 'D';

function initialPassword(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-6) || '123456';
}

async function ensureTargetRole() {
  const [role] = await Role.findOrCreate({
    where: { role_code: TARGET_ROLE_CODE },
    defaults: {
      role_id: randomUUID().replace(/-/g, '').slice(0, 32),
      name: '商场上报查询',
      description: '仅查询已上报商场数据',
      is_system: 1,
      status: 1
    }
  });
  if (role.status !== 1 || role.name !== '商场上报查询') {
    await role.update({ name: '商场上报查询', description: '仅查询已上报商场数据', is_system: 1, status: 1 });
  }
  return role;
}

async function listStoreManagers() {
  const [rows] = await sequelize.query(`
    SELECT DISTINCT s.STAFF_ID AS staff_id,
           s.DISTRIBUTOR_ID AS distributor_id,
           s.STORE_ID AS store_id,
           s.REGION_ID AS region_id,
           s.NAME AS name,
           s.PHONE AS phone,
           s.STATUS AS status
      FROM T_STAFF s
      LEFT JOIN T_STAFF_ROLE sr ON sr.STAFF_ID = s.STAFF_ID
      LEFT JOIN T_ROLE r ON r.ROLE_ID = sr.ROLE_ID AND r.STATUS = 1
     WHERE s.IS_DELETED = 0
       AND s.STATUS = 1
       AND (LOWER(s.ROLE_CODE) IN (?, ?, ?) OR LOWER(r.ROLE_CODE) IN (?, ?, ?))
     ORDER BY s.STAFF_ID ASC
  `, { replacements: [...SOURCE_ROLE_CODES, ...SOURCE_ROLE_CODES] });
  return rows;
}

async function ensureStorePermissions(source, targetStaffId, storeIds) {
  for (const storeId of storeIds) {
    await StaffStorePermission.findOrCreate({
      where: { staff_id: targetStaffId, store_id: storeId },
      defaults: { staff_id: targetStaffId, store_id: storeId }
    });
  }

  const distributorPermissions = await StaffDistributorPermission.findAll({
    where: { staff_id: source.staff_id },
    attributes: ['distributor_id'],
    raw: true
  });
  const distributorIds = [...new Set([
    ...distributorPermissions.map(item => String(item.distributor_id || '')).filter(Boolean),
    String(source.distributor_id || '')
  ])];
  for (const distributorId of distributorIds) {
    await StaffDistributorPermission.findOrCreate({
      where: { staff_id: targetStaffId, distributor_id: distributorId },
      defaults: { staff_id: targetStaffId, distributor_id: distributorId }
    });
  }
}

async function provision() {
  await sequelize.authenticate();
  const role = await ensureTargetRole();
  const managers = await listStoreManagers();
  const result = { created: [], updated: [], skipped: [] };

  for (const source of managers) {
    const storeIds = await resolveAccessibleStoreIds(source, SOURCE_ROLE_CODES);
    if (!storeIds.length) {
      result.skipped.push({ phone: source.phone, reason: '店长未配置有效门店' });
      continue;
    }

    const accountPhone = `${source.phone}${ACCOUNT_SUFFIX}`;
    const legacyAccountPhone = `${source.phone}${LEGACY_ACCOUNT_SUFFIX}`;
    let account = await Staff.findOne({ where: { phone: accountPhone } });
    let created = false;
    if (!account) {
      account = await Staff.findOne({ where: { phone: legacyAccountPhone } });
      if (account) await account.update({ phone: accountPhone });
    }
    if (!account) {
      [account, created] = await Staff.findOrCreate({
      where: { phone: accountPhone },
      defaults: {
        distributor_id: source.distributor_id,
        store_id: storeIds.includes(String(source.store_id || '')) ? source.store_id : storeIds[0],
        region_id: source.region_id || null,
        name: `${source.name}（商场查询）`,
        phone: accountPhone,
        password_hash: await bcrypt.hash(initialPassword(source.phone), 10),
        role_code: TARGET_ROLE_CODE,
        status: 1,
        is_deleted: 0
      }
      });
    }

    if (!created) {
      await account.update({
        distributor_id: source.distributor_id,
        store_id: storeIds.includes(String(source.store_id || '')) ? source.store_id : storeIds[0],
        region_id: source.region_id || null,
        name: `${source.name}（商场查询）`,
        role_code: TARGET_ROLE_CODE,
        status: 1,
        is_deleted: 0
      });
      result.updated.push(accountPhone);
    } else {
      result.created.push({ phone: accountPhone, initialPassword: initialPassword(source.phone) });
    }

    await StaffRole.findOrCreate({
      where: { staff_id: account.staff_id, role_id: role.role_id },
      defaults: { staff_id: account.staff_id, role_id: role.role_id }
    });
    await ensureStorePermissions(source, account.staff_id, storeIds);
  }

  console.log(JSON.stringify(result, null, 2));
}

provision()
  .catch(error => {
    console.error('[provision-mall-report-accounts] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
