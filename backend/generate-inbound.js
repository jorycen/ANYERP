const { sequelize, PurchaseRequest, PurchaseRequestItem, Inbound, InboundItem } = require('./src/models');
const { generateInboundNo, generateUUID } = require('./src/utils');

async function generateMissingInbounds() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 查询所有已批准但没有入库单的采购申请
    const purchaseRequests = await PurchaseRequest.findAll({
      where: { status: 'approved' },
      include: [{ model: PurchaseRequestItem, as: 'items' }]
    });

    console.log(`找到 ${purchaseRequests.length} 个已批准的采购申请`);

    for (const request of purchaseRequests) {
      // 检查是否已经有入库单
      const existingInbound = await Inbound.findOne({
        where: { purchase_request_id: request.request_id }
      });

      if (existingInbound) {
        console.log(`采购申请 ${request.request_no} 已有入库单，跳过`);
        continue;
      }

      if (!request.items || request.items.length === 0) {
        console.log(`采购申请 ${request.request_no} 没有商品，跳过`);
        continue;
      }

      console.log(`正在为采购申请 ${request.request_no} 创建入库单...`);

      // 按照门店分配创建入库单
      const storeItemsMap = new Map();

      // 解析门店分配并按门店分组
      for (const item of request.items) {
        let allocations = [];
        if (item.store_allocations) {
          try {
            allocations = JSON.parse(item.store_allocations);
          } catch (e) {
            // 解析失败，默认分配到申请门店
            allocations = [{ storeId: request.store_id, quantity: item.quantity }];
          }
        }

        // 如果没有分配，默认分配到申请门店
        if (allocations.length === 0) {
          allocations = [{ storeId: request.store_id, quantity: item.quantity }];
        }

        for (const alloc of allocations) {
          const storeId = alloc.storeId || request.store_id;
          if (!storeItemsMap.has(storeId)) {
            storeItemsMap.set(storeId, []);
          }
          storeItemsMap.get(storeId).push({
            ...item.toJSON(),
            allocatedQuantity: alloc.quantity || item.quantity
          });
        }
      }

      // 为每个门店创建入库单
      for (const [storeId, items] of storeItemsMap.entries()) {
        const inboundNo = generateInboundNo();
        const inboundId = generateUUID();

        const totalQuantity = items.reduce((sum, item) => sum + (item.allocatedQuantity || item.quantity), 0);
        const totalAmount = items.reduce((sum, item) => 
          sum + (item.unit_price || 0) * (item.allocatedQuantity || item.quantity), 0);

        // 创建入库单
        await Inbound.create({
          inbound_id: inboundId,
          inbound_no: inboundNo,
          store_id: storeId,
          source_type: 'purchase',
          source_no: request.request_no,
          purchase_request_id: request.request_id,
          total_amount: totalAmount,
          total_quantity: totalQuantity,
          status: 'pending',
          create_user: request.apply_user || 'system',
          create_time: new Date(),
          update_time: new Date()
        });

        // 创建入库明细
        for (const item of items) {
          await InboundItem.create({
            inbound_id: inboundId,
            product_id: item.product_id,
            product_name: item.product_name,
            pn_code: item.pn_code,
            unit_price: item.unit_price,
            quantity: item.allocatedQuantity || item.quantity,
            store_allocations: JSON.stringify([{
              storeId: storeId,
              quantity: item.allocatedQuantity || item.quantity
            }])
          });
        }

        console.log(`  ✓ 为门店 ${storeId} 创建入库单 ${inboundNo}，包含 ${items.length} 个商品`);
      }
    }

    console.log('\n入库单生成完成！');

  } catch (error) {
    console.error('操作失败：', error);
  } finally {
    await sequelize.close();
  }
}

generateMissingInbounds();
