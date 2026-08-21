const { ProductSn, ProductPrice } = require('../../models');
const { Op } = require('sequelize');

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function hasArchivedGrossProfitSnapshot(item) {
  return [
    item.original_inventory_cost,
    item.sales_settlement_cost,
    item.sales_gross_profit,
    item.cost_adjustment_amount,
    item.original_pickup_price
  ].some(value => toNumber(value) !== 0);
}

async function loadLegacyCostMaps(items = []) {
  const legacyItems = items.filter(item => !hasArchivedGrossProfitSnapshot(item));
  const productIds = [...new Set(legacyItems.map(item => item.product_id).filter(Boolean))];
  const snIds = [...new Set(legacyItems.map(item => item.sn_id).filter(Boolean))];
  const snCodes = [...new Set(legacyItems.map(item => item.sn_code).filter(Boolean))];

  const snWhere = { is_deleted: 0 };
  if (snIds.length && snCodes.length) {
    snWhere[Op.or] = [{ sn_id: { [Op.in]: snIds } }, { sn_code: { [Op.in]: snCodes } }];
  } else if (snIds.length) {
    snWhere.sn_id = { [Op.in]: snIds };
  } else if (snCodes.length) {
    snWhere.sn_code = { [Op.in]: snCodes };
  }

  const [snRows, priceRows] = await Promise.all([
    snIds.length || snCodes.length ? ProductSn.findAll({ where: snWhere, raw: true }) : [],
    productIds.length ? ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } }, raw: true }) : []
  ]);

  return {
    snById: new Map(snRows.map(sn => [String(sn.sn_id), sn])),
    snByCode: new Map(snRows.map(sn => [String(sn.sn_code), sn])),
    priceByProduct: new Map(priceRows.map(price => [String(price.product_id), price]))
  };
}

function calculateItemBaseProfit(item, maps = {}) {
  const quantity = Number(item.quantity || 1);
  const saleSubtotal = roundMoney(item.subtotal || (toNumber(item.sale_price) * quantity));
  if (hasArchivedGrossProfitSnapshot(item)) {
    const unitCost = roundMoney(item.sales_settlement_cost);
    return {
      source: 'archived',
      unitCost,
      costAmount: roundMoney(unitCost * quantity),
      grossProfit: roundMoney(item.sales_gross_profit)
    };
  }

  const sn = (item.sn_id ? maps.snById?.get(String(item.sn_id)) : null)
    || maps.snByCode?.get(String(item.sn_code || ''));
  const price = maps.priceByProduct?.get(String(item.product_id || ''));
  const unitCost = roundMoney(sn?.inbound_price || price?.cost_price || 0);
  const costAmount = roundMoney(unitCost * quantity);
  return {
    source: 'legacy_fallback',
    unitCost,
    costAmount,
    grossProfit: roundMoney(saleSubtotal - costAmount)
  };
}

module.exports = {
  hasArchivedGrossProfitSnapshot,
  loadLegacyCostMaps,
  calculateItemBaseProfit
};
