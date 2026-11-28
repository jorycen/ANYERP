const { sequelize } = require('../config/database');
const fs = require('fs');
const path = require('path');

async function executeInboundMigration() {
  console.log('开始执行入库单数据库迁移...');

  try {
    await sequelize.authenticate();
    console.log('✓ 数据库连接成功');

    const migrationSql = fs.readFileSync(
      path.join(__dirname, '../../../scripts/migrate_inbound_fields.sql'),
      'utf8'
    );

    const statements = migrationSql.split(';').filter(s => s.trim());

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await sequelize.query(statement.trim());
          console.log('✓ 执行成功:', statement.trim().substring(0, 50) + '...');
        } catch (err) {
          if (err.message.includes('Duplicate column name') || 
              err.message.includes('column already exists')) {
            console.log('- 字段已存在，跳过:', statement.trim().substring(0, 50) + '...');
          } else {
            throw err;
          }
        }
      }
    }

    console.log('✓ 入库单数据库迁移全部完成！');
  } catch (error) {
    console.error('✗ 数据库迁移失败:', error.message);
    throw error;
  } finally {
    await sequelize.close();
  }
}

executeInboundMigration();
