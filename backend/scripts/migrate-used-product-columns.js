const { sequelize } = require('../src/models');
const { ensureCriticalSchemaCompatibility } = require('../src/utils/dbMigration');

async function main() {
  await sequelize.authenticate();
  await ensureCriticalSchemaCompatibility();
  console.log('T_PRODUCT.IS_USED_PRODUCT is ready.');
}

main()
  .catch(error => {
    console.error('Failed to migrate T_PRODUCT.IS_USED_PRODUCT:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
