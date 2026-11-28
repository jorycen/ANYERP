const { randomUUID } = require('node:crypto');

// Inherit only the existing employee-report audience, including custom roles.
// Existing entries (including deliberately disabled entries) remain untouched.
async function ensureEmployeeProfitMenu(sequelize) {
  return sequelize.transaction(async transaction => {
    const opt = { transaction };
    const [parents] = await sequelize.query("SELECT MENU_ID FROM T_MENU WHERE MENU_CODE='reports' AND STATUS=1 LIMIT 1 FOR UPDATE", opt);
    if (!parents.length) return;
    const [existing] = await sequelize.query("SELECT MENU_ID FROM T_MENU WHERE MENU_CODE='reports_employee_profit_summary' LIMIT 1", opt);
    if (existing.length) return;
    const id = randomUUID().replaceAll('-', '');
    await sequelize.query(`INSERT INTO T_MENU (MENU_ID,MENU_CODE,NAME,PARENT_ID,MENU_TYPE,PATH,SORT_ORDER,STATUS)
      VALUES (?,'reports_employee_profit_summary','员工毛利汇总',?,'menu','/reports/employee-profit-summary',8,1)`,
      { ...opt, replacements: [id, parents[0].MENU_ID] });
    await sequelize.query(`INSERT INTO T_ROLE_MENU (ROLE_ID,MENU_ID)
      SELECT DISTINCT rm.ROLE_ID, ? FROM T_ROLE_MENU rm
      JOIN T_MENU m ON m.MENU_ID=rm.MENU_ID AND m.STATUS=1
      JOIN T_ROLE r ON r.ROLE_ID=rm.ROLE_ID AND r.STATUS=1
      WHERE m.MENU_CODE='reports_employee'`, { ...opt, replacements: [id] });
  });
}
module.exports = { ensureEmployeeProfitMenu };
