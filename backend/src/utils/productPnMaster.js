const { Op } = require('sequelize');
const { Product, ProductPn } = require('../models');
const { sequelize } = require('../config/database');
const { generateUUID } = require('./index');
const {
  normalizePnCode,
  splitPnCodes,
  isUsablePnCode,
  assertSingleSnProductPn
} = require('./productPn');

function pnCodeWhere(code) {
  return sequelize.where(
    sequelize.fn('LOWER', sequelize.fn('REPLACE', sequelize.fn('TRIM', sequelize.col('pn_code')), ' ', '')),
    normalizePnCode(code)
  );
}

async function listActiveProductPns(productId, transaction = null) {
  return ProductPn.findAll({
    where: { product_id: productId, status: 1, is_deleted: 0 },
    order: [['is_primary', 'DESC'], ['pn_code', 'ASC']],
    transaction
  });
}

async function resolveProductPn({ productId, requestedCode = '', requireSingleForSn = true, transaction = null }) {
  const product = await Product.findByPk(productId, {
    attributes: ['product_id', 'product_code', 'need_sn', 'manufacturer_code'],
    transaction
  });
  if (!product) throw Object.assign(new Error('商品不存在'), { status: 404 });

  const requested = String(requestedCode || '').trim();
  const pns = await listActiveProductPns(productId, transaction);
  const configured = pns.map(row => row.pn_code);
  if (Number(product.need_sn) === 1 && requireSingleForSn) {
    assertSingleSnProductPn({
      needSn: product.need_sn,
      productCode: product.product_code,
      configuredCodes: [configured, product.manufacturer_code],
      requestedCode: requested
    });
  }

  const candidates = splitPnCodes(requested || (Number(product.need_sn) === 1 ? configured[0] : splitPnCodes(product.manufacturer_code)[0]));
  const code = candidates[0] || '';
  if (!isUsablePnCode(code)) throw Object.assign(new Error('PN码不能为空'), { status: 400 });

  const record = pns.find(row => normalizePnCode(row.pn_code) === normalizePnCode(code)) || await ProductPn.findOne({
    where: { [Op.and]: [{ product_id: productId }, pnCodeWhere(code), { status: 1, is_deleted: 0 }] },
    transaction
  });
  if (!record) throw Object.assign(new Error(`PN码 [${code}] 未登记到商品 ${product.product_code}`), { status: 400 });
  return { product, pn: record, pnCode: record.pn_code };
}

async function ensureProductPnMaster({ productId, pnCode, transaction = null, isPrimary = false }) {
  const code = String(pnCode || '').trim();
  if (!isUsablePnCode(code)) throw Object.assign(new Error('PN码不能为空'), { status: 400 });
  const existing = await ProductPn.findAll({ where: { [Op.and]: [pnCodeWhere(code)] }, transaction });
  const conflict = existing.find(row => String(row.product_id) !== String(productId));
  if (conflict) throw Object.assign(new Error(`PN码 [${code}] 已关联其他商品，不能重复绑定`), { status: 409 });
  let record = existing.find(row => String(row.product_id) === String(productId));
  if (record) {
    await record.update({ pn_code: code, status: 1, is_deleted: 0, ...(isPrimary ? { is_primary: 1 } : {}) }, { transaction });
    return record;
  }
  return ProductPn.create({
    pn_id: generateUUID(), product_id: productId, pn_code: code, barcode: code,
    is_primary: isPrimary ? 1 : 0, status: 1, is_deleted: 0
  }, { transaction });
}

async function ensureProductPnsMaster({ productId, codes, transaction = null }) {
  const productKey = String(productId || '');
  if (!productKey) return [];

  const normalizedCodes = splitPnCodes(codes);
  const product = await Product.findByPk(productId, {
    attributes: ['product_id', 'product_code', 'need_sn'],
    transaction
  });
  if (!product) return [];

  const existingForProduct = await ProductPn.findAll({ where: { product_id: productId }, transaction });
  assertSingleSnProductPn({
    needSn: product.need_sn,
    productCode: product.product_code,
    configuredCodes: [
      ...existingForProduct
        .filter(row => Number(row.is_deleted || 0) === 0 && Number(row.status || 0) === 1)
        .map(row => row.pn_code),
      ...normalizedCodes
    ]
  });
  if (normalizedCodes.length === 0) return [];

  const existingByKey = new Map(existingForProduct.map(row => [normalizePnCode(row.pn_code), row]));
  const ensured = [];
  for (const code of normalizedCodes) {
    const codeKey = normalizePnCode(code);
    const existing = existingByKey.get(codeKey);
    if (existing) {
      if (Number(existing.is_deleted || 0) === 1 || Number(existing.status || 0) !== 1) {
        await existing.update({ pn_code: code, status: 1, is_deleted: 0 }, { transaction });
      }
      ensured.push(existing);
      continue;
    }

    const sameCodeRows = await ProductPn.findAll({
      where: { [Op.and]: [pnCodeWhere(code)] },
      transaction
    });
    const conflict = sameCodeRows.find(row => String(row.product_id) !== productKey);
    if (conflict) {
      throw Object.assign(new Error(`PN鐮?[${code}] 宸插叧鑱斿叾浠栧晢鍝侊紝涓嶈兘閲嶅缁戝畾`), { status: 409 });
    }

    const created = await ProductPn.create({
      pn_id: generateUUID(),
      product_id: productId,
      pn_code: code,
      barcode: code,
      is_primary: existingForProduct.length === 0 && ensured.length === 0 ? 1 : 0,
      status: 1,
      is_deleted: 0
    }, { transaction });
    existingByKey.set(codeKey, created);
    ensured.push(created);
  }
  return ensured;
}

async function ensureSnPnId(sn, transaction = null) {
  if (!sn || !sn.pn_code) return sn;
  const resolved = await resolveProductPn({ productId: sn.product_id, requestedCode: sn.pn_code, requireSingleForSn: false, transaction });
  if (String(sn.pn_id || '') !== String(resolved.pn.pn_id || '')) {
    await sn.update({ pn_id: resolved.pn.pn_id, pn_code: resolved.pn_code }, { transaction });
  }
  return sn;
}

module.exports = {
  listActiveProductPns,
  resolveProductPn,
  ensureProductPnMaster,
  ensureProductPnsMaster,
  ensureSnPnId
};
