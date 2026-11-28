const { costAmount } = require('../../utils/costKnowledge');

function combineUnitCost(layers) {
  let total = 0;
  let quantity = 0;
  for (const layer of layers) {
    if (layer.unitCost === null) return null;
    total += layer.unitCost * layer.quantity;
    quantity += layer.quantity;
  }
  return quantity ? Math.round(total / quantity * 100) / 100 : null;
}

function remainingLayers(basis, quantity) {
  if (!quantity) return [];
  const stored = basis?.source?.costLayers;
  if (Array.isArray(stored) && stored.every(layer => layer.quantity > 0 &&
    (layer.unitCost === null || costAmount(layer.unitCost) === layer.unitCost)) &&
    stored.reduce((sum, layer) => sum + layer.quantity, 0) === quantity) return stored;
  return [{ quantity, unitCost: basis?.status === 'conflict' ? null : costAmount(basis?.purchaseCost),
    invoiceType: basis?.status === 'confirmed' && !basis.source?.taxScope ? basis.invoiceType : null,
    estimated: Boolean(basis?.costEstimated) }];
}

function changeLayers(basis, previousQuantity, quantity, receipt) {
  const layers = remainingLayers(basis, previousQuantity).map(layer => ({ ...layer }));
  const increase = quantity - previousQuantity;
  if (increase > 0) {
    if (Array.isArray(receipt?.costLayers) && receipt.costLayers.reduce((sum, layer) => sum + layer.quantity, 0) === increase) {
      return layers.concat(receipt.costLayers.map(layer => ({ ...layer })));
    }
    const raw = costAmount(receipt?.unitCost);
    const unitCost = raw > 0 || (raw === 0 && receipt?.zeroCostConfirmed === true) ? raw : null;
    const last = layers[layers.length - 1];
    const invoiceType = receipt?.invoiceType || null;
    const estimated = Boolean(receipt?.costEstimated);
    if (last && last.unitCost === unitCost && last.invoiceType === invoiceType && last.estimated === estimated) last.quantity += increase;
    else layers.push({ quantity: increase, unitCost, invoiceType, estimated });
  } else {
    let outgoing = -increase;
    while (outgoing > 0 && layers.length) {
      const take = Math.min(layers[0].quantity, outgoing);
      layers[0].quantity -= take;
      outgoing -= take;
      if (!layers[0].quantity) layers.shift();
    }
  }
  return layers;
}

function takeLayers(layers, quantity) {
  const result = [];
  for (const layer of layers) {
    if (!quantity) break;
    const take = Math.min(quantity, layer.quantity);
    if (take > 0) result.push({ ...layer, quantity: take });
    quantity -= take;
  }
  return result;
}

module.exports = { combineUnitCost, remainingLayers, changeLayers, takeLayers };
