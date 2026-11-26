const { Op } = require('sequelize');
const { normalizeSnCode } = require('./snCode');

async function findInboundSnByIdentity({ pnCode, productId, snCode, transaction }) {
  const code = normalizeSnCode(snCode);
  const pn = String(pnCode || '').trim().toUpperCase();
  if (!code || (!pn && !productId)) return null;
  const { ProductSn, sequelize } = require('../models');
  const normalized = column => sequelize.fn('UPPER', sequelize.fn('TRIM', sequelize.col(column)));
  const lock = transaction?.LOCK?.UPDATE;
  const selectOne = rows => {
    if (rows.length > 1) throw Object.assign(new Error('该商品下存在多条相同 SN，需核对库存身份'), { status: 409 });
    return rows[0] || null;
  };
  const exact = selectOne(await ProductSn.findAll({
    where: { sn_code: code, ...(pn ? { pn_code: pn } : { product_id: productId }) },
    limit: 2, transaction, lock
  }));
  if (exact) return exact;

  const identity = pn ? sequelize.where(normalized('pn_code'), pn) : { product_id: productId };
  const legacy = selectOne(await ProductSn.findAll({
    where: { [Op.and]: [sequelize.where(normalized('sn_code'), code.toUpperCase()), identity] },
    limit: 2, transaction
  }));
  if (!legacy || !transaction) return legacy;
  const locked = await ProductSn.findByPk(legacy.sn_id, { transaction, lock });
  if (!locked || normalizeSnCode(locked.sn_code).toUpperCase() !== code.toUpperCase()
    || (pn ? String(locked.pn_code || '').trim().toUpperCase() !== pn : String(locked.product_id) !== String(productId))) {
    throw Object.assign(new Error('SN库存身份已变化，请重新查询'), { status: 409 });
  }
  return locked;
}

module.exports = { findInboundSnByIdentity };
