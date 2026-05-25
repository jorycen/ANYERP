const { sequelize, PurchaseRequest, PurchaseRequestItem, Inbound, InboundItem } = require('./src/models');

async function detailCheck() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 查询所有采购申请及其入库单
    const purchaseRequests = await PurchaseRequest.findAll({
      include: [
        { model: PurchaseRequestItem, as: 'items' },
        { model: Inbound }
      ]
    });

    console.log(`=== 采购申请详情检查 ===\n`);
    
    for (const request of purchaseRequests) {
      console.log(`采购申请: ${request.request_no} (${request.status})`);
      console.log(`  申请门店: ${request.store_id}`);
      console.log(`  商品数量: ${request.items ? request.items.length : 0}`);
      
      if (request.Inbounds && request.Inbounds.length > 0) {
        console.log(`  关联入库单: ${request.Inbounds.length} 个`);
        request.Inbounds.forEach(inbound => {
          console.log(`    - ${inbound.inbound_no} (${inbound.status}) - ${inbound.store_id}`);
        });
      } else {
        console.log(`  关联入库单: 无`);
      }
      
      if (request.items && request.items.length > 0) {
        console.log(`  商品明细:`);
        request.items.forEach(item => {
          console.log(`    - ${item.product_name} x ${item.quantity}`);
          if (item.store_allocations) {
            try {
              const alloc = JSON.parse(item.store_allocations);
              console.log(`      门店分配: ${JSON.stringify(alloc)}`);
            } catch (e) {
              console.log(`      门店分配: ${item.store_allocations}`);
            }
          }
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

detailCheck();
