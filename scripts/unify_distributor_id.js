const { sequelize } = require('../backend/src/models');

const SOURCE_DISTRIBUTOR_ID = 'DEFAULT';
const TARGET_DISTRIBUTOR_ID = 'DIST001';

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function getDistributorColumns(transaction) {
  const [rows] = await sequelize.query(
    "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND LOWER(COLUMN_NAME) = 'distributor_id' " +
    "ORDER BY TABLE_NAME",
    { transaction }
  );
  return rows;
}

async function getUniqueIndexes(tableName, distributorColumn, transaction) {
  const [rows] = await sequelize.query(`SHOW INDEX FROM ${quoteIdentifier(tableName)}`, { transaction });
  const grouped = new Map();
  for (const row of rows) {
    if (Number(row.Non_unique) !== 0) continue;
    if (!grouped.has(row.Key_name)) grouped.set(row.Key_name, []);
    grouped.get(row.Key_name).push({ seq: Number(row.Seq_in_index), column: row.Column_name });
  }
  return [...grouped.entries()]
    .map(([indexName, columns]) => ({
      indexName,
      columns: columns.sort((a, b) => a.seq - b.seq).map(item => item.column)
    }))
    .filter(index => index.columns.some(column => column.toLowerCase() === distributorColumn.toLowerCase()));
}

async function assertNoUniqueConflicts(tableName, distributorColumn, transaction) {
  const indexes = await getUniqueIndexes(tableName, distributorColumn, transaction);
  for (const index of indexes) {
    const otherColumns = index.columns.filter(column => column.toLowerCase() !== distributorColumn.toLowerCase());
    const table = quoteIdentifier(tableName);
    const distributor = quoteIdentifier(distributorColumn);
    let sql;
    if (otherColumns.length === 0) {
      sql = `SELECT COUNT(*) AS count FROM ${table} WHERE BINARY ${distributor} = BINARY :source ` +
        `AND EXISTS (SELECT 1 FROM ${table} WHERE BINARY ${distributor} = BINARY :target)`;
    } else {
      const comparisons = otherColumns.map(column => {
        const quoted = quoteIdentifier(column);
        return `(source_row.${quoted} = target_row.${quoted} ` +
          `OR (source_row.${quoted} IS NULL AND target_row.${quoted} IS NULL))`;
      }).join(' AND ');
      sql = `SELECT COUNT(*) AS count FROM ${table} source_row ` +
        `JOIN ${table} target_row ON ${comparisons} ` +
        `WHERE BINARY source_row.${distributor} = BINARY :source ` +
        `AND BINARY target_row.${distributor} = BINARY :target`;
    }
    const [rows] = await sequelize.query(sql, {
      replacements: { source: SOURCE_DISTRIBUTOR_ID, target: TARGET_DISTRIBUTOR_ID },
      transaction
    });
    if (Number(rows[0]?.count || 0) > 0) {
      throw new Error(`Unique index conflict: ${tableName}.${index.indexName}`);
    }
  }
}

async function unifyDistributor() {
  const transaction = await sequelize.transaction();
  try {
    const columns = await getDistributorColumns(transaction);
    const updates = [];
    for (const { TABLE_NAME, COLUMN_NAME } of columns) {
      await assertNoUniqueConflicts(TABLE_NAME, COLUMN_NAME, transaction);
    }

    for (const { TABLE_NAME, COLUMN_NAME } of columns) {
      const table = quoteIdentifier(TABLE_NAME);
      const column = quoteIdentifier(COLUMN_NAME);
      const [result] = await sequelize.query(
        `UPDATE ${table} SET ${column} = :target WHERE BINARY ${column} = BINARY :source`,
        { replacements: { source: SOURCE_DISTRIBUTOR_ID, target: TARGET_DISTRIBUTOR_ID }, transaction }
      );
      if (result.affectedRows) updates.push({ table: TABLE_NAME, column: COLUMN_NAME, count: result.affectedRows });
    }

    for (const { TABLE_NAME, COLUMN_NAME } of columns) {
      const table = quoteIdentifier(TABLE_NAME);
      const column = quoteIdentifier(COLUMN_NAME);
      const [rows] = await sequelize.query(
        `SELECT COUNT(*) AS count FROM ${table} WHERE BINARY ${column} = BINARY :source`,
        { replacements: { source: SOURCE_DISTRIBUTOR_ID }, transaction }
      );
      if (Number(rows[0]?.count || 0) > 0) throw new Error(`Source distributor remains in ${TABLE_NAME}.${COLUMN_NAME}`);
    }

    await transaction.commit();
    console.log(JSON.stringify({ source: SOURCE_DISTRIBUTOR_ID, target: TARGET_DISTRIBUTOR_ID, updates }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

unifyDistributor()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
