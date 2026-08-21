const { sequelize, PurchaseRequest, PurchaseRequestItem, Product, Inbound, InboundItem } = require('./src/models');

async function fixProductNames() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 获取所有商品
    const products = await Product.findAll();
    const productMap = new Map();
    products.forEach(p => {
      productMap.set(p.product_id, p);
    });
    console.log(`加载了 ${products.length} 个商品\n`);

    // 检查并修复采购申请明细
    console.log('=== 检查采购申请明细 ===');
    const prItems = await PurchaseRequestItem.findAll();
    let prFixedCount = 0;
    
    for (const item of prItems) {
      if (!item.product_name || item.product_name.trim() === '') {
        const product = productMap.get(item.product_id);
        if (product) {
          console.log(`  修复采购明细: ${item.product_id} - ${product.name}`);
          await item.update({ product_name: product.name });
          prFixedCount++;
        }
      }
    }
    console.log(`修复了 ${prFixedCount} 个采购申请明细\n`);

    // 检查并修复入库单明细
    console.log('=== 检查入库单明细 ===');
    const inboundItems = await InboundItem.findAll();
    let ibFixedCount = 0;
    
    for (const item of inboundItems) {
      if (!item.product_name || item.product_name.trim() === '') {
        const product = productMap.get(item.product_id);
        if (product) {
          console.log(`  修复入库明细: ${item.product_id} - ${product.name}`);
          await item.update({ product_name: product.name });
          ibFixedCount++;
        }
      }
    }
    console.log(`修复了 ${ibFixedCount} 个入库单明细\n`);

    console.log('修复完成！');

  } catch (error) {
    console.error('操作失败：', error);
  } finally {
    await sequelize.close();
  }
}

fixProductNames();
