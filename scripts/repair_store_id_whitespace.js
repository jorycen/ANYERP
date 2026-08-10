const { sequelize } = require('../backend/src/models');

const DIRTY_STORE_ID = 'D0215327 ';
const CANONICAL_STORE_ID = 'D0215327';

async function findStoreIdColumns() {
  const [rows] = await sequelize.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND LOWER(COLUMN_NAME) IN " +
    "('store_id', 'from_store_id', 'to_store_id', 'dest_store_id') " +
    "ORDER BY TABLE_NAME, COLUMN_NAME"
  );
  return rows;
}

async function repair() {
  const transaction = await sequelize.transaction();
  try {
    const [stores] = await sequelize.query(
      "SELECT store_id, status, is_deleted FROM T_STORE " +
      "WHERE BINARY store_id IN (BINARY :dirty, BINARY :canonical) FOR UPDATE",
      { replacements: { dirty: DIRTY_STORE_ID, canonical: CANONICAL_STORE_ID }, transaction }
    );
    const dirtyStore = stores.find(row => row.store_id === DIRTY_STORE_ID);
    const canonicalStore = stores.find(row => row.store_id === CANONICAL_STORE_ID);
    if (!dirtyStore || dirtyStore.status !== 1 || dirtyStore.is_deleted !== 0) {
      throw new Error('未找到状态正常的异常门店 D0215327<space>，已停止修复');
    }
    if (canonicalStore) {
      throw new Error('规范门店 ID D0215327 已存在，无法自动合并');
    }

    const columns = await findStoreIdColumns();
    for (const { TABLE_NAME, COLUMN_NAME } of columns) {
      if (TABLE_NAME === 'T_STORE' || TABLE_NAME === 'T_LOCATION') continue;
      const [conflicts] = await sequelize.query(
        `SELECT COUNT(*) AS count FROM \`${TABLE_NAME}\` WHERE BINARY \`${COLUMN_NAME}\` = BINARY :canonical`,
        { replacements: { canonical: CANONICAL_STORE_ID }, transaction }
      );
      if (Number(conflicts[0]?.count || 0) > 0) {
        throw new Error(`表 ${TABLE_NAME}.${COLUMN_NAME} 已存在规范 ID，无法自动合并`);
      }
    }

    const [duplicateLocations] = await sequelize.query(
      "SELECT location_id, type FROM T_LOCATION " +
      "WHERE BINARY store_id = BINARY :dirty AND status = 1",
      { replacements: { dirty: DIRTY_STORE_ID }, transaction }
    );
    const [canonicalLocations] = await sequelize.query(
      "SELECT type FROM T_LOCATION " +
      "WHERE BINARY store_id = BINARY :canonical AND status = 1",
      { replacements: { canonical: CANONICAL_STORE_ID }, transaction }
    );
    const canonicalTypes = new Set(canonicalLocations.map(row => row.type));
    const conflictingTypes = duplicateLocations.filter(row => canonicalTypes.has(row.type));
    if (conflictingTypes.length !== duplicateLocations.length) {
      throw new Error('异常仓位不是完整重复集合，已停止自动修复');
    }

    const updateCounts = [];
    for (const { TABLE_NAME, COLUMN_NAME } of columns) {
      if (TABLE_NAME === 'T_STORE' || TABLE_NAME === 'T_LOCATION') continue;
      const [result] = await sequelize.query(
        `UPDATE \`${TABLE_NAME}\` SET \`${COLUMN_NAME}\` = :canonical ` +
        `WHERE BINARY \`${COLUMN_NAME}\` = BINARY :dirty`,
        { replacements: { canonical: CANONICAL_STORE_ID, dirty: DIRTY_STORE_ID }, transaction }
      );
      if (result.affectedRows) updateCounts.push({ table: TABLE_NAME, column: COLUMN_NAME, count: result.affectedRows });
    }

    const [storeResult] = await sequelize.query(
      "UPDATE T_STORE SET store_id = :canonical WHERE BINARY store_id = BINARY :dirty",
      { replacements: { canonical: CANONICAL_STORE_ID, dirty: DIRTY_STORE_ID }, transaction }
    );
    updateCounts.push({ table: 'T_STORE', column: 'store_id', count: storeResult.affectedRows });

    const [locationResult] = await sequelize.query(
      "UPDATE T_LOCATION SET status = 0 " +
      "WHERE BINARY store_id = BINARY :dirty AND status = 1",
      { replacements: { dirty: DIRTY_STORE_ID }, transaction }
    );
    updateCounts.push({ table: 'T_LOCATION', column: 'status', count: locationResult.affectedRows });

    await transaction.commit();
    console.log(JSON.stringify({ canonicalStoreId: CANONICAL_STORE_ID, updates: updateCounts }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

repair()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
