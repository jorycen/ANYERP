/**
 * 执行采购相关数据库迁移
 */
const { sequelize } = require('../models');

async function executeMigration() {
  console.log('开始执行采购数据库迁移...');
  
  try {
    // 连接数据库
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功');

    // 检查并添加字段
    // 1. 检查 T_PURCHASE_REQUEST_ITEM 的 store_allocations
    const checkItemField = `
      SELECT COUNT(*) as count 
      FROM information_schema.columns 
      WHERE table_name = 'T_PURCHASE_REQUEST_ITEM' 
      AND column_name = 'store_allocations'
    `;
    
    const [itemFieldResult] = await sequelize.query(checkItemField);
    if (itemFieldResult[0].count === 0) {
      await sequelize.query(`
        ALTER TABLE T_PURCHASE_REQUEST_ITEM ADD COLUMN store_allocations TEXT NULL COMMENT '门店分配信息'
      `);
      console.log('✅ 添加 T_PURCHASE_REQUEST_ITEM.store_allocations 成功');
    } else {
      console.log('✅ T_PURCHASE_REQUEST_ITEM.store_allocations 已存在');
    }

    // 2. 检查 T_PURCHASE_REQUEST 的 create_time 和 update_time
    const checkRequestFields = `
      SELECT COUNT(*) as count 
      FROM information_schema.columns 
      WHERE table_name = 'T_PURCHASE_REQUEST' 
      AND column_name IN ('create_time', 'update_time')
    `;
    
    const [requestFieldResult] = await sequelize.query(checkRequestFields);
    if (requestFieldResult[0].count < 2) {
      if (requestFieldResult[0].count === 0) {
        await sequelize.query(`ALTER TABLE T_PURCHASE_REQUEST ADD COLUMN create_time DATETIME NULL COMMENT '创建时间'`);
        await sequelize.query(`ALTER TABLE T_PURCHASE_REQUEST ADD COLUMN update_time DATETIME NULL COMMENT '更新时间'`);
      } else {
        // 检查缺失的是哪个字段
        const [createTimeCheck] = await sequelize.query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'T_PURCHASE_REQUEST' AND column_name = 'create_time'
        `);
        if (createTimeCheck[0].count === 0) {
          await sequelize.query(`ALTER TABLE T_PURCHASE_REQUEST ADD COLUMN create_time DATETIME NULL COMMENT '创建时间'`);
        }
        const [updateTimeCheck] = await sequelize.query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'T_PURCHASE_REQUEST' AND column_name = 'update_time'
        `);
        if (updateTimeCheck[0].count === 0) {
          await sequelize.query(`ALTER TABLE T_PURCHASE_REQUEST ADD COLUMN update_time DATETIME NULL COMMENT '更新时间'`);
        }
      }
      console.log('✅ 添加 T_PURCHASE_REQUEST 时间字段成功');
    } else {
      console.log('✅ T_PURCHASE_REQUEST 时间字段已存在');
    }

    // 3. 检查 T_SUPPLIER 的 create_time 和 update_time
    const checkSupplierFields = `
      SELECT COUNT(*) as count 
      FROM information_schema.columns 
      WHERE table_name = 'T_SUPPLIER' 
      AND column_name IN ('create_time', 'update_time')
    `;
    
    const [supplierFieldResult] = await sequelize.query(checkSupplierFields);
    if (supplierFieldResult[0].count < 2) {
      if (supplierFieldResult[0].count === 0) {
        await sequelize.query(`ALTER TABLE T_SUPPLIER ADD COLUMN create_time DATETIME NULL COMMENT '创建时间'`);
        await sequelize.query(`ALTER TABLE T_SUPPLIER ADD COLUMN update_time DATETIME NULL COMMENT '更新时间'`);
      } else {
        // 检查缺失的是哪个字段
        const [createTimeCheck] = await sequelize.query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'T_SUPPLIER' AND column_name = 'create_time'
        `);
        if (createTimeCheck[0].count === 0) {
          await sequelize.query(`ALTER TABLE T_SUPPLIER ADD COLUMN create_time DATETIME NULL COMMENT '创建时间'`);
        }
        const [updateTimeCheck] = await sequelize.query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'T_SUPPLIER' AND column_name = 'update_time'
        `);
        if (updateTimeCheck[0].count === 0) {
          await sequelize.query(`ALTER TABLE T_SUPPLIER ADD COLUMN update_time DATETIME NULL COMMENT '更新时间'`);
        }
      }
      console.log('✅ 添加 T_SUPPLIER 时间字段成功');
    } else {
      console.log('✅ T_SUPPLIER 时间字段已存在');
    }
    
    console.log('\n✅ 数据库迁移全部完成！');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ 迁移失败:', error.message);
    if (error.sql) {
      console.error('执行的 SQL:', error.sql);
    }
    process.exit(1);
  }
}

executeMigration();
