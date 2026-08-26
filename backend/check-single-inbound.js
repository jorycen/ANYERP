const { sequelize, Inbound, InboundItem, Product } = require('./src/models');
const { Op } = require('sequelize');

async function checkInbound() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 获取最新的入库单
    const inbound = await Inbound.findOne({
      order: [['create_time', 'DESC']],
      include: [{ model: InboundItem, as: 'items' }]
    });

    if (inbound) {
      console.log(`入库单: ${inbound.inbound_no}`);
      console.log(`入库单ID: ${inbound.inbound_id}`);
      
      if (inbound.items && inbound.items.length > 0) {
        console.log(`\n商品明细 (${inbound.items.length} 个):`);
        
        const productIds = inbound.items.map(item => item.product_id);
        const products = await Product.findAll({
          where: { product_id: { [Op.in]: productIds } }
        });
        const productMap = new Map();
        products.forEach(p => productMap.set(p.product_id, p));

        for (let index = 0; index < inbound.items.length; index++) {
          const item = inbound.items[index];
          console.log(`\n[${index + 1}] item_id: ${item.item_id}`);
          console.log(`    product_id: ${item.product_id}`);
          console.log(`    product_name: ${item.product_name || '(空)'}`);
          
          // 查找商品信息
          const product = productMap.get(item.product_id);
          if (product) {
            console.log(`    商品表名称: ${product.name}`);
            if (!item.product_name || item.product_name.trim() === '') {
              console.log(`    -> 修复中...`);
              await item.update({ product_name: product.name });
              console.log(`    -> 修复完成！`);
            }
          } else {
            console.log(`    警告: 找不到商品！`);
          }
          
          console.log(`    quantity: ${item.quantity}`);
        }
      } else {
        console.log(`没有商品明细！`);
      }
    } else {
      console.log(`没有入库单！`);
    }
  } catch (error) {
    console.error('检查失败：', error);
  } finally {
    await sequelize.close();
  }
}

checkInbound();
