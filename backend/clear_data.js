const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const readline = require('readline');

const CONFIRM_PHRASE = 'CLEAR_TEST_DATA';
const args = process.argv.slice(2);
const target = (args.find(arg => arg.startsWith('--target=')) || '').split('=')[1] || '';
const dryRun = args.includes('--dry-run');

const requiredCloudEnv = ['DB_HOST', 'DB_USER', 'DB_NAME'];
const envFiles = [
  path.resolve(__dirname, '..', 'cloud-db.env'),
  path.resolve(__dirname, 'cloud-db.env')
];

function stripWrappingQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1));
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }

  return true;
}

const loadedEnvFile = envFiles.find(loadEnvFile) || '';

const config = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
  charset: 'utf8mb4'
};

const tableGroups = {
  'inventory, SN, resource rights, account posting': [
    'T_INVENTORY_RESOURCE_RIGHT',
    'T_RESOURCE_RIGHT_CHANGE_ORDER',
    'T_INVENTORY_RESOURCE_COST_ADJUSTMENT',
    'T_RESOURCE_SETTLEMENT',
    'T_PRODUCT_SN',
    'T_SN_LOG',
    'T_INVENTORY'
  ],
  'inbound, transfer, split/assembly, stock documents': [
    'T_INVENTORY_CONVERSION_ITEM',
    'T_INVENTORY_CONVERSION',
    'T_TRANSFER_ITEM',
    'T_TRANSFER',
    'T_RETURN_STOCK_ITEM',
    'T_RETURN_STOCK',
    'T_OUTBOUND_ITEM',
    'T_OUTBOUND',
    'T_INBOUND_ITEM',
    'T_INBOUND'
  ],
  'purchase records': [
    'T_PURCHASE_REQUEST_ITEM',
    'T_PURCHASE_REQUEST',
    'T_PURCHASE_ORDER_ITEM',
    'T_PURCHASE_ORDER'
  ],
  'sales and deposits': [
    'T_DEPOSIT_REDEMPTION',
    'T_DEPOSIT_REFUND',
    'T_DEPOSIT_ORDER',
    'T_ORDER_GROSS_PROFIT',
    'T_ORDER_SUPPLEMENT',
    'T_ORDER_PAYMENT',
    'T_ORDER_ATTACHMENT',
    'T_ORDER_ITEM',
    'T_ORDER'
  ],
  'approval records': [
    'T_PERFORMANCE_PROFIT_ADJUSTMENT_ATTACHMENT',
    'T_PERFORMANCE_PROFIT_ADJUSTMENT',
    'T_PRODUCT_APPLICATION'
  ],
  'daily statements, expenses, payables, rebates, account balance sources': [
    'T_SETTLEMENT_PAYMENT_RECORD',
    'T_SETTLEMENT_PAYMENT_BATCH',
    'T_SETTLEMENT_ITEM',
    'T_SETTLEMENT',
    'T_PAYABLE',
    'T_EXPENSE',
    'T_DAILY_STATEMENT_DETAIL',
    'T_DAILY_STATEMENT',
    'T_SETTLEMENT_ACCOUNT_TRANSACTION',
    'T_SUPPLIER_REBATE',
    'T_REBATE_ESTIMATE',
    'T_SALES_SETTLEMENT_COST_ADJUSTMENT'
  ],
  'manufacturer policy and price history': [
    'T_MANUFACTURER_REBATE_POLICY',
    'T_MANUFACTURER_PRICE_HISTORY',
    'T_PRODUCT_PRICE_CHANGE_LOG',
    'T_PRODUCT_PRICE_IMPORT_BATCH'
  ]
};

const preservedGroups = {
  organization: [
    'T_REGION',
    'T_DISTRIBUTOR',
    'T_STORE',
    'T_STAFF',
    'T_ROLE',
    'T_MENU',
    'T_ROLE_MENU',
    'T_STAFF_ROLE',
    'T_STAFF_STORE_PERMISSION',
    'T_REGION_PERMISSION'
  ],
  products: [
    'T_PRODUCT',
    'T_PRODUCT_PN',
    'T_PRODUCT_BARCODE',
    'T_PRODUCT_CATEGORY',
    'T_PRODUCT_CATEGORY_FIELD',
    'T_PRODUCT_PRICE'
  ],
  configuration: [
    'T_SUPPLIER',
    'T_SUPPLIER_PAYMENT_ACCOUNT',
    'T_LOCATION',
    'T_RESOURCE_CATEGORY',
    'T_PRODUCT_RESOURCE_COST_CONFIG',
    'T_DICT_CUSTOMER_SOURCE',
    'T_DICT_PAYMENT_METHOD',
    'T_DICT_PAYMENT_METHOD_STORE',
    'T_DICT_SUPPLEMENT_ITEM',
    'T_SETTLEMENT_ACCOUNT',
    'T_INVENTORY_WARNING'
  ]
};

