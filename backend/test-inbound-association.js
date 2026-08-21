/**
 * 测试入库单与明细的关联查询
 */
const { sequelize, Inbound, InboundItem } = require('./src/models');

async function testAssociation() {
  try {
    console.log('正在测试入库单与明细的关联查询...\n');
    
    // 首先查询所有入库单
    console.log('1. 查询所有入库单:');
    const allInbounds = await Inbound.findAll();
    console.log(`   找到 ${allInbounds.length} 个入库单\n`);
    
    if (allInbounds.length > 0) {
      // 取第一个入库单进行关联查询测试
      const firstInboundId = allInbounds[0].inbound_id;
      console.log(`2. 测试入库单 ${firstInboundId} 的关联查询:`);
      
      // 使用 findByPk 并包含关联的 items
      const inbound = await Inbound.findByPk(firstInboundId, {
        include: [{ model: InboundItem, as: 'items' }]
      });
      
      if (inbound) {
        console.log(`   - 入库单号: ${inbound.inbound_no}`);
        console.log(`   - 状态: ${inbound.status}`);
        console.log(`   - 关联的 items 数量: ${inbound.items ? inbound.items.length : 0}`);
        
        if (inbound.items && inbound.items.length > 0) {
          console.log('   - 明细列表:');
          inbound.items.forEach((item, index) => {
            console.log(`     ${index + 1}. 商品ID: ${item.product_id}, 名称: ${item.product_name}, 数量: ${item.quantity}`);
          });
        } else {
          console.log('   - 没有找到关联的商品明细!');
          
          // 直接查询该入库单的明细
          console.log('\n3. 直接查询该入库单的明细 (不使用关联):');
          const directItems = await InboundItem.findAll({
            where: { inbound_id: firstInboundId }
          });
          console.log(`   直接查询到 ${directItems.length} 个明细`);
          
          if (directItems.length > 0) {
            console.log('   - 明细列表:');
            directItems.forEach((item, index) => {
              console.log(`     ${index + 1}. 商品ID: ${item.product_id}, 名称: ${item.product_name}, 数量: ${item.quantity}`);
            });
          }
        }
      }
    } else {
      console.log('没有找到入库单数据，无法进行测试');
    }
    
    console.log('\n测试完成!');
    
  } catch (error) {
    console.error('测试过程中出错:', error);
  } finally {
    await sequelize.close();
  }
}

testAssociation();
