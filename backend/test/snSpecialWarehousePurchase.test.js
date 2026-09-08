const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const purchaseController = require('../src/modules/purchase/controller');

const source = fs.readFileSync(path.join(__dirname, '../src/modules/purchase/controller.js'), 'utf8');

test('特殊仓SN采购从门店库位分配解析目标库位', () => {
  assert.deepEqual(purchaseController._test.getSnPurchaseFields({
    sourceSnId: 'SN_1',
    storeAllocations: [{
      storeId: 'STORE_1',
      quantity: 1,
      locationAllocations: [{ locationId: 'LOC_SALES', quantity: 1 }]
    }]
  }), { sourceSnId: 'SN_1', targetLocationId: 'LOC_SALES' });
});

test('特殊仓SN采购审批转换库存且不生成待入库单', () => {
  assert.match(source, /SN_PURCHASE_SOURCE_TYPES[\s\S]*display_qty[\s\S]*rental_demo_qty/);
  assert.match(source, /SN_PURCHASE_TARGET_TYPES[\s\S]*normal_qty[\s\S]*demo_qty/);
  assert.match(source, /validateSnPurchaseConversion\(ctx, request\.items[\s\S]*approval: true/);
  assert.match(source, /await moveSnInventoryAggregate\(/);
  assert.match(source, /action: 'special_warehouse_purchase'/);
  assert.match(source, /特殊仓SN采购已在同一事务内完成库位转换，不再生成待入库单/);
});

test('特殊仓SN采购保存来源SN和目标库位并阻止重复未结束申请', () => {
  assert.match(source, /source_sn_id: getSnPurchaseFields\(item\)\.sourceSnId/);
  assert.match(source, /target_location_id: getSnPurchaseFields\(item\)\.targetLocationId/);
  assert.match(source, /status: \{ \[Op\.in\]: \['draft', 'pending'\] \}/);
  assert.match(source, /该SN已有未结束的采购申请/);
  assert.match(source, /特殊仓SN采购请直接提交审批，不支持保存草稿/);
});
