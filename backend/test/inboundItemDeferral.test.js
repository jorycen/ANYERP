const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('采购入库按商品明细暂缓而不是整单暂缓', () => {
  const inventoryView = read('frontend/web/src/views/Inventory.vue');
  const controller = read('backend/src/modules/inventory/controller.js');

  assert.match(inventoryView, /item\.receiveEnabled \? '本次入库' : '暂缓入库'/);
  assert.match(inventoryView, /if \(product\.receiveEnabled === false\)/);
  assert.match(inventoryView, /deferredItemIds: \[\.\.\.new Set/);
  assert.doesNotMatch(inventoryView, /submitInbound\(true\)/);
  assert.match(controller, /requestedDeferredItemIds/);
  assert.match(controller, /未到商品继续保留待入库/);
});
