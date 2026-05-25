const { sequelize, ProductSn, Product, Store, Inbound } = require('./src/models');

async function checkInventory() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 查询所有SN库存
    const sns = await ProductSn.findAll({
      where: { is_deleted: 0 },
      include: [
        { model: Product, attributes: ['name'] },
        { model: Store, attributes: ['name'] }
      ]
    });

    console.log(`找到 ${sns.length} 条SN库存记录:\n`);
    
    if (sns.length > 0) {
      sns.forEach((sn, index) => {
        console.log(`[${index + 1}] SN: ${sn.sn_code}`);
        console.log(`    商品: ${sn.Product?.name || sn.product_id}`);
        console.log(`    门店: ${sn.Store?.name || sn.store_id}`);
        console.log(`    状态: ${sn.status}`);
        console.log(`    入库时间: ${sn.inbound_time}`);
        console.log('');
      });
    } else {
      console.log('没有库存数据！');
    }
    
    // 检查入库单
    const inbounds = await Inbound.findAll({
      where: { status: 'completed' },
      limit: 5
    });
    console.log(`\n找到 ${inbounds.length} 个已完成的入库单`);

  } catch (error) {
    console.error('检查失败：', error);
  } finally {
    await sequelize.close();
  }
}

checkInventory();
