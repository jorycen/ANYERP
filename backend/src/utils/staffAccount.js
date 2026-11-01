function parseBackendAccount(value) {
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  throw Object.assign(new Error('后台账号标记必须为是或否'), { status: 400 });
}

function accountTypeWhere(type = 'all') {
  if (type === 'all') return {};
  if (type === 'business') return { is_backend_account: 0 };
  if (type === 'backend') return { is_backend_account: 1 };
  throw Object.assign(new Error('账号类型筛选无效'), { status: 400 });
}

async function ensureStaffAccountSchema(db) {
  const { DataTypes } = require('sequelize');
  const query = db.getQueryInterface();
  const columns = await query.describeTable('T_STAFF');
  if (!Object.keys(columns).some(key => key.toLowerCase() === 'is_backend_account')) {
    try {
      await query.addColumn('T_STAFF', 'IS_BACKEND_ACCOUNT', {
        type: DataTypes.TINYINT, allowNull: false, defaultValue: 0, comment: '后台账号：业务人员选项默认隐藏，不改变权限'
      });
    } catch (error) {
      if (error.original?.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
  // Fail startup readiness when the column cannot actually be read.
  await db.query('SELECT IS_BACKEND_ACCOUNT FROM T_STAFF LIMIT 0');
}

module.exports = { parseBackendAccount, accountTypeWhere, ensureStaffAccountSchema };
