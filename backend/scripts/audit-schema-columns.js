const { sequelize } = require('../src/models');

function tableNameOf(model) {
  const table = model.getTableName();
  return typeof table === 'string' ? table : table.tableName;
}

function columnNameOf(attributeName, attribute) {
  return String(attribute.field || attributeName).toUpperCase();
}

async function main() {
  await sequelize.authenticate();
  const databaseRows = await sequelize.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()`,
    { type: sequelize.QueryTypes.SELECT }
  );
  const databaseColumns = new Map();
  for (const row of databaseRows) {
    const tableName = String(row.TABLE_NAME).toUpperCase();
    if (!databaseColumns.has(tableName)) databaseColumns.set(tableName, new Set());
    databaseColumns.get(tableName).add(String(row.COLUMN_NAME).toUpperCase());
  }

  const missingTables = [];
  const missingColumns = [];
  for (const model of Object.values(sequelize.models)) {
    const tableName = tableNameOf(model);
    const existing = databaseColumns.get(String(tableName).toUpperCase());
    if (!existing) {
      missingTables.push({ model: model.name, table: tableName });
      continue;
    }
    for (const [attributeName, attribute] of Object.entries(model.rawAttributes)) {
      if (attribute.type?.key === 'VIRTUAL') continue;
      const column = columnNameOf(attributeName, attribute);
      if (!existing.has(column)) missingColumns.push({ model: model.name, table: tableName, attribute: attributeName, column });
    }
  }

  console.log(JSON.stringify({ missingTables, missingColumns }, null, 2));
  if (missingTables.length || missingColumns.length) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error(`结构核对失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
