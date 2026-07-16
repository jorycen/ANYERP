const { randomUUID } = require('crypto');
const { sequelize } = require('../src/models');
const { migrateMissingProductPns } = require('../src/utils/dbMigration');

(async () => {
  try {
    await migrateMissingProductPns(randomUUID);
    console.log('[PN Repair] 存量商品PN修复完成');
  } catch (error) {
    console.error('[PN Repair] 修复失败:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
