const mysql = require('mysql2/promise');
const readline = require('readline');

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'any_erp',
  charset: 'utf8mb4'
};

const TABLES = [
  'T_PRODUCT',
  'T_PRODUCT_PN',
  'T_PRODUCT_SN',
  'T_PRODUCT_BARCODE',
  'T_PRODUCT_PRICE',
  'T_SN_LOG',
  'T_INVENTORY_WARNING',
  'T_ORDER',
  'T_ORDER_ITEM',
  'T_ORDER_PAYMENT',
  'T_ORDER_ATTACHMENT',
  'T_INVENTORY',
  'T_OUTBOUND',
  'T_OUTBOUND_ITEM',
  'T_TRANSFER',
  'T_TRANSFER_ITEM',
  'T_RETURN_STOCK',
  'T_RETURN_STOCK_ITEM',
  'T_INBOUND',
  'T_INBOUND_ITEM',
  'T_PURCHASE_REQUEST',
  'T_PURCHASE_REQUEST_ITEM',
  'T_PURCHASE_ORDER',
  'T_PURCHASE_ORDER_ITEM',
  'T_DAILY_STATEMENT',
  'T_DAILY_STATEMENT_DETAIL',
  'T_SETTLEMENT',
  'T_SETTLEMENT_ITEM',
  'T_EXPENSE',
  'T_SETTLEMENT_ACCOUNT_TRANSACTION',
  'T_PAYABLE',
  'T_SUPPLIER_REBATE',
];

function askConfirm() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\n⚠ 以上 32 张表数据将被清空，是否确认？(输入 yes 确认): ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  console.log('==========================================');
  console.log('  ANY-ERP 业务数据一键清空脚本');
  console.log('==========================================');
  console.log('\n将清空以下业务表（系统设置表不受影响）：\n');

  const groups = {
    '商品信息': ['T_PRODUCT', 'T_PRODUCT_PN', 'T_PRODUCT_SN', 'T_PRODUCT_BARCODE', 'T_PRODUCT_PRICE', 'T_SN_LOG', 'T_INVENTORY_WARNING'],
    '销售订单': ['T_ORDER', 'T_ORDER_ITEM', 'T_ORDER_PAYMENT', 'T_ORDER_ATTACHMENT'],
    '库存信息': ['T_INVENTORY', 'T_OUTBOUND', 'T_OUTBOUND_ITEM', 'T_TRANSFER', 'T_TRANSFER_ITEM', 'T_RETURN_STOCK', 'T_RETURN_STOCK_ITEM'],
    '入库单': ['T_INBOUND', 'T_INBOUND_ITEM'],
    '采购申请/订单': ['T_PURCHASE_REQUEST', 'T_PURCHASE_REQUEST_ITEM', 'T_PURCHASE_ORDER', 'T_PURCHASE_ORDER_ITEM'],
    '日结/结算': ['T_DAILY_STATEMENT', 'T_DAILY_STATEMENT_DETAIL', 'T_SETTLEMENT', 'T_SETTLEMENT_ITEM'],
    '费用': ['T_EXPENSE', 'T_SETTLEMENT_ACCOUNT_TRANSACTION'],
    '应付/返利': ['T_PAYABLE', 'T_SUPPLIER_REBATE'],
  };

  for (const [name, tables] of Object.entries(groups)) {
    console.log(`  【${name}】: ${tables.join(', ')}`);
  }

  console.log('\n✅ 保留：商品分类、字段配置、结算账户、收款方式、库位、供应商等');

  const confirmed = await askConfirm();
  if (!confirmed) {
    console.log('❌ 已取消，未执行清空操作。');
    process.exit(0);
    return;
  }

  let conn;
  try {
    conn = await mysql.createConnection(config);
    console.log('\n--- 开始清空 ---');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    for (const table of TABLES) {
      await conn.query(`TRUNCATE TABLE ${table}`);
      console.log(`  ✓ ${table}`);
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`\n=== ✅ 清空完成！共 ${TABLES.length} 张表 ===`);
  } catch (err) {
    console.error('\n❌ 清空失败:', err.message);
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

main();
