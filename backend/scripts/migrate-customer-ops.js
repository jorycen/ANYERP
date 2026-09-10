// Explicit migration only: do not run from the server's automatic migration loop.
const { sequelize } = require('../src/config/database');
const models = require('../src/modules/customerOps/models');
async function migrate() {
  if (process.argv.includes('--apply')) {
    for (const model of Object.values(models)) await model.sync();
    if (process.argv.includes('--tables-only')) {
      console.log('Customer operations tables installed. No menu or business data changed.');
      return;
    }
    const { Menu, Role, RoleMenu } = require('../src/models');
    const menus = [
      ['customer_ops', '客户运营', '/customer-ops/members', null],
      ['customer_members', '会员管理', '/customer-ops/members', 'customer_ops'],
      ['customer_points', '积分管理', '/customer-ops/points', 'customer_ops'],
      ['customer_rewards', '积分商品', '/customer-ops/rewards', 'customer_ops'],
      ['customer_exchanges', '兑换核销', '/customer-ops/exchanges', 'customer_ops']
    ];
    await sequelize.transaction(async transaction => {
      for (const [code, name, path, parent] of menus) {
        await Menu.findOrCreate({ where: { menu_code: code }, defaults: { menu_id: code, name, path,
          parent_id: parent, menu_type: parent ? 'menu' : 'directory', icon: 'User', sort_order: 65, status: 1 }, transaction });
        const row = await Menu.findOne({ where: { menu_code: code }, transaction });
        for (const role of await Role.findAll({ where: { role_code: ['boss', 'admin'], status: 1 }, transaction })) {
          await RoleMenu.findOrCreate({ where: { role_id: role.role_id, menu_id: row.menu_id }, transaction });
        }
      }
    });
    console.log('Customer operations schema and admin menus installed; feature remains controlled by CUSTOMER_OPS_ENABLED.');
  } else {
    console.log('Preview only. New tables:', Object.values(models).map(m => m.tableName).join(', '));
    console.log('Use --apply after validating schema and backup. No existing business tables are altered.');
  }
}
if (require.main === module) migrate().catch(error => { console.error(error.name, error.original?.code || 'migration failed'); process.exitCode = 1; }).finally(() => sequelize.close());
module.exports = { migrate };
