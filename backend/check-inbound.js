const { sequelize, Inbound, InboundItem } = require('./src/models');

async function checkInbound() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 查询入库单
    const inbounds = await Inbound.findAll({
      include: [
        { model: InboundItem, as: 'items' }
      ]
    });

    console.log(`\n找到 ${inbounds.length} 个入库单：`);
    inbounds.forEach(inbound => {
      console.log(`- ${inbound.inbound_no} (${inbound.status}) - ${inbound.store_id}`);
      if (inbound.items && inbound.items.length > 0) {
        console.log(`  商品数量: ${inbound.items.length}`);
      }
    });

    // 查询采购申请
    const { PurchaseRequest } = require('./src/models');
    const purchaseRequests = await PurchaseRequest.findAll();
    console.log(`\n找到 ${purchaseRequests.length} 个采购申请：`);
    purchaseRequests.forEach(pr => {
      console.log(`- ${pr.request_no} (${pr.status})`);
    });

  } catch (error) {
    console.error('查询失败：', error);
  } finally {
    await sequelize.close();
  }
}

checkInbound();
