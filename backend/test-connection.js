
/**
 * 数据库连接和模型关联测试
 */
const { sequelize, Inbound, InboundItem, Store } = require('./src/models');

async function test() {
  try {
    console.log('=== 数据库连接测试 ===');
    await sequelize.authenticate();
    console.log('Database connected successfully');

    console.log('\n=== 测试查询入库单 ===');
    const inbounds = await Inbound.findAll({
      limit: 3,
      include: [
        { model: InboundItem, as: 'items' }
      ]
    });
    console.log('Found', inbounds.length, 'inbounds');
    
    for (let i = 0; i &lt; inbounds.length; i++) {
      const inbound = inbounds[i];
      console.log('\nInbound', i + 1, ':');
      console.log('  ID:', inbound.inbound_id);
      console.log('  No:', inbound.inbound_no);
      console.log('  Status:', inbound.status);
      console.log('  Items count:', inbound.items ? inbound.items.length : 0);
    }

    console.log('\n=== 直接查询入库明细 ===');
    const items = await InboundItem.findAll({ limit: 5 });
    console.log('Found', items.length, 'items');

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await sequelize.close();
    console.log('\n=== Test completed ===');
  }
}

test();
