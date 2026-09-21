const { sequelize, PurchaseRequest } = require('../src/models');

async function hasExpressNoColumn() {
  const rows = await sequelize.query(
    `SELECT COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PURCHASE_REQUEST'
       AND COLUMN_NAME = 'EXPRESS_NO'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  return rows.length > 0;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await sequelize.authenticate();

  if (await hasExpressNoColumn()) {
    console.log('T_PURCHASE_REQUEST.EXPRESS_NO 已存在，无需修复');
  } else if (!apply) {
    console.log('检查结果：缺少 T_PURCHASE_REQUEST.EXPRESS_NO；使用 --apply 执行修复');
    return;
  } else {
    await sequelize.query(
      'ALTER TABLE T_PURCHASE_REQUEST ADD COLUMN EXPRESS_NO VARCHAR(128) NULL COMMENT "快递单号" AFTER INVOICE_TYPE'
    );
    console.log('已添加 T_PURCHASE_REQUEST.EXPRESS_NO');
  }

  await PurchaseRequest.findOne({ attributes: ['request_id', 'express_no'], limit: 1 });
  console.log('采购申请模型字段查询验证通过');
}

main()
  .catch(error => {
    console.error(`修复失败：${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
