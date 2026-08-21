const { sequelize, Inbound, InboundItem, Product } = require('./src/models');

async function checkInboundItems() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 获取所有入库单
    const inbounds = await Inbound.findAll({
      include: [{ model: InboundItem, as: 'items' }]
    });

    console.log(`找到 ${inbounds.length} 个入库单\n`);

    // 检查每个入库单的明细
    for (const inbound of inbounds) {
      console.log(`入库单: ${inbound.inbound_no}`);
      
      if (inbound.items && inbound.items.length > 0) {
        for (const item of inbound.items) {
          console.log(`  - 商品ID: ${item.product_id}`);
          console.log(`    商品名称: ${item.product_name || '(空)'}`);
          
          // 如果商品名称为空，尝试修复
          if (!item.product_name || item.product_name.trim() === '') {
            const product = await Product.findByPk(item.product_id);
            if (product) {
              console.log(`    正在修复商品名称为: ${product.name}`);
              await item.update({ product_name: product.name });
            }
          }
        }
      }
      console.log('');
    }

    console.log('检查完成！');
  } catch (error) {
    console.error('检查失败：', error);
  } finally {
    await sequelize.close();
  }
}

checkInboundItems();
