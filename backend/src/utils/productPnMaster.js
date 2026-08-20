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

function createPnConflictError(code) {
  const error = new Error(`PN码 [${code}] 已关联其他商品，不能重复绑定`);
  error.status = 409;
  error.code = 'PN_ALREADY_BOUND';
  error.pnCode = code;
  return error;
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
  const product = await Product.findByPk(productId, {
    attributes: ['product_id', 'product_code', 'need_sn'],
    transaction
  });
  if (!product) throw Object.assign(new Error('商品不存在'), { status: 404 });
  const existing = await ProductPn.findAll({ where: { [Op.and]: [pnCodeWhere(code)] }, transaction });
  const conflict = existing.find(row => String(row.product_id) !== String(productId));
  if (conflict) throw createPnConflictError(code);
  const existingForProduct = await ProductPn.findAll({ where: { product_id: productId }, transaction });
  assertSingleSnProductPn({
    needSn: product.need_sn,
    productCode: product.product_code,
    configuredCodes: existingForProduct
      .filter(row => Number(row.is_deleted || 0) === 0 && Number(row.status || 0) === 1)
      .map(row => row.pn_code),
    requestedCode: code
  });
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
      throw createPnConflictError(code);
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

/**
 * 以编辑页提交的 PN 列表为商品当前 PN 主数据快照。
 * 未出现在本次列表中的 PN 只做软删除，保留历史记录和原 pn_id。
 */
async function syncProductPnsMaster({ productId, pns, transaction = null }) {
  const productKey = String(productId || '');
  if (!productKey) return [];
  if (!Array.isArray(pns)) {
    throw Object.assign(new Error('PN列表格式不正确'), { status: 400 });
  }

  const product = await Product.findByPk(productId, {
    attributes: ['product_id', 'product_code', 'need_sn'],
    transaction
  });
  if (!product) throw Object.assign(new Error('商品不存在'), { status: 404 });

  const entries = [];
  const seen = new Set();
  for (const item of pns) {
    const code = String(item?.pnCode ?? item?.pn_code ?? '').trim();
    if (!isUsablePnCode(code)) {
      throw Object.assign(new Error('PN码不能为空或不能使用占位值'), { status: 400 });
    }
    const key = normalizePnCode(code);
    if (seen.has(key)) {
      throw Object.assign(new Error(`PN码 [${code}] 重复`), { status: 400 });
    }
    seen.add(key);
    entries.push({
      code,
      key,
      barcode: item?.barcode === undefined ? undefined : String(item.barcode || '').trim(),
      isPrimary: item?.isPrimary === true || Number(item?.isPrimary) === 1
    });
  }

  if (entries.length === 0) {
    throw Object.assign(new Error('至少需要保留一个PN码'), { status: 400 });
  }

  assertSingleSnProductPn({
    needSn: product.need_sn,
    productCode: product.product_code,
    configuredCodes: entries.map(entry => entry.code)
  });

  const existingRows = await ProductPn.findAll({
    where: { product_id: productId },
    order: [['is_deleted', 'ASC'], ['is_primary', 'DESC'], ['pn_id', 'ASC']],
    transaction
  });
  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = normalizePnCode(row.pn_code);
    if (key && !existingByKey.has(key)) existingByKey.set(key, row);
  }

  const primaryIndex = entries.findIndex(entry => entry.isPrimary);
  const selectedPrimaryIndex = primaryIndex >= 0
    ? primaryIndex
    : Math.max(entries.findIndex(entry => {
        const existing = existingByKey.get(entry.key);
        return Number(existing?.is_primary || 0) === 1;
      }), 0);
  const retainedIds = new Set();
  const synced = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const sameCodeRows = await ProductPn.findAll({
      where: { [Op.and]: [pnCodeWhere(entry.code)] },
      transaction
    });
    const conflict = sameCodeRows.find(row => String(row.product_id) !== productKey);
    if (conflict) {
      throw createPnConflictError(entry.code);
    }

    const existing = existingByKey.get(entry.key);
    const updateData = {
      pn_code: entry.code,
      status: 1,
      is_deleted: 0,
      is_primary: index === selectedPrimaryIndex ? 1 : 0
    };
    if (entry.barcode !== undefined) updateData.barcode = entry.barcode || entry.code;

    const record = existing
      ? await existing.update(updateData, { transaction })
      : await ProductPn.create({
          pn_id: generateUUID(),
          product_id: productId,
          pn_code: entry.code,
          barcode: entry.barcode || entry.code,
          is_primary: index === selectedPrimaryIndex ? 1 : 0,
          status: 1,
          is_deleted: 0
        }, { transaction });
    retainedIds.add(record.pn_id);
    synced.push(record);
  }

  const obsoleteIds = existingRows
    .filter(row => !retainedIds.has(row.pn_id))
    .map(row => row.pn_id);
  if (obsoleteIds.length > 0) {
    await ProductPn.update(
      { status: 0, is_deleted: 1, is_primary: 0 },
      { where: { pn_id: { [Op.in]: obsoleteIds } }, transaction }
    );
  }

  return synced;
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
  syncProductPnsMaster,
  ensureSnPnId
};
