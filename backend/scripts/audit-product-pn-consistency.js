const { sequelize } = require('../src/config/database');

async function query(sql) {
  return sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    activePnProductConflicts: await query(`
      SELECT
        LOWER(REPLACE(TRIM(pp.pn_code), ' ', '')) AS normalized_pn_code,
        GROUP_CONCAT(DISTINCT pp.pn_code ORDER BY pp.pn_code SEPARATOR ' | ') AS pn_codes,
        GROUP_CONCAT(DISTINCT p.product_code ORDER BY p.product_code SEPARATOR ' | ') AS product_codes,
        COUNT(DISTINCT pp.product_id) AS product_count
      FROM T_PRODUCT_PN pp
      JOIN T_PRODUCT p ON p.product_id = pp.product_id
      WHERE pp.status = 1
        AND pp.is_deleted = 0
        AND p.status = 1
        AND p.is_deleted = 0
      GROUP BY LOWER(REPLACE(TRIM(pp.pn_code), ' ', ''))
      HAVING COUNT(DISTINCT pp.product_id) > 1
      ORDER BY normalized_pn_code
    `),
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
    `),
    inStockSnProductPnConflicts: await query(`
      SELECT
        s.sn_id,
        s.sn_code,
        s.pn_code,
        s.product_id AS actual_product_id,
        actual_product.product_code AS actual_product_code,
        actual_product.name AS actual_product_name,
        pp.product_id AS master_product_id,
        master_product.product_code AS master_product_code,
        master_product.name AS master_product_name,
        s.store_id,
        st.name AS store_name,
        s.location_id,
        loc.name AS location_name
      FROM T_PRODUCT_SN s
      JOIN T_PRODUCT_PN pp
        ON LOWER(REPLACE(TRIM(s.pn_code), ' ', '')) = LOWER(REPLACE(TRIM(pp.pn_code), ' ', ''))
       AND pp.status = 1
       AND pp.is_deleted = 0
      JOIN T_PRODUCT actual_product ON actual_product.product_id = s.product_id
      JOIN T_PRODUCT master_product ON master_product.product_id = pp.product_id
      LEFT JOIN T_STORE st ON st.store_id = s.store_id
      LEFT JOIN T_LOCATION loc ON loc.location_id = s.location_id
      WHERE s.status = 'in_stock'
        AND s.is_deleted = 0
        AND actual_product.product_id <> pp.product_id
      ORDER BY s.pn_code, s.sn_code
    `),
    inStockSnWithoutMasterPn: await query(`
      SELECT
        s.sn_id,
        s.sn_code,
        s.pn_code,
        s.product_id,
        p.product_code,
        p.name AS product_name,
        s.store_id,
        st.name AS store_name,
        s.location_id,
        loc.name AS location_name
      FROM T_PRODUCT_SN s
      JOIN T_PRODUCT p ON p.product_id = s.product_id
      LEFT JOIN T_PRODUCT_PN pp
        ON LOWER(REPLACE(TRIM(s.pn_code), ' ', '')) = LOWER(REPLACE(TRIM(pp.pn_code), ' ', ''))
       AND pp.status = 1
       AND pp.is_deleted = 0
      LEFT JOIN T_STORE st ON st.store_id = s.store_id
      LEFT JOIN T_LOCATION loc ON loc.location_id = s.location_id
      WHERE s.status = 'in_stock'
        AND s.is_deleted = 0
        AND NULLIF(TRIM(s.pn_code), '') IS NOT NULL
        AND pp.pn_id IS NULL
      ORDER BY s.pn_code, s.sn_code
    `),
    inStockPnUsedByMultipleProducts: await query(`
      SELECT
        LOWER(REPLACE(TRIM(s.pn_code), ' ', '')) AS normalized_pn_code,
        GROUP_CONCAT(DISTINCT s.pn_code ORDER BY s.pn_code SEPARATOR ' | ') AS pn_codes,
        GROUP_CONCAT(DISTINCT p.product_code ORDER BY p.product_code SEPARATOR ' | ') AS product_codes,
        COUNT(DISTINCT s.product_id) AS product_count,
        COUNT(*) AS sn_count
      FROM T_PRODUCT_SN s
      JOIN T_PRODUCT p ON p.product_id = s.product_id
      WHERE s.status = 'in_stock'
        AND s.is_deleted = 0
        AND NULLIF(TRIM(s.pn_code), '') IS NOT NULL
      GROUP BY LOWER(REPLACE(TRIM(s.pn_code), ' ', ''))
      HAVING COUNT(DISTINCT s.product_id) > 1
      ORDER BY normalized_pn_code
    `)
  };

  report.summary = {
    activePnProductConflictCount: report.activePnProductConflicts.length,
    activeSnProductMultiplePnCount: report.activeSnProductsWithMultiplePns.length,
    inStockSnProductConflictCount: report.inStockSnProductPnConflicts.length,
    inStockSnWithoutMasterPnCount: report.inStockSnWithoutMasterPn.length,
    inStockPnUsedByMultipleProductsCount: report.inStockPnUsedByMultipleProducts.length
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