const tablesToClear = Object.values(tableGroups).flat();

const balanceResetTargets = {
  T_SETTLEMENT_ACCOUNT: ['BALANCE', 'CURRENT_BALANCE', 'AVAILABLE_BALANCE'],
  T_SUPPLIER_PAYMENT_ACCOUNT: ['BALANCE', 'CURRENT_BALANCE', 'AVAILABLE_BALANCE']
};

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function assertSafeTableName(table) {
  if (!/^[A-Z0-9_]+$/.test(table)) {
    throw new Error(`Unsafe table name: ${table}`);
  }
}

function tableSql(table) {
  assertSafeTableName(table);
  return `\`${table}\``;
}

function columnSql(column) {
  assertSafeTableName(column);
  return `\`${column}\``;
}

function timestampForFile() {
  const pad = value => String(value).padStart(2, '0');
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

function formatValue(conn, value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (value instanceof Date) return conn.escape(value);
  if (typeof value === 'object') return conn.escape(JSON.stringify(value));
  return conn.escape(value);
}

function validateCloudTarget() {
  if (target !== 'cloud') {
    console.log('\nThis script is only for cloud cleanup before production launch.');
    console.log('To prevent accidental cleanup, pass --target=cloud explicitly.');
    console.log('\nPreview: node clear_data.js --target=cloud --dry-run');
    console.log('Execute: node clear_data.js --target=cloud');
    return false;
  }

  const missing = requiredCloudEnv.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required cloud DB environment variables: ${missing.join(', ')}. ` +
      'Create cloud-db.env from cloud-db.env.example or set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME before running.'
    );
  }

  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (localHosts.has(String(config.host).toLowerCase())) {
    throw new Error(
      `DB_HOST is ${config.host}. Refusing cloud cleanup against a local database host.`
    );
  }

  return true;
}

async function getExistingTables(conn) {
  const [rows] = await conn.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [config.database]
  );
  return new Set(rows.map(row => row.TABLE_NAME));
}

async function getExistingColumns(conn, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.database, table]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

async function getBalanceResetPlan(conn, existingTables) {
  const plan = [];
  for (const [table, candidateColumns] of Object.entries(balanceResetTargets)) {
    if (!existingTables.has(table)) continue;
    const existingColumns = await getExistingColumns(conn, table);
    const columns = candidateColumns.filter(column => existingColumns.has(column));
    if (columns.length > 0) {
      plan.push({ table, columns });
    }
  }
  return plan;
}

async function getTableCounts(conn, tables) {
  const counts = {};
  for (const table of tables) {
    const [rows] = await conn.query(`SELECT COUNT(*) AS count FROM ${tableSql(table)}`);
    counts[table] = Number(rows[0]?.count || 0);
  }
  return counts;
}

async function writeBackup(conn, tables, counts) {
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(
    backupDir,
    `test-data-cleanup-${config.database}-${timestampForFile()}.sql`
  );

  const out = fs.createWriteStream(backupPath, { encoding: 'utf8' });
  out.write('-- ANY-ERP test data cleanup backup\n');
  out.write(`-- Database: ${config.database}\n`);
  out.write(`-- Created at: ${new Date().toISOString()}\n`);
  out.write('-- This file backs up tables cleared by clear_data.js and any preserved tables with stored balances reset by the cleanup.\n\n');
  out.write('SET FOREIGN_KEY_CHECKS = 0;\n\n');

  for (const table of tables) {
    out.write(`-- ${table}: ${counts[table] || 0} rows\n`);
    out.write(`DELETE FROM ${tableSql(table)};\n`);

    if (!counts[table]) {
      out.write('\n');
      continue;
    }

    const [rows] = await conn.query(`SELECT * FROM ${tableSql(table)}`);
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      const columnSql = columns.map(column => `\`${column}\``).join(', ');
      const valueSql = columns.map(column => formatValue(conn, row[column])).join(', ');
      out.write(`INSERT INTO ${tableSql(table)} (${columnSql}) VALUES (${valueSql});\n`);
    }
    out.write('\n');
  }

  out.write('SET FOREIGN_KEY_CHECKS = 1;\n');
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });

  return backupPath;
}

