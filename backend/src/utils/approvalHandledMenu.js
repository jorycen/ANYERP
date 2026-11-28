const { randomUUID } = require('crypto');

// Repair only the missing history entry, preserving existing menu configuration.
async function ensureApprovalHandledMenu(sequelize) {
  return sequelize.transaction(async transaction => {
    const options = { transaction };
    const [parents] = await sequelize.query("SELECT MENU_ID FROM T_MENU WHERE MENU_CODE = 'approval' AND STATUS = 1 LIMIT 1", options);
    if (!parents.length) return;
    const [existing] = await sequelize.query("SELECT MENU_ID, STATUS FROM T_MENU WHERE MENU_CODE = 'approval_handled' LIMIT 1", options);
    // Do not reactivate an entry explicitly disabled by an administrator.
    if (existing.length) return;
    const menuId = randomUUID().replace(/-/g, '');
    await sequelize.query(
      `INSERT INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS)
       VALUES (?, 'approval_handled', '我的审批', ?, 'menu', '/approval/handled', NULL, 3, 1)`,
      { ...options, replacements: [menuId, parents[0].MENU_ID] }
    );
    // Use the existing approval audience, including custom roles; no workflow rights are added.
    await sequelize.query(
      `INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID)
       SELECT DISTINCT RM.ROLE_ID, ? FROM T_ROLE_MENU RM
       JOIN T_MENU M ON M.MENU_ID = RM.MENU_ID
       JOIN T_ROLE R ON R.ROLE_ID = RM.ROLE_ID AND R.STATUS = 1
       WHERE M.MENU_CODE = 'approval_tasks' AND M.STATUS = 1`,
      { ...options, replacements: [menuId] }
    );
  });
}
module.exports = { ensureApprovalHandledMenu };
