const { sequelize, ProductSn } = require('./src/models');

async function check() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 查询一个ProductSn记录看一下字段
    const sn = await ProductSn.findOne();
    if (sn) {
      console.log('ProductSn字段:', Object.keys(sn.dataValues));
      console.log('数据:', sn.dataValues);
    } else {
      console.log('没有找到ProductSn记录');
    }
  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

check();