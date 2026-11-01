const { sequelize } = require('../src/models');
const { ensureStaffAccountSchema } = require('../src/utils/staffAccount');
ensureStaffAccountSchema(sequelize)
  .then(() => console.log('T_STAFF.IS_BACKEND_ACCOUNT verified; existing accounts default to 0'))
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
