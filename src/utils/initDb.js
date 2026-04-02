const fs = require('fs');
const path = require('path');
const db = require('../config/db');

/**
 * 自动填充数据库初始化脚本
 */
async function initializeDatabase() {
  try {
    console.log('🚀 Starting Automatic Database Initialization...');

    // 1. 读取 SQL 文件
    const sqlPath = path.join(__dirname, '../sql/0001_initial_schema.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    // 2. 预处理 SQL (按分号切割语句，排除空行)
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    console.log(`📊 Found ${statements.length} SQL statements to execute.`);

    // 3. 顺序执行
    for (const stmt of statements) {
      try {
        await db.execute(stmt);
      } catch (stmtError) {
        // 允许某些错误（如表已存在，虽然 DDL 中包含 IF NOT EXISTS）
        console.warn(`⚠️ Warning executing statement: ${stmt.substring(0, 50)}...`);
        console.warn(`   Error: ${stmtError.message}`);
      }
    }

    console.log('✅ Database Initialization Completed Successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database Initialization Failed:', error);
    process.exit(1);
  }
}

// 只有直接运行时才执行
if (require.main === module) {
  initializeDatabase();
}

module.exports = initializeDatabase;
