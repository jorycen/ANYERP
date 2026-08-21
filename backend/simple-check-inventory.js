const { sequelize, ProductSn, Product, Store, Inbound } = require('./src/models');
const { Op } = require('sequelize');

async function checkInventory() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 查询所有SN库存
    const sns = await ProductSn.findAll({
      where: { is_deleted: 0 }
    });

    console.log(`找到 ${sns.length} 条SN库存记录:\n`);
    
    if (sns.length > 0) {
      const productIds = [...new Set(sns.map(s => s.product_id))];
      const storeIds = [...new Set(sns.map(s => s.store_id))];
      
      const products = await Product.findAll({
        where: { product_id: { [Op.in]: productIds } }
      });
      const stores = await Store.findAll({
        where: { store_id: { [Op.in]: storeIds } }
      });
      
      const productMap = new Map();
      const storeMap = new Map();
      products.forEach(p => productMap.set(p.product_id, p));
      stores.forEach(s => storeMap.set(s.store_id, s));

      sns.forEach((sn, index) => {
        const product = productMap.get(sn.product_id);
        const store = storeMap.get(sn.store_id);
        
        console.log(`[${index + 1}] SN: ${sn.sn_code}`);
        console.log(`    商品: ${product?.name || sn.product_id}`);
        console.log(`    门店: ${store?.name || sn.store_id}`);
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
