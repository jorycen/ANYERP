/**
 * 执行数据库迁移
 */
const { sequelize } = require('../models');

async function executeMigration() {
  console.log('开始执行数据库迁移...');
  
  try {
    // 连接数据库
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功');

    // 检查字段是否已存在
    const checkQuery = `
      SELECT COUNT(*) as count 
      FROM information_schema.columns 
      WHERE table_name = 'T_PURCHASE_REQUEST_ITEM' 
      AND column_name = 'store_allocations'
    `;
    
    const [checkResult] = await sequelize.query(checkQuery);
    
    if (checkResult[0].count > 0) {
      console.log('✅ store_allocations 字段已存在，无需添加');
    } else {
      // 添加字段
      const addColumnQuery = `
        ALTER TABLE T_PURCHASE_REQUEST_ITEM 
        ADD COLUMN store_allocations TEXT NULL COMMENT '门店分配信息'
      `;
      
      await sequelize.query(addColumnQuery);
      console.log('✅ 成功添加 store_allocations 字段');
    }
    
    console.log('\n数据库迁移完成！');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ 迁移失败:', error.message);
    console.error(error);
    process.exit(1);
  }
}

executeMigration();
