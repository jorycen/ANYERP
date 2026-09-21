const { sequelize, PurchaseRequest, PurchaseRequestItem, Supplier, DailyStatementDetail } = require('../src/models');

const columns = [
  {
    table: 'T_PURCHASE_REQUEST',
    column: 'EXPRESS_NO',
    definition: 'VARCHAR(128) NULL COMMENT "快递单号" AFTER INVOICE_TYPE'
  },
  {
    table: 'T_PURCHASE_REQUEST_ITEM',
    column: 'NEW_PRODUCT_PAYLOAD',
    definition: 'TEXT NULL COMMENT "二手商品完整建档信息JSON" AFTER DIRECT_INBOUND_SN_CODE'
  },
  {
    table: 'T_DAILY_STATEMENT_DETAIL',
    column: 'UNIONPAY_ORDER_NO',
    definition: 'VARCHAR(128) NULL COMMENT "云闪付订单号" AFTER BUSINESS_TYPE'
  },
  {
    table: 'T_DAILY_STATEMENT_DETAIL',
    column: 'SOURCE_TYPE',
    definition: 'VARCHAR(32) DEFAULT "system" COMMENT "数据来源：system/manual" AFTER UNIONPAY_ORDER_NO'
  },
  {
    table: 'T_DAILY_STATEMENT_DETAIL',
    column: 'REMARK',
    definition: 'VARCHAR(512) NULL COMMENT "备注" AFTER SOURCE_TYPE'
  },
  {
    table: 'T_DAILY_STATEMENT_DETAIL',
    column: 'CREATE_USER',
    definition: 'VARCHAR(64) NULL COMMENT "创建人" AFTER REMARK'
  },
  {
    table: 'T_DAILY_STATEMENT_DETAIL',
    column: 'CREATE_TIME',
    definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间" AFTER CREATE_USER'
  }
];

async function existingColumns() {
  const rows = await sequelize.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('T_PURCHASE_REQUEST', 'T_PURCHASE_REQUEST_ITEM', 'T_DAILY_STATEMENT_DETAIL')`,
    { type: sequelize.QueryTypes.SELECT }
  );
  return new Set(rows.map(row => `${String(row.TABLE_NAME).toUpperCase()}.${String(row.COLUMN_NAME).toUpperCase()}`));
}

async function main() {
  const apply = process.argv.includes('--apply');
  await sequelize.authenticate();
  const existing = await existingColumns();
  const missing = columns.filter(item => !existing.has(`${item.table}.${item.column}`));

  if (!missing.length) {
    console.log('运行时模型依赖字段均已存在，无需修复');
  } else {
    console.log(`发现 ${missing.length} 个缺失字段：${missing.map(item => `${item.table}.${item.column}`).join('、')}`);
    if (!apply) {
      console.log('当前为预检模式；使用 --apply 执行修复');
      return;
    }
    for (const item of missing) {
      await sequelize.query(`ALTER TABLE ${item.table} ADD COLUMN ${item.column} ${item.definition}`);
      console.log(`已添加 ${item.table}.${item.column}`);
    }
    console.log('缺失字段修复完成');
  }

  await PurchaseRequest.findOne({
    include: [
      { model: Supplier, required: false },
      { model: PurchaseRequestItem, as: 'items', required: false }
    ]
  });
  await DailyStatementDetail.findOne();
  console.log('采购申请及日结明细真实查询验证通过');
}

main()
  .catch(error => {
    console.error(`修复失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
