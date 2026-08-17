-- Normalize all PN values in the production MySQL schema.
--
-- Run the duplicate check first. If it returns rows, merge or remove the
-- duplicate PN records before running the update, otherwise the unique index
-- on T_PRODUCT_PN may reject the update.

SELECT UPPER(TRIM(PN_CODE)) AS NORMALIZED_PN_CODE, COUNT(*) AS RECORD_COUNT
FROM T_PRODUCT_PN
WHERE PN_CODE IS NOT NULL AND TRIM(PN_CODE) <> ''
GROUP BY UPPER(TRIM(PN_CODE))
HAVING COUNT(*) > 1;

START TRANSACTION;

-- Product PN master data.
UPDATE T_PRODUCT_PN
SET PN_CODE = UPPER(TRIM(PN_CODE))
WHERE PN_CODE IS NOT NULL AND TRIM(PN_CODE) <> '';

-- Inventory SN data. The PN snapshot is backfilled from the PN master when
-- the inventory row does not already contain one.
UPDATE T_PRODUCT_SN sn
LEFT JOIN T_PRODUCT_PN pn ON pn.PN_ID = sn.PN_ID
SET sn.SN_CODE = UPPER(TRIM(sn.SN_CODE)),
    sn.pn_code = UPPER(TRIM(COALESCE(NULLIF(sn.pn_code, ''), pn.PN_CODE)))
WHERE (sn.SN_CODE IS NOT NULL AND TRIM(sn.SN_CODE) <> '')
   OR (sn.pn_code IS NOT NULL AND TRIM(sn.pn_code) <> '');

-- Historical order snapshots.
UPDATE T_ORDER_ITEM
SET PN_CODE = UPPER(NULLIF(TRIM(PN_CODE), ''))
WHERE PN_CODE IS NOT NULL;

COMMIT;

-- Verification: this should return no rows after the migration.
SELECT 'T_PRODUCT_PN' AS TABLE_NAME, PN_CODE
FROM T_PRODUCT_PN
WHERE PN_CODE <> UPPER(TRIM(PN_CODE))
LIMIT 20;

SELECT 'T_PRODUCT_SN' AS TABLE_NAME, pn_code
FROM T_PRODUCT_SN
WHERE pn_code IS NOT NULL AND pn_code <> UPPER(TRIM(pn_code))
LIMIT 20;

SELECT 'T_ORDER_ITEM' AS TABLE_NAME, PN_CODE
FROM T_ORDER_ITEM
WHERE PN_CODE IS NOT NULL AND PN_CODE <> UPPER(TRIM(PN_CODE))
LIMIT 20;
