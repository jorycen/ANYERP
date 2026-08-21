const { sequelize, Inbound, InboundItem, Product } = require('./src/models');

async function fixAllInboundNames() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 获取所有入库单及其明细
    const inbounds = await Inbound.findAll({
      include: [{ model: InboundItem, as: 'items' }]
    });

    console.log(`找到 ${inbounds.length} 个入库单\n`);

    // 获取所有商品
    const products = await Product.findAll();
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));
    console.log(`加载了 ${products.length} 个商品\n`);

    // 检查并修复每个入库单的明细
    let updatedCount = 0;
    for (const inbound of inbounds) {
      console.log(`检查入库单: ${inbound.inbound_no}`);
      
      if (inbound.items && inbound.items.length > 0) {
        for (const item of inbound.items) {
          // 检查并修复商品名称
          if (!item.product_name || item.product_name.trim() === '') {
            const product = productMap.get(item.product_id);
            if (product) {
              console.log(`  - 修复商品: ${item.product_id} -> ${product.name}`);
              await item.update({ product_name: product.name });
              updatedCount++;
            } else {
              console.log(`  - 警告: 找不到商品 ${item.product_id}`);
            }
          } else {
            console.log(`  - 商品: ${item.product_name} (已正确)`);
          }
        }
      }
      console.log('');
    }

    console.log(`修复完成！共更新了 ${updatedCount} 条记录`);
  } catch (error) {
    console.error('修复失败：', error);
  } finally {
    await sequelize.close();
  }
}

fixAllInboundNames();
