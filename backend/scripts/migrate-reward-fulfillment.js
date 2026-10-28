// Preview by default. No historical stock, money or points are rewritten.
const { sequelize } = require('../src/config/database');
const M = require('../src/modules/customerOps/models');
const columns = { Reward: ['product_id', 'units_per_reward'], Redemption: ['payment_method_id', 'account_id', 'fund_transaction_id', 'outbound_id', 'cost_amount', 'sales_profit', 'operations_profit'] };
const triggerSql = `CREATE TRIGGER reward_stock_hold_update BEFORE UPDATE ON T_INVENTORY FOR EACH ROW
BEGIN
  DECLARE held INT DEFAULT 0;
  SELECT COALESCE(SUM(quantity), 0) INTO held FROM T_REWARD_STOCK_RESERVATION
    WHERE inventory_id = OLD.INVENTORY_ID AND status = 'reserved' AND expires_at > NOW() FOR UPDATE;
  IF held > 0 AND (NEW.PRODUCT_ID <> OLD.PRODUCT_ID OR NEW.STORE_ID <> OLD.STORE_ID OR NEW.LOCATION_ID <> OLD.LOCATION_ID
    OR GREATEST(COALESCE(NEW.NORMAL_QTY,0), COALESCE(NEW.REGULAR_QTY,0)+COALESCE(NEW.SUBSIDY_QTY,0)+COALESCE(NEW.SECOND_QTY,0)) < held) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stock reserved for member rewards';
  END IF;
END`;
const deleteTriggerSql = `CREATE TRIGGER reward_stock_hold_delete BEFORE DELETE ON T_INVENTORY FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM T_REWARD_STOCK_RESERVATION WHERE inventory_id = OLD.INVENTORY_ID AND status = 'reserved' AND expires_at > NOW()) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stock reserved for member rewards';
  END IF;
END`;
async function migrate(apply = process.argv.includes('--apply')) {
  const qi = sequelize.getQueryInterface();
  for (const [name, fields] of Object.entries(columns)) {
    const model = M[name], existing = await qi.describeTable(model.tableName);
    for (const field of fields) if (!existing[field]) {
      console.log(`${apply ? 'Add' : 'Would add'} ${model.tableName}.${field}`);
      if (apply) await qi.addColumn(model.tableName, field, model.rawAttributes[field]);
    }
  }
  const tables = await qi.showAllTables();
  if (!tables.includes(M.Reservation.tableName)) {
    console.log(`${apply ? 'Create' : 'Would create'} ${M.Reservation.tableName}`);
    if (apply) await M.Reservation.sync();
  }
  const [triggers] = await sequelize.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('reward_stock_hold_update','reward_stock_hold_delete')");
  for (const [name, sql] of [['reward_stock_hold_update', triggerSql], ['reward_stock_hold_delete', deleteTriggerSql]]) {
    if (triggers.some(t => t.TRIGGER_NAME === name)) continue;
    console.log(`${apply ? 'Create' : 'Would create'} ${name}`);
    if (apply) await sequelize.query(sql);
  }
}
if (require.main === module) migrate().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => sequelize.close());
module.exports = { migrate, columns, triggerSql, deleteTriggerSql };
