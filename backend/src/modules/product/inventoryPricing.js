const crypto = require('crypto');
const { Op } = require('sequelize');
const { ProductSn, Product, ProductPrice, Store, Order, OrderItem, Role, RoleMenu, Menu, sequelize } = require('../../models');
const { getUserRoles } = require('../../middleware/permission');
const { distributorWhere } = require('../../utils/distributorScope');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const { validPrice, resolveInventoryCostMode } = require('../sales/grossProfit');

const ACTIVE_ORDERS = ['draft', '未归档', 'pending_approval', 'pending_store_approval', 'pending_distributor_approval'];
async function assertPermission(ctx) {
  const roles = getUserRoles(ctx.state.user);
  if (roles.includes('boss')) return;
  const roleRows = await Role.findAll({ where: { role_code: { [Op.in]: roles }, status: 1 }, raw: true });
  const links = await RoleMenu.findAll({ where: { role_id: { [Op.in]: roleRows.map(r => r.role_id) } }, raw: true });
  const menu = await Menu.findOne({ where: { menu_id: { [Op.in]: links.map(r => r.menu_id) }, path: '/products/price', status: 1 } });
  if (!menu) ctx.throw(403, '需要价格管理权限才能调整库存计价方式');
}
async function storesForUser(ctx, transaction) {
  return Store.findAll({ where: { ...distributorWhere(ctx.state.user), status: 1, is_deleted: 0 }, attributes: ['store_id', 'name'], raw: true, transaction });
}
function originalMode(sn, product, price) {
  return resolveInventoryCostMode(product, sn, price);
}
function stockAge(sn) {
  if (!sn.original_inbound_time && !sn.inbound_time) return null;
  const time = new Date(sn.original_inbound_time || sn.inbound_time).getTime();
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 86400000)) : null;
}
async function describe(rows, transaction) {
  const ids = [...new Set(rows.map(r => r.product_id))];
  const [products, prices, orders] = await Promise.all([
    Product.findAll({ where: { product_id: { [Op.in]: ids }, is_deleted: 0 }, order: [['product_id', 'ASC']], raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) }),
    ProductPrice.findAll({ where: { product_id: { [Op.in]: ids }, status: 1 }, order: [['product_id', 'ASC']], raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) }),
    rows.length ? OrderItem.findAll({
      where: { [Op.or]: [{ sn_id: { [Op.in]: rows.map(r => r.sn_id) } }, { sn_code: { [Op.in]: rows.map(r => r.sn_code) } }] },
      include: [{ model: Order, required: true, where: { is_deleted: 0, order_status: { [Op.in]: ACTIVE_ORDERS } } }],
      transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {})
    }) : []
  ]);
  const pm = new Map(products.map(r => [r.product_id, r]));
  const pp = new Map(prices.map(r => [r.product_id, r]));
  return rows.map(sn => {
    const product = pm.get(sn.product_id) || {};
    const price = pp.get(sn.product_id);
    const occupied = orders.some(item => item.product_id === sn.product_id &&
      (item.sn_id === sn.sn_id || item.sn_code === sn.sn_code));
    return {
      snId: sn.sn_id, snCode: sn.sn_code, productId: sn.product_id, productName: product.name || '', category: product.category || '',
      pnCode: sn.pn_code, storeId: sn.store_id, batchNo: sn.batch_no || '',
      inboundTime: sn.original_inbound_time || sn.inbound_time, ageDays: stockAge(sn),
      purchasePrice: validPrice(sn.inbound_price), standardPrice: price ? validPrice(price.standard_price) : null,
      mode: originalMode(sn, product, price), status: sn.status, occupied,
      blocked: !product.product_id ? '商品已停用或不存在' : sn.status !== 'in_stock' ? '库存已非可售在库' : occupied ? '已关联未归档销售单' : '',
      version: [sn.update_time, sn.gross_profit_use_standard_price, product.gross_profit_cost_mode, price?.price_id, price?.effective_time].map(v => v ?? null)
    };
  });
}
async function list(ctx) {
  await assertPermission(ctx);
  const stores = await storesForUser(ctx);
  const q = ctx.query;
  const page = Math.max(1, Number(q.page) || 1), pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  const storeIds = stores.map(s => s.store_id);
  const where = { is_deleted: 0, status: 'in_stock', store_id: { [Op.in]: storeIds } };
  if (q.storeId) where.store_id = storeIds.includes(q.storeId) ? q.storeId : '__NO_STORE__';
  const productWhere = { is_deleted: 0 };
  if (q.category) productWhere.category = q.category;
  if (q.keyword) {
    const keyword = `%${String(q.keyword).slice(0, 100)}%`;
    const matches = await Product.findAll({ where: { ...productWhere, [Op.or]: [{ name: { [Op.like]: keyword } }, { manufacturer_code: { [Op.like]: keyword } }, { product_code: { [Op.like]: keyword } }] }, attributes: ['product_id'], raw: true });
    where[Op.or] = [{ product_id: { [Op.in]: matches.map(r => r.product_id) } }, { sn_code: { [Op.like]: keyword } }, { batch_no: { [Op.like]: keyword } }, { pn_code: { [Op.like]: keyword } }];
  }
  // Mode and age are derived from each inventory record, so filter before paging.
  const rows = await ProductSn.findAll({ where, include: [{ model: Product, where: productWhere, attributes: [], required: true }], order: [['original_inbound_time', 'ASC'], ['sn_id', 'ASC']], raw: true });
  let described = await describe(rows);
  if (q.mode) described = described.filter(r => r.mode === q.mode);
  if (Number(q.minDays) > 0) described = described.filter(r => r.ageDays !== null && r.ageDays >= Number(q.minDays));
  const categories = await Product.findAll({ attributes: ['category'], group: ['category'], where: { is_deleted: 0 }, raw: true });
  ctx.body = { code: 0, data: { list: described.slice((page - 1) * pageSize, page * pageSize).map(({ version, ...r }) => r), total: described.length, stores, categories: categories.map(r => r.category).filter(Boolean) } };
}
function fingerprint(mode, rows) {
  return crypto.createHash('sha256').update(JSON.stringify({ mode, rows: [...rows].sort((a,b) => a.snId.localeCompare(b.snId)) })).digest('hex');
}
async function selection(ctx, transaction) {
  const body = ctx.request.body || {};
  if (!['COMPANY_PRICE', 'PURCHASE_PRICE'].includes(body.mode)) ctx.throw(400, '请选择目标计价方式');
  const ids = [...new Set(Array.isArray(body.snIds) ? body.snIds.map(String) : [])];
  if (!ids.length || ids.length > 200) ctx.throw(400, '每次请选择1至200条库存');
  const stores = await storesForUser(ctx, transaction);
  const rows = await ProductSn.findAll({ where: { sn_id: { [Op.in]: ids }, store_id: { [Op.in]: stores.map(s => s.store_id) }, is_deleted: 0 }, order: [['sn_id', 'ASC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (rows.length !== ids.length) ctx.throw(403, '部分库存不存在或超出经销商权限范围');
  const details = await describe(rows.map(r => r.toJSON()), transaction);
  const result = details.map(r => ({ ...r, targetMode: body.mode,
    blocked: r.blocked || (body.mode === 'COMPANY_PRICE' && r.standardPrice === null ? '缺少有效公司定价' : body.mode === 'PURCHASE_PRICE' && r.purchasePrice === null ? '缺少实际采购价' : ''),
    warning: body.mode === 'COMPANY_PRICE' && r.standardPrice !== null && r.purchasePrice !== null && r.standardPrice < r.purchasePrice ? '公司定价低于实际采购价' : ''
  }));
  return { rows, details: result, previewHash: fingerprint(body.mode, result) };
}
async function preview(ctx) {
  await assertPermission(ctx);
  const result = await selection(ctx);
  ctx.body = { code: 0, data: { list: result.details.map(({ version, ...r }) => r), previewHash: result.previewHash } };
}
async function apply(ctx) {
  await assertPermission(ctx);
  const body = ctx.request.body || {};
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 512) ctx.throw(400, '请填写512字以内的调整原因');
  let changed = 0;
  await sequelize.transaction(async transaction => {
    const result = await selection(ctx, transaction);
    if (result.details.some(r => r.blocked)) ctx.throw(409, '部分库存不可调整，请重新预览');
    if (result.previewHash !== body.previewHash) ctx.throw(409, '库存状态、价格或计价方式已变化，请重新预览');
    if (result.details.some(r => r.warning) && body.confirmBelowCost !== true) ctx.throw(400, '公司定价低于采购价，请确认风险并填写原因');
    for (const row of result.rows) {
      const before = result.details.find(r => r.snId === row.sn_id);
      const flag = body.mode === 'COMPANY_PRICE' ? 1 : 0;
      if (String(row.gross_profit_use_standard_price) === String(flag)) continue;
      await row.update({ gross_profit_use_standard_price: flag, update_time: new Date() }, { transaction });
      await recordBusinessAction({ businessType: 'inventory_pricing', businessId: row.sn_id, businessNo: row.sn_code, action: 'change_cost_mode', fromStatus: before.mode, toStatus: body.mode, user: ctx.state.user, comment: reason,
        detail: { productId: row.product_id, storeId: row.store_id, batchNo: row.batch_no, beforeFlag: before.version[1], afterFlag: flag, purchasePrice: before.purchasePrice, standardPrice: before.standardPrice, warning: before.warning }, transaction });
      changed++;
    }
  });
  ctx.body = { code: 0, data: { changed }, message: `已调整${changed}条库存计价方式` };
}
async function history(ctx) {
  await assertPermission(ctx);
  const stores = await storesForUser(ctx);
  const stock = await ProductSn.findOne({ where: { sn_id: ctx.params.snId, is_deleted: 0, store_id: { [Op.in]: stores.map(s => s.store_id) } } });
  if (!stock) ctx.throw(404, '库存不存在或超出权限范围');
  ctx.body = { code: 0, data: await listBusinessActions('inventory_pricing', stock.sn_id) };
}
module.exports = { list, preview, apply, history, originalMode, fingerprint };
