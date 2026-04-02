const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const config = {
    host: 'sh-cynosdbmysql-grp-a0lumus4.sql.tencentcdb.com',
    port: 23686,
    user: 'erp_user',
    password: 'Lx123654',
    database: 'ainuozusushou-9gx5p6b6a8f04996',
    multipleStatements: true
};

async function init() {
    console.log('--- ERP Database Initialization ---');
    console.log(`Target: ${config.host}/${config.database}`);
    let connection;
    try {
        connection = await mysql.createConnection({
            ...config,
            connectTimeout: 15000
        });
        console.log('✅ Connected successfully.');

        // Point to the SQL file specifically
        const sqlPath = 'e:\\艾诺云\\Soft\\trea\\sdxcx\\init.sql';
        console.log(`Reading SQL from ${sqlPath}...`);
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('Executing SQL script (this may take a few seconds)...');
        const [result] = await connection.query(sql);

        console.log('✅ Tables created successfully.');

        // Quick verification: list tables
        const [tables] = await connection.query('SHOW TABLES');
        console.log('Current Tables in Database:');
        tables.forEach(t => console.log(` - ${Object.values(t)[0]}`));

    } catch (err) {
        console.error('❌ Error during initialization:', err.message);
        if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
            console.log('\nTIP: Connection timed out. This is likely because your current IP is not whitelisted in the Tencent Cloud MySQL console.');
            console.log('Please add your external IP to the allows list (0.0.0.0/0 for testing, or your specific IP).');
        }
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
}

init();
