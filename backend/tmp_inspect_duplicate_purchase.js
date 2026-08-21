const { sequelize } = require('./src/models');

(async () => {
  const rows = await sequelize.query(
    `SELECT request_id, request_no, apply_user, applicant_staff_id, supplier_id,
            total_amount, status, create_time, submit_time
     FROM T_PURCHASE_REQUEST
     ORDER BY create_time ASC`,
    { type: sequelize.QueryTypes.SELECT }
  );
  console.log(JSON.stringify(rows, null, 2));
  const ids = rows.map(row => row.request_id);
  if (ids.length) {
    const logs = await sequelize.query(
      `SELECT business_id, business_no, action, from_status, to_status, create_user, create_time
       FROM T_BUSINESS_ACTION_LOG
       WHERE business_type = 'purchase_request'
         AND business_id IN (?)
       ORDER BY create_time ASC`,
      { replacements: [ids], type: sequelize.QueryTypes.SELECT }
    );
    console.log(JSON.stringify(logs, null, 2));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await sequelize.close();
});
