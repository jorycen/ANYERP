const { normalizeSnCode } = require('../../utils/snCode');
const M = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, generateInboundNo } = require('../../utils');
const { canAccessDistributor } = require('../../utils/distributorScope');
const { resolveInventoryWriteLocation } = require('../../utils/inventoryLocation');
const { recordBusinessAction } = require('../../utils/businessActionLog');

const RECOVERY = 'SALES_COMPONENT_RECOVERY';
const ARCHIVED = ['已归档', 'completed', 'archived'];
const parse = row => JSON.parse(row.payload_json);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const money = value => Math.round(Number(value) * 100) / 100;
function amount(value, label) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value ?? '')) || !Number.isFinite(Number(value)) || Number(value) > 99999999) fail(400, `${label}必须明确填写非负金额，最多两位小数`);
  return money(value);
}
function visible(user, storeId, distributorId) {
  if (!(user.accessibleStoreIds || []).some(id => id === '*' || String(id) === String(storeId)) || !canAccessDistributor(user, distributorId)) fail(403, '无权操作该门店或经销商的数据');
}
async function sourceOrder(orderId, user, transaction) {
  const order = await M.Order.findByPk(orderId, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!order) fail(404, '销售订单不存在');
  const store = await M.Store.findByPk(order.store_id, { transaction });
  visible(user, order.store_id, store?.distributor_id);
  if (!ARCHIVED.includes(order.order_status)) fail(409, '仅已归档且未进入退单的销售订单可以拆机回收');
  const returns = await M.SalesReturnRequest.findOne({ where: { order_id: orderId, status: { [Op.notIn]: ['rejected', 'cancelled'] } }, transaction });
  if (returns) fail(409, '该订单存在退单记录，请先处理退单，不能拆机回收');
  return { order, store };
}
async function validateItems(rows, sourceItems, transaction, storeId = null) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 30) fail(400, '请填写1至30条入库明细');
  const seen = new Set();
  const result = [];
  for (const raw of rows) {
    const product = await M.Product.findOne({ where: { product_id: raw.productId, status: 1, is_deleted: 0 }, transaction });
    if (!product) fail(400, '请选择有效且启用的入库商品');
    const source = sourceItems ? sourceItems.find(row => String(row.item_id) === String(raw.orderItemId)) : null;
    if (sourceItems && !source) fail(400, '原商品行不属于当前销售订单');
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10000) fail(400, '入库数量必须为1至10000的整数');
    let snCode = normalizeSnCode(raw.snCode || '');
    if (Number(product.need_sn) === 1 && (quantity !== 1 || !snCode)) fail(400, 'SN商品请逐件填写配件SN或内部追溯码，数量为1');
    if (Number(product.need_sn) !== 1 && snCode) fail(400, '该商品不按SN管理，请留空SN；需要逐件追溯时请先使用SN管理的商品');
    if (snCode.length > 128) fail(400, 'SN最长128字符');
    const inventory = require('./controller');
    const existingSn = snCode ? await inventory.findInboundSnByIdentity({ snCode, transaction }) : null;
    if (raw.existingSnId && (!existingSn || String(existingSn.sn_id) !== String(raw.existingSnId))) fail(409, `SN ${snCode} 的历史记录已变化，请重新核对`);
    if (existingSn) {
      if (Number(existingSn.is_deleted) === 1) fail(409, `SN ${snCode} 的历史记录已停用，请先核对`);
      if (String(existingSn.product_id) !== String(product.product_id)) fail(409, `SN ${snCode} 属于其他商品，不能作为当前配件入库`);
      if (!sourceItems || !inventory.isReusableInboundSnStatus(existingSn.status)) fail(409, `SN ${snCode} 已存在，当前状态为 ${existingSn.status || '未知'}，不能重复入库`);
      if (!storeId || String(existingSn.store_id) !== String(storeId)) fail(409, `SN ${snCode} 属于其他门店，请先核对原销售或退库记录`);
      // 复用同一件实物的SN身份，入库执行仍重新校验并锁定状态，不创建第二条记录。
      snCode = normalizeSnCode(existingSn.sn_code);
    }
    // 无SN商品沿用商品级计价；不能偷偷修改其他库存的商品主档口径。
    if (Number(product.need_sn) !== 1 && product.gross_profit_cost_mode !== 'COMPANY_PRICE') fail(400, `请先在商品管理将 ${product.name} 设置为按公司定价核算`);
    const price = await M.ProductPrice.findOne({ where: { product_id: product.product_id, status: 1 }, order: [['effective_time', 'DESC']], transaction });
    if (!price || !(Number(price.standard_price) > 0)) fail(400, `${product.name} 尚未配置有效公司定价，请先配置`);
    const key = `${source?.item_id || ''}:${product.product_id}`;
    if (seen.has(snCode ? `sn:${snCode.toUpperCase()}` : key)) fail(400, '同一商品请合并数量，SN不能重复');
    seen.add(snCode ? `sn:${snCode.toUpperCase()}` : key);
    result.push({ productId: product.product_id, productName: product.name, quantity, snCode,
      needSn: Number(product.need_sn) === 1, pnCode: String(raw.pnCode || product.manufacturer_code || '').split(/[,，;；\s]+/)[0],
      orderItemId: source?.item_id || null, sourceProductId: source?.product_id || null, sourceProductName: source?.product_name || '', sourcePn: source?.pn_code || '', sourceSn: source?.sn_code || '',
      companyPrice: money(price.standard_price), recoveryUnitCost: null,
      existingSnId: existingSn?.sn_id || null, previousSnStatus: existingSn?.status || null });
  }
  return result;
}
async function context(ctx) {
  const { orderId } = ctx.query;
  if (!orderId) { ctx.body = { code: 0, data: { sourceType: 'GIFT' } }; return; }
  const { order } = await sourceOrder(orderId, ctx.state.user);
  const items = await M.OrderItem.findAll({ where: { order_id: orderId } });
  ctx.body = { code: 0, data: { orderId, orderNo: order.order_no, storeId: order.store_id,
    items: items.map(row => ({ orderItemId: row.item_id, productName: row.product_name, snCode: row.sn_code, quantity: row.quantity,
      label: `${row.product_name} · SN ${row.sn_code || '-'} · 数量 ${row.quantity}` })) } };
}
async function create(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  if (!user.staffId) fail(401, '当前员工身份无效');
  if (!['GIFT', RECOVERY].includes(body.sourceType)) fail(400, '入库来源无效');
  if (!/^[\w-]{16,64}$/.test(String(body.requestKey || ''))) fail(400, '缺少有效的防重复提交编号');
  if (!String(body.reason || '').trim()) fail(400, '请填写赠送方及依据或拆机回收原因');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) fail(400, '请填写1至30条入库明细');
  let receipt;
  await M.sequelize.transaction(async transaction => {
    let store, order, sourceItems;
    if (body.sourceType === RECOVERY) {
      ({ store, order } = await sourceOrder(body.orderId, user, transaction));
      sourceItems = await M.OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
    } else {
      store = await M.Store.findByPk(body.storeId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!store || Number(store.status) !== 1) fail(400, '入库门店不存在或已停用');
      visible(user, store.store_id, store.distributor_id);
    }
    const existing = await M.NonPurchaseReceipt.findOne({ where: { request_key: body.requestKey }, transaction });
    if (existing) {
      if (String(existing.applicant_staff_id) !== String(user.staffId) || existing.source_type !== body.sourceType || String(existing.order_id || '') !== String(order?.order_id || '')) fail(409, '提交编号已被使用');
      const signature = items => JSON.stringify((items || []).map(item => [String(item.productId), String(item.orderItemId || ''), Number(item.quantity), String(item.snCode || '').trim().toUpperCase()]));
      if (String(existing.store_id) !== String(store.store_id) || existing.reason !== String(body.reason).trim().slice(0,1000) || signature(parse(existing).items) !== signature(body.items)) fail(409, '该编号已提交过不同内容，请刷新记录后重新申请');
      receipt = existing; return;
    }
    const items = await validateItems(body.items, sourceItems, transaction, store.store_id);
    if (order) {
      const previous = await M.NonPurchaseReceipt.findAll({ where: { order_id: order.order_id, status: { [Op.notIn]: ['rejected', 'cancelled'] } }, transaction });
      for (const previousRow of previous) {
        if (parse(previousRow).items.some(old => items.some(item => String(item.orderItemId) === String(old.orderItemId) && item.productId === old.productId))) fail(409, '该订单商品已申请过此类配件回收，请查看原申请，不能重复入库');
      }
    }
    const receiptId = generateUUID();
    receipt = await M.NonPurchaseReceipt.create({ receipt_id: receiptId, receipt_no: `${order ? 'REC' : 'GIFT'}${receiptId.slice(0, 24)}`,
      request_key: body.requestKey, source_type: body.sourceType, order_id: order?.order_id || null, order_no: order?.order_no || null,
      store_id: store.store_id, distributor_id: store.distributor_id, applicant_staff_id: user.staffId, applicant_name: user.name,
      reason: String(body.reason).trim().slice(0, 1000), payload_json: JSON.stringify({ items }), status: 'pending' }, { transaction });
  });
  ctx.body = { code: 0, message: '已提交审批，审批通过后请验收入库', data: receipt.toJSON() };
}
async function review(ctx) {
  const body = ctx.request.body || {};
  await M.sequelize.transaction(async transaction => {
    const row = await M.NonPurchaseReceipt.findByPk(ctx.params.receiptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.status !== 'pending') fail(409, '申请不存在或已处理');
    visible(ctx.state.user, row.store_id, row.distributor_id);
    const data = parse(row);
    if (body.action === 'approve') {
      if (row.source_type === RECOVERY) await sourceOrder(row.order_id, ctx.state.user, transaction);
      const costs = body.costs;
      for (let index = 0; index < data.items.length; index++) {
        const item = data.items[index];
        item.recoveryUnitCost = row.source_type === RECOVERY ? amount(costs?.[index], `${item.productName}回收单价`) : 0;
      }
      // 审批时重新核对商品、公司定价及SN；申请人传入的成本始终不采用。
      await validateItems(data.items, row.source_type === RECOVERY ? await M.OrderItem.findAll({ where: { order_id: row.order_id }, transaction }) : null, transaction, row.store_id);
      await row.update({ payload_json: JSON.stringify(data) }, { transaction });
    }
    const type = row.source_type === RECOVERY ? 'sales_component_recovery' : 'gift_receipt';
    if (!(await require('../approval/businessRuntime').advance(ctx, type, row, transaction, body.action, body.comment || ''))) return;
    if (body.action === 'reject') {
      await row.update({ status: 'rejected', reviewer_name: ctx.state.user.name, review_time: new Date() }, { transaction });
      ctx.body = { code: 0, message: '申请已拒绝' }; return;
    }
    const inboundId = generateUUID();
    const total = money(data.items.reduce((sum, item) => sum + item.quantity * item.recoveryUnitCost, 0));
    if (total > 9999999999.99) fail(400, '回收总成本超过允许范围');
    await M.Inbound.create({ inbound_id: inboundId, inbound_no: generateInboundNo(), source_type: row.source_type,
      source_no: row.receipt_no, store_id: row.store_id, total_amount: total,
      total_quantity: data.items.reduce((sum, item) => sum + item.quantity, 0), status: 'pending', create_user: row.applicant_name }, { transaction });
    for (const item of data.items) {
      const saved = await M.InboundItem.create({ inbound_id: inboundId, product_id: item.productId, product_name: item.productName,
        pn_code: item.pnCode, sn_code: item.snCode || null, sn_id: item.existingSnId || null, quantity: item.quantity, unit_price: item.recoveryUnitCost,
        original_pickup_price: item.recoveryUnitCost, gross_profit_use_standard_price: 1, gross_profit_uplift_amount: 0,
        inventory_type: 'normal_qty', remark: `${row.source_type === RECOVERY ? '拆机回收' : '获赠'} ${row.order_no || ''}` }, { transaction });
      item.inboundItemId = saved.item_id;
    }
    await row.update({ status: 'approved', inbound_id: inboundId, payload_json: JSON.stringify(data), total_amount: total,
      reviewer_name: ctx.state.user.name, review_time: new Date() }, { transaction });
    ctx.body = { code: 0, message: '审批通过，请到回收/获赠记录验收入库' };
  });
}
async function list(ctx) {
  const user = ctx.state.user;
  const where = {};
  if (!(user.accessibleStoreIds || []).includes('*')) where.store_id = { [Op.in]: user.accessibleStoreIds || [] };
  const { distributorWhere } = require('../../utils/distributorScope');
  Object.assign(where, distributorWhere(user));
  if (ctx.query.orderId) where.order_id = ctx.query.orderId;
  if (ctx.query.sourceType) where.source_type = ctx.query.sourceType;
  const page = Math.max(1, Number(ctx.query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize) || 20));
  const result = await M.NonPurchaseReceipt.findAndCountAll({ where, order: [['create_time', 'DESC']], offset: (page - 1) * pageSize, limit: pageSize });
  ctx.body = { code: 0, data: { list: result.rows.map(row => ({ ...row.toJSON(), items: parse(row).items,
    statusText: ({ pending: '待审批', approved: '待验收入库', received: '已入库', cancelled: '已取消', rejected: '已拒绝' })[row.status] || row.status })), total: result.count } };
}
async function receive(ctx) {
  await M.sequelize.transaction(async transaction => {
    const row = await M.NonPurchaseReceipt.findByPk(ctx.params.receiptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail(404, '申请不存在');
    visible(ctx.state.user, row.store_id, row.distributor_id);
    if (row.status !== 'approved') fail(409, '只有审批通过且未入库的申请可以验收入库');
    if (row.source_type === RECOVERY) await sourceOrder(row.order_id, ctx.state.user, transaction);
    const locationId = await resolveInventoryWriteLocation(M.Location, { storeId: row.store_id, field: 'normal_qty', locationId: ctx.request.body?.locationId, transaction });
    const inventory = require('./controller');
    ctx.body = await inventory.executeInboundInTransaction({ inboundId: row.inbound_id, user: ctx.state.user, fail,
      items: parse(row).items.map(item => ({ inboundItemId: item.inboundItemId, productId: item.productId, quantity: item.quantity,
        snCode: item.snCode, pnCode: item.pnCode, locationId })) }, transaction);
  });
}
async function validateInboundRequest(inbound, items, user, transaction) {
  if (![RECOVERY, 'GIFT'].includes(inbound.source_type)) return;
  const row = await M.NonPurchaseReceipt.findOne({ where: { inbound_id: inbound.inbound_id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row || row.status !== 'approved') fail(409, '回收/获赠申请尚未审批或已处理');
  visible(user, row.store_id, row.distributor_id);
  if (row.source_type === RECOVERY) await sourceOrder(row.order_id, user, transaction);
  const expected = parse(row).items;
  await validateItems(expected, row.source_type === RECOVERY ? await M.OrderItem.findAll({ where: { order_id: row.order_id }, transaction }) : null, transaction, row.store_id);
  if (items.length !== expected.length) fail(400, '请整单验收回收/获赠明细');
  const seen = new Set();
  for (const item of items) {
    const id = String(item.inboundItemId || item.inbound_item_id || '');
    const original = expected.find(row => String(row.inboundItemId) === id);
    if (!original || seen.has(id) || item.productId !== original.productId || Number(item.quantity) !== original.quantity
      || String(item.snCode || item.sn_code || '') !== original.snCode
      || (item.pnCode && String(item.pnCode) !== original.pnCode)
      || (item.inventoryType && item.inventoryType !== 'normal_qty')
      || (item.original_pickup_price !== undefined && Number(item.original_pickup_price) !== original.recoveryUnitCost)
      || (item.originalPickupPrice !== undefined && Number(item.originalPickupPrice) !== original.recoveryUnitCost)) fail(400, '验收内容必须与已审批的商品、SN、数量及回收成本一致，请从回收/获赠记录验收');
    seen.add(id);
  }
}
// 所有入库入口均调用此钩子，不能绕过回收记录生成孤立库存或毛利。
async function completeInbound(inbound, user, transaction) {
  if (![RECOVERY, 'GIFT'].includes(inbound.source_type)) return;
  const row = await M.NonPurchaseReceipt.findOne({ where: { inbound_id: inbound.inbound_id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row || row.status !== 'approved') fail(409, '入库申请状态无效');
  visible(user, row.store_id, row.distributor_id);
  const pending = await M.InboundItem.findAll({ where: { inbound_id: inbound.inbound_id }, transaction });
  if (pending.some(item => Number(item.received_quantity) !== Number(item.quantity))) fail(409, '回收/获赠必须整单验收，不支持部分入库');
  for (const productId of [...new Set(parse(row).items.filter(item => !item.needSn).map(item => item.productId))]) {
    const price = await M.ProductPrice.findOne({ where: { product_id: productId, status: 1 }, order: [['effective_time', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!price) fail(409, '商品价格记录已失效，请核对公司定价后再验收入库');
    if (Number(price?.cost_price_locked) === 1) continue;
    const cost = await require('../product/controller').calculateFifoCost(productId, { transaction, requireComplete: true });
    if (cost === null) fail(409, '该物料既有库存缺少完整成本层，请先核对成本依据再入库，不能用获赠零成本覆盖');
    await price.update({ cost_price: cost }, { transaction });
  }
  let adjustmentId = null;
  if (row.source_type === RECOVERY) {
    const { order } = await sourceOrder(row.order_id, user, transaction);
    if (Number(row.total_amount) > 0) {
      adjustmentId = generateUUID();
      await M.PerformanceProfitAdjustment.create({ adjustment_id: adjustmentId, adjustment_no: `REC${adjustmentId.slice(0, 24)}`,
        order_id: order.order_id, order_no: order.order_no, store_id: order.store_id, employee_name: order.create_user || '',
        adjustment_type: 'increase', amount: row.total_amount, signed_amount: row.total_amount, base_gross_profit: order.gross_profit || 0,
        reason: `拆机回收验收入库 ${row.receipt_no}，审批人：${row.reviewer_name}`,
        status: 'approved', applicant_staff_id: row.applicant_staff_id, applicant_name: row.applicant_name,
        admin_reviewer_name: row.reviewer_name, admin_review_time: row.review_time }, { transaction });
    }
  }
  await row.update({ status: 'received', adjustment_id: adjustmentId, update_time: new Date() }, { transaction });
  await recordBusinessAction({ businessType: 'non_purchase_receipt', action: 'receive', businessId: row.receipt_id,
    businessNo: row.receipt_no, user, transaction, fromStatus: 'approved', toStatus: 'received',
    detail: { inboundId: inbound.inbound_id, adjustmentId, total: row.total_amount } });
}
async function cancel(ctx) {
  await M.sequelize.transaction(async transaction => {
    const row = await M.NonPurchaseReceipt.findByPk(ctx.params.receiptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail(404, '申请不存在');
    visible(ctx.state.user, row.store_id, row.distributor_id);
    if (!['pending', 'approved'].includes(row.status)) fail(409, '已验收入库的申请不能直接取消，请先处理后续库存及关联毛利');
    const roles = require('../../middleware/permission').getUserRoles(ctx.state.user);
    if (String(row.applicant_staff_id) !== String(ctx.state.user.staffId) && !roles.some(role => ['admin', 'boss'].includes(role))) fail(403, '仅申请人或管理员可以取消');
    if (row.inbound_id) {
      const inbound = await M.Inbound.findByPk(row.inbound_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (inbound.status !== 'pending') fail(409, '入库单已处理');
      await inbound.update({ status: 'cancelled' }, { transaction });
    }
    await row.update({ status: 'cancelled', update_time: new Date() }, { transaction });
  });
  ctx.body = { code: 0, message: '申请已取消' };
}
module.exports = { context, create, review, list, receive, cancel, completeInbound, validateInboundRequest, validateItems, amount, visible, sourceOrder, RECOVERY };
