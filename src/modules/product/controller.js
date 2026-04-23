/**
 * 商品管理控制器
 */
const { Product, ProductPn, ProductSn } = require('../../models');
const { Op } = require('sequelize');
const { generateProductCode, generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 商品列表
 */
async function getProductList(ctx) {
  const { keyword, category, needSn, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (category) where.category = category;
  if (needSn !== undefined) where.need_sn = needSn;
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { product_code: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Product.findAndCountAll({
    where,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 创建商品
 */
async function createProduct(ctx) {
  const { name, category, needSn, needImei, standardPrice, costPrice, unit, specsJson, remark } = ctx.request.body;

  const productCode = generateProductCode();
  const productId = generateUUID();

  await Product.create({
    product_id: productId,
    product_code: productCode,
    name,
    category,
    need_sn: needSn ? 1 : 0,
    need_imei: needImei ? 1 : 0,
    standard_price: standardPrice,
    cost_price: costPrice,
    unit: unit || '台',
    specs_json: specsJson,
    remark
  });

  ctx.body = { productId, productCode, message: '商品创建成功' };
}

/**
 * 更新商品
 */
async function updateProduct(ctx) {
  const { productId } = ctx.params;
  const data = ctx.request.body;

  const product = await Product.findByPk(productId);
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  await product.update(data);
  ctx.body = { message: '商品更新成功' };
}

/**
 * PN列表
 */
async function getPnList(ctx) {
  const { productId, keyword, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (productId) where.product_id = productId;
  if (keyword) {
    where[Op.or] = [
      { pn_code: { [Op.like]: `%${keyword}%` } },
      { barcode: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await ProductPn.findAndCountAll({
    where,
    include: [{ model: Product, attributes: ['name', 'product_code'] }],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 添加PN
 */
async function addPn(ctx) {
  const { productId, pnCode, barcode, isPrimary } = ctx.request.body;

  const pnId = generateUUID();

  await ProductPn.create({
    pn_id: pnId,
    product_id: productId,
    pn_code: pnCode,
    barcode,
    is_primary: isPrimary ? 1 : 0
  });

  ctx.body = { pnId, message: 'PN添加成功' };
}

/**
 * 获取商品类别列表
 */
async function getCategory(ctx) {
  const categories = await Product.findAll({
    attributes: ['category'],
    where: { is_deleted: 0, category: { [Op.ne]: null } },
    group: ['category'],
    raw: true
  });

  ctx.body = categories.map(c => c.category);
}

module.exports = { getProductList, createProduct, updateProduct, getPnList, addPn, getCategory };
