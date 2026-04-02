const bcrypt = require('bcryptjs');
const db = require('./src/config/db');
const dotenv = require('dotenv');

dotenv.config();

/**
 * 种子脚本：创建初始管理员和门店
 */
async function seed() {
  try {
    console.log('🌱 Starting Seed Process...');

    // 1. 创建演示门店
    const storeId = 'S-DEMO-STORE-001';
    await db.execute(
      'INSERT IGNORE INTO T_STORE (STORE_ID, STORE_NAME, ADDRESS) VALUES (?, ?, ?)',
      [storeId, '艾诺云演示门店', '成都市武侯区高新科技园']
    );
    console.log('✅ Store created');

    // 2. 创建管理员账号 (admin / admin123)
    const userId = 'U-ADMIN-001';
    const passwordHash = await bcrypt.hash('admin123', 10);
    await db.execute(
      'INSERT IGNORE INTO T_USER (USER_ID, USERNAME, NICKNAME, PASSWORD_HASH, ROLE, STORE_ID) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, 'admin', '系统管理员', passwordHash, 'ADMIN', storeId]
    );
    console.log('✅ Admin user created (admin / admin123)');

    // 3. 创建一些商品类目
    await db.execute('INSERT IGNORE INTO T_CATEGORY (CATEGORY_ID, CATEGORY_NAME) VALUES (1, "电脑"), (2, "手机")');
    console.log('✅ Categories created');

    // 4. 创建演示商品
    await db.execute(
      'INSERT IGNORE INTO T_PRODUCT (PN_CODE, PRODUCT_NAME, CATEGORY_ID, BASE_PRICE) VALUES (?, ?, ?, ?)',
      ['82RK0000CD', '联想拯救者 Y9000P', 1, 8999.00]
    );
    console.log('✅ Demo product created');

    console.log('✨ Seed Finished Successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed Failed:', error);
    process.exit(1);
  }
}

seed();
