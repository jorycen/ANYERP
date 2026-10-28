// One transaction owns the receipt, stock issue, frozen cost and redemption.
const { Op, QueryTypes } = require('sequelize');
const crypto = require('crypto');
const DB = require('../../models');
const M = require('./models');
const S = require('./security');
const { cents } = require('./math');
const id = () => crypto.randomBytes(16).toString('hex');
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const physical = item => ['gift', 'product'].includes(item.kind);
const qty = row => Math.max(Number(row.normal_qty || 0), Number(row.regular_qty || 0) + Number(row.subsidy_qty || 0) + Number(row.second_qty || 0));
async function availability(item, storeId, transaction, locked = false) {
  if (!physical(item)) return null;
  if (!item.product_id) return 0;
  const product = await DB.Product.findOne({ where: { product_id: item.product_id, is_deleted: 0 }, transaction });
  if (!product) return 0;
  const rows = await DB.Inventory.findAll({ where: { product_id: item.product_id, store_id: storeId }, order: [['inventory_id', 'ASC']], transaction,
    ...(locked ? { lock: transaction.LOCK.UPDATE } : {}) });
  const held = await M.Reservation.findAll({ where: { inventory_id: rows.map(r => r.inventory_id), status: 'reserved', expires_at: { [Op.gt]: new Date() } }, transaction });
  let available = 0;
  for (const row of rows) {
    let total = qty(row);
    if (product.need_sn) total = Math.min(total, await DB.ProductSn.count({ where: { product_id: item.product_id, store_id: storeId,
      location_id: row.location_id, inventory_type: 'normal_qty', status: 'in_stock', is_deleted: 0 }, transaction }));
    available += Math.max(0, total - held.filter(h => h.inventory_id === row.inventory_id).reduce((s, h) => s + h.quantity, 0));
  }
  return Math.floor(available / item.units_per_reward);
}
// Public catalogue reads all store balances together; never one query per gift/store pair.
async function catalogueStock(items, storeIds) {
  const physicalItems = items.filter(physical);
  const ids = [...new Set(physicalItems.map(i => i.product_id).filter(Boolean))];
  const result = new Map(physicalItems.map(i => [i.id, new Map(storeIds.map(id => [id, 0]))]));
  if (!ids.length || !storeIds.length) return result;
  const [products, inventory] = await Promise.all([
    DB.Product.findAll({ where: { product_id: ids, is_deleted: 0 }, attributes: ['product_id', 'need_sn'] }),
    DB.Inventory.findAll({ where: { product_id: ids, store_id: storeIds } })
  ]);
  const serialIds = products.filter(p => p.need_sn).map(p => p.product_id);
  const [holds, serials] = await Promise.all([
    M.Reservation.findAll({ where: { inventory_id: inventory.map(i => i.inventory_id), status: 'reserved', expires_at: { [Op.gt]: new Date() } } }),
    serialIds.length ? DB.ProductSn.findAll({ where: { product_id: serialIds, store_id: storeIds, status: 'in_stock', inventory_type: 'normal_qty', is_deleted: 0 }, attributes: ['product_id','store_id','location_id'] }) : []
  ]);
  const balances = new Map();
  for (const row of inventory) {
    const product = products.find(p => p.product_id === row.product_id);
    if (!product) continue;
    let total = qty(row);
    if (product.need_sn) total = Math.min(total, serials.filter(s => s.product_id === row.product_id && s.store_id === row.store_id && s.location_id === row.location_id).length);
    const held = holds.filter(h => h.inventory_id === row.inventory_id).reduce((n, h) => n + h.quantity, 0);
    const key = `${row.product_id}:${row.store_id}`;
    balances.set(key, (balances.get(key) || 0) + Math.max(0, total - held));
  }
  for (const item of physicalItems) for (const storeId of storeIds) result.get(item.id).set(storeId, Math.floor((balances.get(`${item.product_id}:${storeId}`) || 0) / item.units_per_reward));
  return result;
}
async function reserve(item, exchange, storeId, transaction) {
  if (!physical(item)) return;
  if (!item.product_id) S.fail(409, '礼品尚未关联ERP商品，请联系门店');
  if (await availability(item, storeId, transaction, true) < 1) S.fail(409, '领取门店可用库存不足');
  const rows = await DB.Inventory.findAll({ where: { product_id: item.product_id, store_id: storeId }, order: [['inventory_id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  let remaining = item.units_per_reward;
  const product = await DB.Product.findByPk(item.product_id, { transaction });
  for (const row of rows) {
    const held = Number(await M.Reservation.sum('quantity', { where: { inventory_id: row.inventory_id, status: 'reserved', expires_at: { [Op.gt]: new Date() } }, transaction }) || 0);
    let total = qty(row);
    if (product.need_sn) total = Math.min(total, await DB.ProductSn.count({ where: { product_id: item.product_id, store_id: storeId, location_id: row.location_id,
      inventory_type: 'normal_qty', status: 'in_stock', is_deleted: 0 }, transaction }));
    const take = Math.min(remaining, Math.max(0, total - held));
    if (take) await M.Reservation.create({ exchange_id: exchange.id, inventory_id: row.inventory_id, product_id: item.product_id, store_id: storeId,
      quantity: take, expires_at: exchange.expires_at }, { transaction });
    remaining -= take;
    if (!remaining) break;
  }
  if (remaining) S.fail(409, '领取门店可用库存不足');
}
async function paymentMethods(storeId, transaction) {
  const links = await DB.PaymentMethodStore.findAll({ where: { store_id: storeId }, transaction });
  const methods = await DB.PaymentMethod.findAll({ where: { status: 1, [Op.or]: [{ is_global: 1 }, { method_id: links.map(l => l.method_id) }] }, transaction });
  for (const method of methods) {
    const link = links.find(l => l.method_id === method.method_id);
    if (link?.settlement_account_id) method.settlement_account_id = link.settlement_account_id;
  }
  const store = await DB.Store.findByPk(storeId, { transaction });
  const accounts = await DB.SettlementAccount.findAll({ where: { account_id: methods.map(m => m.settlement_account_id).filter(Boolean), status: 1, account_type: 'FUND',
    [Op.or]: [{ distributor_id: null }, { distributor_id: '' }, { distributor_id: store.distributor_id }] }, transaction });
  return methods.filter(m => accounts.some(a => a.account_id === m.settlement_account_id)).map(m => ({ method_id: m.method_id, name: m.name, account_id: m.settlement_account_id,
    account_name: accounts.find(a => a.account_id === m.settlement_account_id).account_name }));
}
async function fulfill(row, store, user, evidence, transaction) {
  const cash = cents(row.snapshot.cash_required || '0');
  const fields = {};
  if (cash) {
    const method = (await paymentMethods(store.store_id, transaction)).find(m => m.method_id === evidence.payment_method_id);
    if (!method) S.fail(400, '请选择本门店已绑定有效资金账户的收款方式');
    const fund = await DB.SettlementAccount.findByPk(method.account_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!fund || fund.status !== 1 || fund.account_type !== 'FUND' || (fund.distributor_id && fund.distributor_id !== store.distributor_id)) S.fail(409, '收款资金账户配置已变化，请重新查询');
    const [income, expense] = await Promise.all(['income', 'expense'].map(type => DB.SettlementAccountTransaction.sum('amount', { where: { account_id: method.account_id, type }, transaction })));
    const transactionId = id();
    await DB.SettlementAccountTransaction.create({ transaction_id: transactionId, account_id: method.account_id, type: 'income', amount: money(cash),
      balance_after: ((Number(income || 0) - Number(expense || 0)) + Number(money(cash))).toFixed(2),
      related_ref: `REWARD:${row.id}`, description: `积分兑换补差：${row.snapshot.name}`, create_user: String(user.staffId) }, { transaction });
    Object.assign(fields, { payment_method_id: method.method_id, account_id: method.account_id, fund_transaction_id: transactionId });
  }
  let cost = 0n;
  if (physical(row.snapshot)) {
    if (!row.snapshot.product_id || !row.snapshot.pickup_store_id) S.fail(409, '历史礼品凭证未关联商品及领取门店，请由管理员核对处理');
    const reservations = await M.Reservation.findAll({ where: { exchange_id: row.id, status: 'reserved', expires_at: { [Op.gt]: new Date() } }, order: [['inventory_id', 'ASC']], transaction });
    if (reservations.reduce((s, r) => s + r.quantity, 0) !== row.snapshot.units_per_reward) S.fail(409, '库存预占不存在或已过期');
    const product = await DB.Product.findByPk(row.snapshot.product_id, { transaction });
    if (!product || product.is_deleted) S.fail(409, '关联礼品商品已失效，请联系管理员核对');
    const outboundId = id();
    await DB.Outbound.create({ outbound_id: outboundId, outbound_no: `REWARD-${row.id}`, store_id: store.store_id, out_type: 'reward_redemption', source_order_no: row.id,
      total_quantity: row.snapshot.units_per_reward, status: 'completed', create_user: String(user.staffId) }, { transaction });
    let unitCost;
    if (!product.need_sn) {
      const { fifoRemainingAverageCost, remainingCostLayersSql } = require('../../utils/inventoryCostLayers');
      const layers = await DB.sequelize.query(remainingCostLayersSql, { replacements: [product.product_id, product.product_id], type: QueryTypes.SELECT, transaction });
      const stock = await DB.Inventory.findAll({ where: { product_id: product.product_id }, transaction });
      const total = stock.reduce((sum, r) => sum + ['normal_qty','display_qty','demo_qty','unsellable_qty','pending_qty','rental_demo_qty'].reduce((s, k) => s + (k === 'normal_qty' ? qty(r) : Number(r[k] || 0)), 0), 0);
      unitCost = fifoRemainingAverageCost(layers, total, { requireComplete: true });
      if (unitCost === null || !total) S.fail(409, '礼品采购成本依据不完整，请先核实成本');
    }
    for (const reservation of reservations) {
      const inventory = await DB.Inventory.findByPk(reservation.inventory_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!inventory || qty(inventory) < reservation.quantity) S.fail(409, '预占库存不足');
      if (product.need_sn) {
        const codes = Array.isArray(evidence.sn_codes) ? evidence.sn_codes : [];
        const serials = await DB.ProductSn.findAll({ where: { product_id: product.product_id, store_id: store.store_id, location_id: inventory.location_id,
          inventory_type: 'normal_qty', status: 'in_stock', is_deleted: 0, sn_code: codes }, transaction, lock: transaction.LOCK.UPDATE });
        if (serials.length !== reservation.quantity) S.fail(400, '请填写交付礼品全部SN，须为预占库位有效销售仓库存');
        for (const sn of serials) {
          if (sn.inbound_price === null || Number(sn.inbound_price) <= 0) S.fail(409, '礼品SN采购成本待核实');
          cost += cents(sn.inbound_price);
          await sn.update({ status: 'sold', update_time: new Date() }, { transaction });
          await DB.OutboundItem.create({ outbound_id: outboundId, product_id: product.product_id, sn_id: sn.sn_id, sn_code: sn.sn_code, quantity: 1 }, { transaction });
        }
      } else {
        cost += cents(unitCost.toFixed(2)) * BigInt(reservation.quantity);
        await DB.OutboundItem.create({ outbound_id: outboundId, product_id: product.product_id, quantity: reservation.quantity }, { transaction });
      }
      // Consume our hold before the protected inventory update, in the same transaction.
      await reservation.update({ status: 'consumed' }, { transaction });
      let remaining = reservation.quantity;
      const changes = { normal_qty: qty(inventory) - remaining };
      for (const column of ['regular_qty', 'subsidy_qty', 'second_qty']) {
        const take = Math.min(Number(inventory[column] || 0), remaining);
        changes[column] = Number(inventory[column] || 0) - take; remaining -= take;
      }
      await inventory.update(changes, { transaction });
    }
    fields.outbound_id = outboundId;
  }
  const sales = cash / 2n; // Whole cents: odd cent stays with operations; total always reconciles.
  return { ...fields, cost_amount: money(cost), sales_profit: money(sales), operations_profit: money(cash - sales - cost) };
}
module.exports = { physical, qty, availability, catalogueStock, reserve, paymentMethods, fulfill, money };
