const { sequelize } = require('../src/config/database');

async function query(sql) {
  return sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    activeSnProductsWithMultiplePns: await query(`
      SELECT
        p.product_id,
        p.product_code,
        p.name,
        GROUP_CONCAT(pp.pn_code ORDER BY pp.pn_code SEPARATOR ' | ') AS active_pn_codes,
        COUNT(pp.pn_id) AS active_pn_count
      FROM T_PRODUCT p
      JOIN T_PRODUCT_PN pp
        ON pp.product_id = p.product_id
       AND pp.status = 1
       AND pp.is_deleted = 0
      WHERE p.is_deleted = 0
        AND p.need_sn = 1
      GROUP BY p.product_id, p.product_code, p.name
      HAVING COUNT(pp.pn_id) > 1
      ORDER BY p.product_code
    `),
    activeSnProductsWithoutPn: await query(`
      SELECT p.product_id, p.product_code, p.name, p.manufacturer_code
      FROM T_PRODUCT p
      LEFT JOIN T_PRODUCT_PN pp
        ON pp.product_id = p.product_id
       AND pp.status = 1
       AND pp.is_deleted = 0
      WHERE p.is_deleted = 0
        AND p.need_sn = 1
      GROUP BY p.product_id, p.product_code, p.name, p.manufacturer_code
      HAVING COUNT(pp.pn_id) = 0
      ORDER BY p.product_code
    `),
    snReferencingInactivePn: await query(`
      SELECT s.sn_id, s.sn_code, s.product_id, s.pn_id, pp.pn_code, pp.status, pp.is_deleted
      FROM T_PRODUCT_SN s
      JOIN T_PRODUCT_PN pp ON pp.pn_id = s.pn_id
      WHERE s.pn_id IS NOT NULL
        AND (pp.status <> 1 OR pp.is_deleted <> 0)
      ORDER BY s.sn_code
    `),
    snReferencingMissingPn: await query(`
      SELECT s.sn_id, s.sn_code, s.product_id, s.pn_id, s.pn_code
      FROM T_PRODUCT_SN s
      LEFT JOIN T_PRODUCT_PN pp ON pp.pn_id = s.pn_id
      WHERE s.pn_id IS NOT NULL
        AND pp.pn_id IS NULL
      ORDER BY s.sn_code
    `),
    snPnSnapshotMismatch: await query(`
      SELECT s.sn_id, s.sn_code, s.product_id, s.pn_id, s.pn_code, pp.pn_code AS master_pn_code
      FROM T_PRODUCT_SN s
      JOIN T_PRODUCT_PN pp ON pp.pn_id = s.pn_id
      WHERE s.pn_code IS NOT NULL
        AND TRIM(s.pn_code) <> TRIM(pp.pn_code)
      ORDER BY s.sn_code
    `)
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
