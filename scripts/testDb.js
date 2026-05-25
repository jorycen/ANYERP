/**
 * 测试数据库连接并初始化
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const config = {
  host: 'sh-cynosdbmysql-grp-lpycb6gi.sql.tencentcdb.com',
  port: 29244,
  user: 'ainuoyun',
  password: 'lx123456.',
  database: 'cloud1-8glwjlnq4c74f7f1',
  charset: 'utf8mb4'
};

async function initDatabase() {
  console.log('正在连接数据库...');

  let connection;
  try {
    // 先连接不带数据库，创建数据库
    const connWithoutDb = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      charset: config.charset
    });

    console.log('✓ 数据库连接成功');

    // 创建数据库（如果不存在）
    await connWithoutDb.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✓ 数据库 ${config.database} 创建/确认成功`);

    await connWithoutDb.end();

    // 连接目标数据库
    connection = await mysql.createConnection(config);
    console.log('✓ 连接到目标数据库');

    // 读取SQL文件
    const sqlFile = path.join(__dirname, 'init.sql');
    let sqlContent = fs.readFileSync(sqlFile, 'utf8');

    // 分割SQL语句（按分号分割，但需要处理存储过程等复杂情况）
    const statements = sqlContent
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    console.log(`\n开始执行 ${statements.length} 条SQL语句...`);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (!stmt || stmt.startsWith('SET')) {
        successCount++;
        continue;
      }

      try {
        await connection.query(stmt);
        successCount++;
        if (i % 5 === 0) {
          process.stdout.write('.');
        }
      } catch (err) {
        errorCount++;
        // 忽略某些已存在的错误
        if (err.code === 'ER_TABLE_EXISTS_ERROR' || err.code === 'ER_DUP_ENTRY') {
          console.log(`\n⚠ 跳过已存在的表/数据`);
        } else {
          console.log(`\n⚠ 执行出错: ${err.message.substring(0, 100)}`);
        }
      }
    }

    console.log(`\n\n✓ 初始化完成！`);
    console.log(`  成功: ${successCount} 条`);
    console.log(`  失败: ${errorCount} 条`);

    // 验证表是否创建成功
    const [tables] = await connection.query('SHOW TABLES');
    console.log(`\n已创建 ${tables.length} 张表:`);
    tables.forEach(t => console.log(`  - ${Object.values(t)[0]}`));

  } catch (err) {
    console.error('✗ 数据库初始化失败:', err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

initDatabase();