async function clearTables(conn, tables) {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of tables) {
      await conn.query(`DELETE FROM ${tableSql(table)}`);
      try {
        await conn.query(`ALTER TABLE ${tableSql(table)} AUTO_INCREMENT = 1`);
      } catch (error) {
        // Some tables do not have auto-increment keys.
      }
      console.log(`  cleared ${table}`);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function resetStoredBalances(conn, plan) {
  console.log('\n--- Resetting stored account balances, if any ---');
  if (plan.length === 0) {
    console.log('  no stored balance columns found; balances come from cleared account transactions and rebate records');
    return;
  }

  for (const { table, columns } of plan) {
    const assignments = columns.map(column => `${columnSql(column)} = 0`).join(', ');
    await conn.query(`UPDATE ${tableSql(table)} SET ${assignments}`);
    console.log(`  reset ${table}.${columns.join(', ')}`);
  }
}

function printGroups(title, groups) {
  console.log(`\n${title}`);
  for (const [name, tables] of Object.entries(groups)) {
    console.log(`  [${name}] ${tables.join(', ')}`);
  }
}

function printCounts(counts) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log('\nTables to clear and current row counts:');
  for (const [groupName, tables] of Object.entries(tableGroups)) {
    const groupTotal = tables.reduce((sum, table) => sum + Number(counts[table] || 0), 0);
    console.log(`\n  [${groupName}] total ${groupTotal} rows`);
    for (const table of tables) {
      if (Object.prototype.hasOwnProperty.call(counts, table)) {
        console.log(`    ${table}: ${counts[table]} rows`);
      }
    }
  }
  console.log(`\nCleanup total: ${total} rows`);
}

function printBalanceResetPlan(plan) {
  console.log('\nStored account balance columns to reset:');
  if (plan.length === 0) {
    console.log('  none detected; account center balances are derived from transaction tables that will be cleared');
    return;
  }
  for (const { table, columns } of plan) {
    console.log(`  ${table}: ${columns.join(', ')}`);
  }
}

async function main() {
  console.log('==========================================');
  console.log('  ANY-ERP cloud test data cleanup');
  console.log('==========================================');
  console.log(`Env file: ${loadedEnvFile || '(not loaded)'}`);
  console.log(`Database: ${config.user || '(missing user)'}@${config.host || '(missing host)'}:${config.port}/${config.database || '(missing database)'}`);
  console.log(`Target: ${target || '(not specified)'}`);

  try {
    if (!validateCloudTarget()) return;

    printGroups('\nWill clear:', tableGroups);
    printGroups('\nWill keep:', preservedGroups);
    console.log('\nNote: T_PRODUCT_PRICE is kept. Import batches and price change history are cleared.');
    console.log('Account center definitions are kept. Balances are cleared by deleting settlement account transactions and supplier rebate records.');

    const conn = await mysql.createConnection(config);
    try {
      const existingTables = await getExistingTables(conn);
      const existingClearTables = tablesToClear.filter(table => existingTables.has(table));
      const missingTables = tablesToClear.filter(table => !existingTables.has(table));
      const balanceResetPlan = await getBalanceResetPlan(conn, existingTables);
      const balanceResetTables = balanceResetPlan.map(item => item.table);
      const backupTables = Array.from(new Set([...existingClearTables, ...balanceResetTables]));

      if (missingTables.length > 0) {
        console.log(`\nMissing tables will be skipped: ${missingTables.join(', ')}`);
      }

      const counts = await getTableCounts(conn, existingClearTables);
      printCounts(counts);
      printBalanceResetPlan(balanceResetPlan);

      if (dryRun) {
        console.log('\nDry run only. No backup or delete was executed.');
        return;
      }

      console.log('\nThis operation will delete test business data from the CLOUD database.');
      console.log('A backup SQL file for cleared tables and any reset balance tables will be written before deletion.');
      const answer = await ask(`Type ${CONFIRM_PHRASE} to continue: `);
      if (answer !== CONFIRM_PHRASE) {
        console.log('Canceled. No data was deleted.');
        return;
      }

      console.log('\n--- Backing up tables to be cleared ---');
      const backupCounts = await getTableCounts(conn, backupTables);
      const backupPath = await writeBackup(conn, backupTables, backupCounts);
      console.log(`Backup completed: ${backupPath}`);

      console.log('\n--- Clearing test business data ---');
      await clearTables(conn, existingClearTables);
      await resetStoredBalances(conn, balanceResetPlan);

      const afterCounts = await getTableCounts(conn, existingClearTables);
      const remaining = Object.values(afterCounts).reduce((sum, count) => sum + count, 0);
      console.log(`\nCleanup completed. Remaining rows in cleared tables: ${remaining}`);
      console.log('Kept config, users, roles, stores, suppliers, product master data, and current product prices.');
    } finally {
      await conn.end();
    }
  } catch (error) {
    console.error(`\nCleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
