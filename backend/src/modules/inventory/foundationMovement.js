// Capture provenance before stock leaves. Receiving never guesses from today's
// source inventory, a product default, or the most recent purchase.
const { Op, literal } = require('sequelize');
const { remainingLayers, takeLayers } = require('./foundationCostLayers');
const M = require('../../models');
const F = require('./foundation');
const plain = row => row?.toJSON ? row.toJSON() : row;
function consensus(productId, facts, source) {
  const valid = facts.length && facts.every(f => f && f.status === 'confirmed'
    && ['收据', '专票13%'].includes(f.invoiceType) && !f.source?.taxScope);
  const types = new Set(facts.map(f => f?.invoiceType));
  const confirmed = valid && types.size === 1;
  const prices = new Set(facts.map(f => f?.purchaseCost));
  const uniform = fact => !Array.isArray(fact.source?.costLayers) ||
    fact.source.costLayers.every(layer => layer.unitCost === fact.purchaseCost);
  const hasUniformCost = facts.length > 0 && facts.every(f => f?.purchaseCost != null && f.status !== 'conflict' && uniform(f)) && prices.size === 1;
  return { productId, unitCost: hasUniformCost ? facts[0].purchaseCost : null,
    zeroCostConfirmed: hasUniformCost && facts[0].purchaseCost === 0,
    costEstimated: hasUniformCost && facts.some(f => f.costEstimated),
    invoiceType: confirmed ? facts[0].invoiceType : null,
    source, basisIds: facts.map(f => f?.basisId).filter(Boolean),
    reason: confirmed ? '流转原始票税依据一致' : '流转来源缺失、未确认或存在不同票种' };
}
async function inventoryReceipt(productId, storeId, field, locationId, transaction, quantity) {
  const rows = await M.Inventory.findAll({ where: { product_id: productId, store_id: storeId,
    ...(locationId ? { location_id: locationId } : {}), [field]: { [Op.gt]: 0 } }, order: [[literal("CASE WHEN LOCATION_ID = '' THEN 1 ELSE 0 END"), 'ASC'], [field, 'DESC']],
    transaction, lock: transaction?.LOCK?.UPDATE });
  const facts = [];
  const layers = [];
  let remaining = Number(quantity) || 0;
  for (const row of rows) {
    const ref = await M.InventoryFoundationRef.findByPk(`inventory:${row.inventory_id}:${field}`, { transaction });
    const basis = ref && await M.InventoryFoundation.findByPk(ref.basis_id, { transaction });
    const fact = F.view(plain(basis));
    const matched = String(fact.productId) === String(productId) ? fact : null;
    facts.push(matched);
    if (remaining > 0) {
      const held = Number(row[field]);
      const take = Math.min(held, remaining);
      layers.push(...takeLayers(remainingLayers(matched, held), take));
      remaining -= take;
    }
  }
  const receipt = consensus(productId, facts, 'inventory_movement');
  if (quantity > 0 && remaining === 0) receipt.costLayers = layers;
  return receipt;
}
async function referenceReceipt(key, productId, transaction) {
  const ref = await M.InventoryFoundationRef.findByPk(key, { transaction });
  const basis = ref && await M.InventoryFoundation.findByPk(ref.basis_id, { transaction });
  const fact = F.view(plain(basis));
  if (String(fact.productId) !== String(productId)) return consensus(productId, [], key);
  const receipt = consensus(productId, [fact], key);
  if (fact.source?.movement?.costEstimated || fact.costEstimated) receipt.costEstimated = true;
  if (Array.isArray(fact.source?.movement?.costLayers)) receipt.costLayers = fact.source.movement.costLayers;
  return receipt;
}
async function save(key, productId, receipt, transaction) {
  const basisId = F.id(key);
  let basis = await M.InventoryFoundation.findByPk(basisId, { transaction, lock: transaction?.LOCK?.UPDATE });
  if (!basis) basis = await M.InventoryFoundation.create({ basis_id: basisId, identity_key: key,
    product_id: productId, entity_type: 'movement', purchase_cost: receipt.unitCost ?? null, invoice_type: receipt.invoiceType,
    status: receipt.invoiceType ? 'confirmed' : 'pending', source_data: { movement: receipt },
    reason: receipt.reason, revision: 1, updated_by: 'system' }, { transaction });
  await F.bind(key, basisId, '', transaction);
  return referenceReceipt(key, productId, transaction);
}
async function saveInventory(key, productId, storeId, field, locationId, transaction, quantity) {
  return save(key, productId, await inventoryReceipt(productId, storeId, field, locationId, transaction, quantity), transaction);
}
async function returnReceipt(inbound, item, transaction) {
  const request = await M.SalesReturnRequest.findOne({ where: { return_no: inbound.source_no }, transaction });
  if (!request) return consensus(item.product_id, [], 'sales_return_missing');
  const returns = await M.SalesReturnRequestItem.findAll({ where: { return_id: request.return_id, product_id: item.product_id }, transaction });
  const matching = returns.filter(r => !item.sn_code || String(r.sn_code || '').trim().toLowerCase() === String(item.sn_code).trim().toLowerCase());
  const receipts = [];
  for (const row of matching) {
    if (!row.order_item_id) return consensus(item.product_id, [], 'sales_return_item_missing');
    const original = await M.OrderItem.findByPk(row.order_item_id, { transaction });
    if (!original || original.order_id !== request.order_id || original.product_id !== item.product_id) return consensus(item.product_id, [], 'sales_return_identity_conflict');
    const receipt = await referenceReceipt(`order_item:${row.order_item_id}`, item.product_id, transaction);
    if (!receipt.invoiceType || receipt.unitCost === null) {
      const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: request.order_id, snapshot_status: 'final' }, transaction });
      let lines = snapshot?.product_pricing_details;
      if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch (_) { lines = []; } }
      const line = (Array.isArray(lines) ? lines : []).find(l => String(l.itemId) === String(row.order_item_id) && l.productId === item.product_id);
      const tax = line?.purchaseTaxBasis;
      if (!receipt.invoiceType && tax?.status === 'confirmed' && ['收据', '专票13%'].includes(tax.invoiceType) && !tax.taxScope
        && (tax.purchaseId || tax.receiptItemId || tax.source === 'all_matching_purchase_candidates_agree')) {
        receipt.invoiceType = tax.invoiceType;
      }
      // The original archived purchase amount is acquisition cost, while
      // sales settlement pricing can include company pricing and adjustments.
      if (receipt.unitCost === null) {
        const savedPrice = F.money(line?.purchasePrice);
        const originalCost = F.money(original.original_inventory_cost);
        if (savedPrice > 0 && line.purchasePriceKnown !== false) receipt.unitCost = savedPrice;
        else if (originalCost > 0) {
          receipt.unitCost = originalCost;
          receipt.costEstimated = true;
        }
        else if (savedPrice === 0 && line.purchasePriceKnown === true) receipt.unitCost = 0;
      }
    }
    receipts.push({ basisId: receipt.basisIds[0], invoiceType: receipt.invoiceType, purchaseCost: receipt.unitCost,
      costEstimated: receipt.costEstimated, quantity: Number(row.quantity),
      status: receipt.invoiceType ? 'confirmed' : 'pending' });
  }
  const result = consensus(item.product_id, receipts, `sales_return:${request.return_id}`);
  if (receipts.length && receipts.every(row => row.quantity > 0) &&
    receipts.reduce((sum, row) => sum + row.quantity, 0) === Number(item.quantity)) {
    result.costLayers = receipts.map(row => ({
      quantity: row.quantity, unitCost: row.purchaseCost, invoiceType: row.invoiceType, estimated: Boolean(row.costEstimated)
    }));
  }
  return result;
}
async function transferReceipt(inbound, item, transaction) {
  const transfer = await M.Transfer.findOne({ where: { transfer_no: inbound.source_no }, transaction });
  if (!transfer) return consensus(item.product_id, [], 'transfer_missing');
  const items = await M.TransferItem.findAll({ where: { transfer_id: transfer.transfer_id, product_id: item.product_id }, transaction });
  const facts = [];
  const layers = [];
  for (const row of items) {
    const receipt = await referenceReceipt(`transfer_item:${row.item_id}`, item.product_id, transaction);
    facts.push({ invoiceType: receipt.invoiceType, purchaseCost: receipt.unitCost, costEstimated: receipt.costEstimated, status: receipt.invoiceType ? 'confirmed' : 'pending', basisId: receipt.basisIds[0] });
    const quantity = Number(row.quantity);
    if (quantity > 0) {
      if (receipt.costLayers?.reduce((sum, layer) => sum + layer.quantity, 0) === quantity) layers.push(...receipt.costLayers);
      else layers.push({ quantity, unitCost: receipt.unitCost, invoiceType: receipt.invoiceType, estimated: Boolean(receipt.costEstimated) });
    }
  }
  const result = consensus(item.product_id, facts, `transfer:${transfer.transfer_id}`);
  if (layers.length && layers.reduce((sum, layer) => sum + layer.quantity, 0) === Number(item.quantity)) result.costLayers = layers;
  return result;
}
module.exports = { consensus, inventoryReceipt, referenceReceipt, save, saveInventory, returnReceipt, transferReceipt };
