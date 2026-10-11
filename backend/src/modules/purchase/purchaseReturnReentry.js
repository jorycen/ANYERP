const { Inbound, InboundItem, ReturnStockItem, ReturnStock, PurchaseRequest } = require('../../models');
const { generateInboundNo, generateUUID } = require('../../utils');

/** Create a new receiving cycle after the complete stock in an inbound has been returned. */
async function createPurchaseReturnReentry({ inbound, userName, transaction }) {
  if (!inbound?.purchase_request_id) return null;
  const request = await PurchaseRequest.findByPk(inbound.purchase_request_id, { transaction });
  if (!request || request.status !== 'approved') return null;

  const returnedItems = await ReturnStockItem.findAll({
    include: [{
      model: ReturnStock,
      where: { inbound_id: inbound.inbound_id, status: 'completed' },
      attributes: []
    }],
    transaction
  });
  const quantityByInboundItem = new Map();
  returnedItems.forEach(item => {
    const key = String(item.inbound_item_id || '');
    if (key) quantityByInboundItem.set(key, (quantityByInboundItem.get(key) || 0) + Number(item.quantity || 0));
  });
  const sourceItems = await InboundItem.findAll({ where: { inbound_id: inbound.inbound_id }, transaction });
  const rows = sourceItems.map(item => ({
    inbound_id: '',
    product_id: item.product_id,
    product_name: item.product_name,
    pn_code: item.pn_code,
    unit_price: item.unit_price,
    original_pickup_price: item.original_pickup_price,
    quantity: quantityByInboundItem.get(String(item.item_id)) || 0,
    received_quantity: 0,
    received_sn_codes: null,
    receive_user: null,
    receive_time: null,
    remark: item.remark,
    location_id: item.location_id,
    inventory_type: item.inventory_type,
    product_type: item.product_type,
    store_allocations: item.store_allocations,
    selected_resource_types: item.selected_resource_types,
    purchase_request_item_id: item.purchase_request_item_id,
    gross_profit_use_standard_price: null,
    gross_profit_uplift_amount: null
  })).filter(item => item.quantity > 0);

  if (!rows.length) return null;
  const inboundId = generateUUID();
  const now = new Date();
  rows.forEach(item => { item.inbound_id = inboundId; });
  await Inbound.create({
    inbound_id: inboundId,
    inbound_no: generateInboundNo(),
    store_id: inbound.store_id,
    source_type: 'purchase',
    source_no: inbound.source_no,
    purchase_request_id: inbound.purchase_request_id,
    total_quantity: rows.reduce((sum, item) => sum + item.quantity, 0),
    total_amount: rows.reduce((sum, item) => sum + Number(item.unit_price || 0) * item.quantity, 0),
    status: 'pending',
    create_user: userName || 'system',
    create_time: now,
    update_time: now
  }, { transaction });
  await InboundItem.bulkCreate(rows, { transaction });
  return inboundId;
}

module.exports = { createPurchaseReturnReentry };
