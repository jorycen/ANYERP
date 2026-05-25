const { sequelize, Inbound, InboundItem } = require('./src/models');

async function checkItems() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 查询前几个入库单及其明细
    const inbounds = await Inbound.findAll({
      limit: 3,
      include: [{ model: InboundItem, as: 'items' }]
    });

    console.log('=== 入库单明细检查 ===\n');
    
    for (const inbound of inbounds) {
      console.log(`入库单: ${inbound.inbound_no}`);
      if (inbound.items && inbound.items.length > 0) {
        inbound.items.forEach(item => {
          console.log(`  - 商品ID: ${item.product_id}`);
          console.log(`    商品名称: ${item.product_name || '(空)'}`);
          console.log(`    PN码: ${item.pn_code || '(空)'}`);
          console.log(`    数量: ${item.quantity}`);
        });
      }
      console.log('');
    }

  } catch (error) {
    console.error('查询失败：', error);
  } finally {
    await sequelize.close();
  }
}

checkItems();
