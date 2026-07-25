/**
 * 商品管理控制器
 * 基础信息 / 分类管理 / 条码管理 / 价格管理
 */
const {
  Product,
  ProductPn,
  ProductSn,
  ProductBarcode,
  ProductCategory,
  ProductCategoryField,
  ProductApplication,
  ProductPrice,
  ProductPriceImportBatch,
  ProductPriceChangeLog,
  ProductImportTask,
  Inventory,
  Store
} = require('../../models');
const { Op, Sequelize } = require('sequelize');
const { sequelize } = require('../../config/database');
const { generateProductCode, generateUUID, generateId, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { normalizePnCode, splitPnCodes, isUsablePnCode } = require('../../utils/productPn');
const XLSX = require('xlsx');
const { getUserRoles } = require('../../middleware/permission');

// 字段标识到数据库列名的映射（field_key → DB column）
const FIELD_TO_COLUMN = {
  'brand': 'brand',
  '品牌': 'brand',
  'series': 'series',
  '系列': 'series',
  'model': 'model',
  '型号': 'model',
  'processor': 'processor',
  'cpu': 'processor',
  'CPU': 'processor',
  '处理器': 'processor',
  'memory': 'memory',
  'mem': 'memory',
  '内存': 'memory',
  'storage': 'storage',
  'harddisk': 'storage',
  '硬盘': 'storage',
  '存储': 'storage',
  'color': 'color',
  '颜色': 'color',
  'gpu': 'gpu',
  '显卡': 'gpu',
  'GPU': 'gpu',
  'accessory_type': 'accessory_type',
  '类别': 'accessory_type',
  '配件类别': 'accessory_type',
};

const DB_COLUMNS = new Set(Object.values(FIELD_TO_COLUMN));

function splitAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return { cols: {}, extras: {} };
  const cols = {};
  const extras = {};
  for (const [k, v] of Object.entries(attributes)) {
    const normalizedKey = String(k).trim();
    const col = FIELD_TO_COLUMN[normalizedKey] || FIELD_TO_COLUMN[normalizedKey.toLowerCase()];
    if (col) {
      cols[col] = v;
    } else {
      extras[k] = v;
    }
  }
  return { cols, extras };
}

function parseProductExtras(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getProductAttributeValue(product, column, mappedExtras) {
  return product[column] || mappedExtras[column] || '';
}

function buildAttributesFromCols(cols, extras) {
  const attrs = {};
  for (const [col, val] of Object.entries(cols)) {
    if (val) attrs[col] = val;
  }
  for (const [k, v] of Object.entries(extras || {})) {
    attrs[k] = v;
  }
  return Object.keys(attrs).length > 0 ? attrs : null;
}

function getManufacturerCodes(barcodes, fallback) {
  const codes = [];
  if (Array.isArray(barcodes)) {
    for (const bc of barcodes) {
      if ((bc.type || 'manufacturer') === 'manufacturer' && bc.code) {
        codes.push(String(bc.code).trim());
      }
    }
  }
  splitPnCodes(fallback).forEach(code => codes.push(code));
  const seen = new Set();
  return codes
    .map(code => String(code || '').trim())
    .filter(code => {
      const key = normalizePnCode(code);
      if (!isUsablePnCode(code) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function ensureProductPns(productId, codes, transaction = null) {
  const productKey = String(productId || '');
  if (!productKey) return [];

  const normalizedCodes = splitPnCodes(codes);
  if (normalizedCodes.length === 0) return [];

  const existingForProduct = await ProductPn.findAll({
    where: { product_id: productId },
    transaction
  });
  const existingByKey = new Map(
    existingForProduct.map(row => [normalizePnCode(row.pn_code), row])
  );
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
      where: {
        [Op.and]: [sequelize.where(
          sequelize.fn('LOWER', sequelize.fn('REPLACE', sequelize.fn('TRIM', sequelize.col('pn_code')), ' ', '')),
          normalizePnCode(code)
        )]
      },
      transaction
    });
    const conflict = sameCodeRows.find(row => String(row.product_id) !== productKey);
    if (conflict) {
      throw Object.assign(new Error(`PN码 [${code}] 已关联其他商品，不能重复绑定`), { status: 409 });
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

function appendCode(existing, code) {
  const codes = splitPnCodes(existing);
  const value = String(code || '').trim();
  if (value && !codes.some(item => normalizePnCode(item) === normalizePnCode(value))) codes.push(value);
  return codes.join(', ');
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(/[,￥¥\s]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function isEmptyCell(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function parseExcelDate(value) {
  if (isEmptyCell(value)) return new Date();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, Math.floor(parsed.S || 0));
  }

  const text = String(value).trim();
  const normalized = text.replace(/\./g, '-');
  const localDate = new Date(normalized.replace(/-/g, '/'));
  if (!Number.isNaN(localDate.getTime())) return localDate;
  return null;
}

function moneyNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

function getUserName(ctx) {
  return ctx.state.user?.name || ctx.state.user?.phone || 'system';
}

function productHasManufacturerCode(product, manufacturerCode) {
  const code = String(manufacturerCode || '').trim();
  if (!code || !product) return false;
  const codes = splitPnCodes(product.manufacturer_code);
  for (const bc of product.ProductBarcodes || []) {
    if (bc.barcode_type === 'manufacturer') codes.push(String(bc.barcode_code || '').trim());
  }
  return codes.some(value => normalizePnCode(value) === normalizePnCode(code));
}

async function findProductsByManufacturerCode(manufacturerCode) {
  const code = String(manufacturerCode || '').trim();
  if (!code) return [];

  const barcodeRows = await ProductBarcode.findAll({
    where: { barcode_type: 'manufacturer', barcode_code: code, status: 1 },
    attributes: ['product_id'],
    raw: true
  });
  const productIds = new Set(barcodeRows.map(row => row.product_id).filter(Boolean));

  const fallbackProducts = await Product.findAll({
    where: {
      is_deleted: 0,
      manufacturer_code: { [Op.like]: `%${code}%` }
    },
    include: [{ model: ProductBarcode, attributes: ['barcode_type', 'barcode_code'], where: { status: 1 }, required: false }]
  });
  for (const product of fallbackProducts) {
    if (productHasManufacturerCode(product, code)) productIds.add(product.product_id);
  }

  if (productIds.size === 0) return [];
  return Product.findAll({
    where: { product_id: { [Op.in]: Array.from(productIds) }, is_deleted: 0 },
    include: [{ model: ProductBarcode, attributes: ['barcode_type', 'barcode_code'], where: { status: 1 }, required: false }],
    order: [['product_code', 'ASC']]
  });
}

function priceFieldLabel(field) {
  if (field === 'standard_price') return '定价';
  if (field === 'retail_price') return '零售价';
  if (field === 'min_sale_price') return '最低售价';
  return field;
}

function getRowValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
}

function getSalesInventoryQty(inv) {
  return Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  );
}

async function buildSalesStockMap(productIds, storeId = '') {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))];
  const stockMap = {};
  if (uniqueProductIds.length === 0) return stockMap;

  const inventories = await Inventory.findAll({
    where: { product_id: { [Op.in]: uniqueProductIds } },
    raw: true
  });
  const storeIds = [...new Set(inventories.map(inv => inv.store_id).filter(Boolean))];
  const stores = storeIds.length
    ? await Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'name'], raw: true })
    : [];
  const storeNameMap = new Map(stores.map(store => [store.store_id, store.name]));

  for (const inv of inventories) {
    const productId = inv.product_id;
    if (!stockMap[productId]) {
      stockMap[productId] = { current: 0, other: 0, total: 0, stores: [], currentStore: null, otherStores: [] };
    }

    const qty = getSalesInventoryQty(inv);
    if (qty <= 0) continue;

    const storeRow = {
      store_id: inv.store_id || '',
      store_name: storeNameMap.get(inv.store_id) || inv.store_id || '未知门店',
      normal_qty: qty,
      is_current: Boolean(storeId && inv.store_id === storeId)
    };

    stockMap[productId].stores.push(storeRow);
    stockMap[productId].total += qty;
    if (storeId && inv.store_id === storeId) {
      stockMap[productId].current += qty;
      stockMap[productId].currentStore = storeRow;
    } else {
      stockMap[productId].other += qty;
      stockMap[productId].otherStores.push(storeRow);
    }
  }

  return stockMap;
}

async function buildSalesCountMap(productIds) {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))];
  const salesMap = {};
  if (uniqueProductIds.length === 0) return salesMap;

  const now = new Date();
  const date7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const date30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const rows = await sequelize.query(
    `SELECT oi.PRODUCT_ID AS product_id,
            SUM(CASE WHEN o.CREATE_TIME >= :date7 THEN oi.QUANTITY ELSE 0 END) AS sales_7_qty,
            SUM(CASE WHEN o.CREATE_TIME >= :date30 THEN oi.QUANTITY ELSE 0 END) AS sales_30_qty
       FROM T_ORDER_ITEM oi
       INNER JOIN T_ORDER o ON oi.ORDER_ID = o.ORDER_ID
      WHERE oi.PRODUCT_ID IN (:productIds)
        AND (o.ORDER_STATUS IS NULL OR o.ORDER_STATUS NOT IN ('cancelled', 'rejected'))
      GROUP BY oi.PRODUCT_ID`,
    { replacements: { productIds: uniqueProductIds, date7, date30 }, type: Sequelize.QueryTypes.SELECT }
  );

  rows.forEach(row => {
    salesMap[row.product_id] = {
      sales_7_qty: Number(row.sales_7_qty || 0),
      sales_30_qty: Number(row.sales_30_qty || 0)
    };
  });
  return salesMap;
}

async function resolveCategoryPath(categoryId) {
  if (!categoryId) return '';
  const parts = [];
  let currentId = categoryId;
  while (currentId) {
    const cat = await ProductCategory.findByPk(currentId, { raw: true });
    if (!cat) break;
    parts.unshift(cat.name);
    currentId = cat.parent_id;
  }
  return parts.join('/');
}

async function findCategoryByName(categoryPath) {
  if (!categoryPath) return null;
  const cats = await ProductCategory.findAll({ where: {}, raw: true });
  const catMap = {};
  for (const c of cats) {
    const id = c.category_id;
    const parts = [c.name];
    let pId = c.parent_id;
    while (pId) {
      for (const cc of cats) {
        if (cc.category_id === pId) { parts.unshift(cc.name); pId = cc.parent_id; break; }
      }
    }
    catMap[parts.join('/')] = id;
  }
  return catMap[categoryPath] || null;
}

async function getProductList(ctx) {
  const { keyword, categoryId, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (categoryId) {
    const path = await resolveCategoryPath(categoryId);
    if (path) where.category = { [Op.like]: `${path}%` };
  }

  // 处理关键字查询：支持空格分隔多关键字 AND 查询，同时支持条码查询
  if (keyword) {
    const keywords = keyword.trim().split(/\s+/).filter(k => k);
    
    // 1. 先查找匹配条码的商品ID
    const matchedProductIdsByBarcode = new Set();
    const barcodeMatches = await ProductBarcode.findAll({
      where: {
        status: 1,
        [Op.or]: keywords.map(k => ({
          barcode_code: { [Op.like]: `%${k}%` }
        }))
      },
      attributes: ['product_id'],
      raw: true
    });
    barcodeMatches.forEach(b => matchedProductIdsByBarcode.add(b.product_id));

    // 2. 构建商品字段查询条件（每个关键字都要匹配）
    const productFieldConditions = [];
    for (const k of keywords) {
      productFieldConditions.push({
        [Op.or]: [
          { name: { [Op.like]: `%${k}%` } },
          { product_code: { [Op.like]: `%${k}%` } },
          { config: { [Op.like]: `%${k}%` } },
          { brand: { [Op.like]: `%${k}%` } },
          { series: { [Op.like]: `%${k}%` } },
          { model: { [Op.like]: `%${k}%` } },
          { processor: { [Op.like]: `%${k}%` } },
          { memory: { [Op.like]: `%${k}%` } },
          { storage: { [Op.like]: `%${k}%` } },
          { color: { [Op.like]: `%${k}%` } },
          { gpu: { [Op.like]: `%${k}%` } },
          { accessory_type: { [Op.like]: `%${k}%` } }
        ]
      });
    }

    // 3. 合并查询条件：商品字段匹配 OR 条码匹配
    if (matchedProductIdsByBarcode.size > 0) {
      if (productFieldConditions.length > 0) {
        where[Op.or] = [
          { product_id: { [Op.in]: Array.from(matchedProductIdsByBarcode) } },
          { [Op.and]: productFieldConditions }
        ];
      } else {
        where.product_id = { [Op.in]: Array.from(matchedProductIdsByBarcode) };
      }
    } else if (productFieldConditions.length > 0) {
      where[Op.and] = productFieldConditions;
    }
  }

  const { count, rows } = await Product.findAndCountAll({
    where,
    include: [
      { model: ProductBarcode, attributes: ['barcode_id', 'barcode_type', 'barcode_code'], where: { status: 1 }, required: false }
    ],
    order: [['create_time', 'DESC'], ['product_id', 'DESC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) }),
    distinct: true
  });

  const list = rows.map(p => {
    const allBarcodes = (p.ProductBarcodes || []).map(b => ({ barcode_id: b.barcode_id, type: b.barcode_type, code: b.barcode_code }));
    const extras = parseProductExtras(p.extras);
    const { cols: mappedExtras } = splitAttributes(extras);
    return {
      product_id: p.product_id,
      product_code: p.product_code,
      name: p.name,
      config: p.config || '',
      category: p.category || '',
      manufacturer_code: p.manufacturer_code || '',
      brand: getProductAttributeValue(p, 'brand', mappedExtras),
      series: getProductAttributeValue(p, 'series', mappedExtras),
      model: getProductAttributeValue(p, 'model', mappedExtras),
      processor: getProductAttributeValue(p, 'processor', mappedExtras),
      memory: getProductAttributeValue(p, 'memory', mappedExtras),
      storage: getProductAttributeValue(p, 'storage', mappedExtras),
      color: getProductAttributeValue(p, 'color', mappedExtras),
      gpu: getProductAttributeValue(p, 'gpu', mappedExtras),
      accessory_type: getProductAttributeValue(p, 'accessory_type', mappedExtras),
      extras,
      manufacturer_codes: splitPnCodes(p.manufacturer_code).length > 0 ? splitPnCodes(p.manufacturer_code) : allBarcodes.filter(b => b.type === 'manufacturer').map(b => b.code),
      barcodes: allBarcodes,
      need_sn: Number(p.need_sn || 0),
      need_imei: Number(p.need_imei || 0),
      unit: p.unit || '台',
      remark: p.remark || '',
      create_time: p.create_time || '',
      is_focus_product: Number(p.is_focus_product || 0),
      status: p.status
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function resolveProductApplicationName(body) {
  const { name, categoryId, attributes } = body;
  let parsedAttrs = attributes;
  if (typeof attributes === 'string') {
    try { parsedAttrs = JSON.parse(attributes); } catch { parsedAttrs = {}; }
  }
  let finalName = name || '';
  if (!finalName && parsedAttrs && typeof parsedAttrs === 'object') {
    const fields = await ProductCategoryField.findAll({
      where: { category_id: categoryId, status: 1 },
      order: [['sort_order', 'ASC']],
      raw: true
    });
    if (fields.length > 0) {
      const parts = [];
      for (const f of fields) {
        const val = parsedAttrs[f.field_key];
        if (val) parts.push(val);
      }
      finalName = parts.join(' ') || name || '';
    }
  }
  return { finalName: String(finalName || '').trim(), parsedAttrs: parsedAttrs || {} };
}

function productApplicationPayload(body, finalName, parsedAttrs) {
  const submittedBarcodes = Array.isArray(body.barcodes)
    ? body.barcodes.map(item => ({ type: item.type || 'manufacturer', code: item.code || '' })).filter(item => item.code)
    : [];
  const pnCode = String(
    body.pnCode || body.pn_code || body.pn || body.manufacturerCode || body.manufacturer_code || ''
  ).trim();
  if (pnCode && !submittedBarcodes.some(item => String(item.code) === pnCode)) {
    submittedBarcodes.unshift({ type: 'manufacturer', code: pnCode });
  }
  // 标签照片随商品申请保存在 payload_json 中，审批列表接口会原样返回该字段。
  // 兼容小程序历史版本使用的 Id/Url 及蛇形命名，避免照片在提交申请时被丢弃。
  const labelPhotoIds = body.labelPhotoIds || body.label_photo_ids || body.labelPhotoUrls || body.label_photo_urls || [];
  const labelPhotoUrls = body.labelPhotoUrls || body.label_photo_urls || labelPhotoIds;
  return {
    name: finalName,
    categoryId: body.categoryId || null,
    config: body.config || '',
    needSn: body.needSn ? 1 : 0,
    needImei: body.needImei ? 1 : 0,
    unit: body.unit || '台',
    remark: body.remark || '',
    barcodes: submittedBarcodes,
    attributes: parsedAttrs,
    status: 1,
    manufacturerCode: body.manufacturerCode || body.manufacturer_code || '',
    labelPhotoIds,
    labelPhotoUrls,
    labelPhotoUrl: body.labelPhotoUrl || body.label_photo_url || (Array.isArray(labelPhotoIds) ? labelPhotoIds[0] || '' : ''),
    isFocusProduct: body.isFocusProduct === true || body.is_focus_product === true || Number(body.isFocusProduct ?? body.is_focus_product) === 1
  };
}

async function createProductRecord(body, transaction = null) {
  const {
    name, categoryId, config, needSn, needImei, unit, remark, barcodes, attributes,
    status = 1, manufacturerCode, manufacturer_code, isFocusProduct, is_focus_product
  } = body;
  const productId = generateUUID();
  const categoryPath = categoryId ? await resolveCategoryPath(categoryId) : '';
  const { finalName, parsedAttrs } = await resolveProductApplicationName(body);
  if (!finalName) throw new Error('商品名称不能为空');

  const { cols, extras } = splitAttributes(parsedAttrs);

  const manufacturerCodes = getManufacturerCodes(barcodes, manufacturerCode || manufacturer_code);
  let lastError;
  let productCode = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    productCode = await generateProductCode(Product);
    try {
      await Product.create({
        product_id: productId,
        product_code: productCode,
        name: finalName,
        category: categoryPath,
        config: config || '',
        manufacturer_code: manufacturerCodes.join(', '),
        brand: cols.brand || null,
        series: cols.series || null,
        model: cols.model || null,
        processor: cols.processor || null,
        memory: cols.memory || null,
        storage: cols.storage || null,
        color: cols.color || null,
        gpu: cols.gpu || null,
        accessory_type: cols.accessory_type || null,
        extras: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
        need_sn: needSn ? 1 : 0,
        need_imei: needImei ? 1 : 0,
        unit: unit || '台',
        remark: remark || '',
        is_focus_product: isFocusProduct === true || is_focus_product === true || Number(isFocusProduct ?? is_focus_product) === 1 ? 1 : 0,
        create_time: new Date(),
        status
      }, { transaction });
      lastError = null;
      break;
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw new Error('商品编码生成冲突，请重试');

  if (barcodes && Array.isArray(barcodes)) {
    for (const bc of barcodes) {
      if (!bc.code) continue;
      await ProductBarcode.create({
        barcode_id: generateUUID(),
        product_id: productId,
        barcode_type: bc.type || 'manufacturer',
        barcode_code: bc.code,
        sort_order: 0,
        status: 1
      }, { transaction });
    }
  }

  await ensureProductPns(productId, manufacturerCodes, transaction);

  return { productId, productCode, productName: finalName };
}

async function createProduct(ctx) {
  const transaction = await sequelize.transaction();
  let created;
  try {
    created = await createProductRecord(ctx.request.body, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  ctx.body = { code: 0, ...created, message: '商品创建成功' };
}

async function submitProductApplication(ctx) {
  const { finalName, parsedAttrs } = await resolveProductApplicationName(ctx.request.body);
  if (!finalName) ctx.throw(400, '商品名称不能为空');
  if (!ctx.request.body.categoryId) ctx.throw(400, '商品分类不能为空');
  const pnCode = String(
    ctx.request.body.pnCode || ctx.request.body.pn_code || ctx.request.body.pn ||
    ctx.request.body.manufacturerCode || ctx.request.body.manufacturer_code ||
    ((ctx.request.body.barcodes || []).find(item => item && item.code) || {}).code || ''
  ).trim();
  if (!pnCode) ctx.throw(400, 'PN码不能为空');

  const categoryPath = await resolveCategoryPath(ctx.request.body.categoryId);
  const payload = productApplicationPayload(ctx.request.body, finalName, parsedAttrs);
  const applicationId = generateUUID();
  const applicationNo = `PA${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  await ProductApplication.create({
    application_id: applicationId,
    application_no: applicationNo,
    product_name: finalName,
    category_id: ctx.request.body.categoryId,
    category_name: categoryPath,
    payload_json: payload,
    applicant_staff_id: ctx.state.user.staffId,
    applicant_name: ctx.state.user.name,
    distributor_id: ctx.state.user.distributorId || '',
    status: 'pending',
    create_time: new Date(),
    update_time: new Date()
  });

  ctx.body = {
    code: 0,
    applicationId,
    applicationNo,
    pendingApproval: true,
    status: 'pending',
    message: '新建商品申请已提交，审批通过后生成正式商品'
  };
}

function canReviewProductApplication(user) {
  const roles = getUserRoles(user);
  return roles.some(role => ['finance', 'purchaser', 'admin', 'boss'].includes(role));
}

async function getProductApplicationList(ctx) {
  const page = Number(ctx.query.page || 1);
  const pageSize = Number(ctx.query.pageSize || 20);
  const where = {};
  if (ctx.query.status) where.status = ctx.query.status;
  const keyword = String(ctx.query.keyword || '').trim();
  if (keyword) {
    const keywordLike = `%${keyword}%`;
    where[Op.or] = [
      { application_no: { [Op.like]: keywordLike } },
      { product_name: { [Op.like]: keywordLike } },
      { category_name: { [Op.like]: keywordLike } },
      { applicant_name: { [Op.like]: keywordLike } },
      { payload_json: { [Op.like]: keywordLike } }
    ];
  }

  if (!canReviewProductApplication(ctx.state.user)) {
    where.applicant_staff_id = ctx.state.user.staffId;
  } else if (!getUserRoles(ctx.state.user).includes('boss')) {
    where.distributor_id = ctx.state.user.distributorId || '';
  }

  const { limit, offset } = paginate({}, { page, pageSize });
  const { rows, count } = await ProductApplication.findAndCountAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'ProductApplication.status',
      pendingStatuses: ['pending'],
      dateColumns: ['ProductApplication.create_time'],
      idColumn: 'ProductApplication.application_id'
    }),
    limit,
    offset
  });
  ctx.body = {
    code: 0,
    data: formatPaginatedResult(rows.map(row => row.toJSON()), { page, pageSize, count })
  };
}

async function reviewProductApplication(ctx) {
  const { applicationId } = ctx.params;
  const { action, comment = '' } = ctx.request.body;
  if (!['approved', 'rejected'].includes(action)) ctx.throw(400, '审批结果不正确');
  if (action === 'rejected' && !String(comment).trim()) ctx.throw(400, '拒绝时必须填写审批意见');

  const transaction = await sequelize.transaction();
  try {
    const application = await ProductApplication.findByPk(applicationId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!application) ctx.throw(404, '商品申请不存在');
    if (application.status !== 'pending') ctx.throw(400, '该申请已完成审批');
    if (Number(application.applicant_staff_id) === Number(ctx.state.user.staffId)) {
      ctx.throw(403, '申请人不能审批自己的商品申请');
    }
    if (!getUserRoles(ctx.state.user).includes('boss') && application.distributor_id !== (ctx.state.user.distributorId || '')) {
      ctx.throw(403, '无权审批其他经销商的商品申请');
    }

    let created = null;
    if (action === 'approved') {
      const payload = typeof application.payload_json === 'string'
        ? JSON.parse(application.payload_json)
        : application.payload_json;
      created = await createProductRecord(payload, transaction);
    }

    await application.update({
      status: action,
      review_staff_id: ctx.state.user.staffId,
      review_user_name: ctx.state.user.name,
      review_comment: String(comment || '').trim(),
      review_time: new Date(),
      product_id: created ? created.productId : null,
      update_time: new Date()
    }, { transaction });
    await transaction.commit();

    ctx.body = {
      code: 0,
      applicationId,
      status: action,
      productId: created ? created.productId : null,
      productCode: created ? created.productCode : null,
      message: action === 'approved' ? '审批通过，正式商品已创建' : '商品申请已拒绝'
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function updateProduct(ctx) {
  const { productId } = ctx.params;
  const body = ctx.request.body;
  const {
    name, categoryId, config, needSn, needImei, unit, remark, barcodes, status,
    attributes, manufacturerCode, manufacturer_code, isFocusProduct, is_focus_product
  } = body;
  const manufacturerInput = manufacturerCode !== undefined ? manufacturerCode : manufacturer_code;

  const product = await Product.findByPk(productId);
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  const categoryPath = categoryId !== undefined ? await resolveCategoryPath(categoryId) : undefined;

  let parsedAttrs = attributes;
  if (typeof attributes === 'string') {
    try { parsedAttrs = JSON.parse(attributes); } catch { parsedAttrs = {}; }
  }
  const { cols, extras } = splitAttributes(parsedAttrs);

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (categoryPath !== undefined) updateData.category = categoryPath;
  if (config !== undefined) updateData.config = config;
  if (status !== undefined) updateData.status = status;
  if (needSn !== undefined) updateData.need_sn = needSn ? 1 : 0;
  if (needImei !== undefined) updateData.need_imei = needImei ? 1 : 0;
  if (unit !== undefined) updateData.unit = unit;
  if (remark !== undefined) updateData.remark = remark;
  if (isFocusProduct !== undefined || is_focus_product !== undefined) {
    const focusValue = isFocusProduct ?? is_focus_product;
    updateData.is_focus_product = focusValue === true || Number(focusValue) === 1 ? 1 : 0;
  }
  if (manufacturerInput !== undefined) {
    updateData.manufacturer_code = getManufacturerCodes([], manufacturerInput).join(', ');
  }
  if (attributes !== undefined) {
    updateData.brand = cols.brand || null;
    updateData.series = cols.series || null;
    updateData.model = cols.model || null;
    updateData.processor = cols.processor || null;
    updateData.memory = cols.memory || null;
    updateData.storage = cols.storage || null;
    updateData.color = cols.color || null;
    updateData.gpu = cols.gpu || null;
    updateData.accessory_type = cols.accessory_type || null;
    updateData.extras = Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
  }

  if (barcodes !== undefined) {
    updateData.manufacturer_code = getManufacturerCodes(barcodes, manufacturerInput).join(', ');
  }

  const transaction = await sequelize.transaction();
  try {
    await product.update(updateData, { transaction });

    // 条码：删除旧的全部，重新创建
    if (barcodes !== undefined) {
      await ProductBarcode.update({ status: 0 }, { where: { product_id: productId }, transaction });
      if (Array.isArray(barcodes)) {
        for (const bc of barcodes) {
          if (bc.code) {
            await ProductBarcode.create({
              barcode_id: generateUUID(),
              product_id: productId,
              barcode_type: bc.type || 'manufacturer',
              barcode_code: String(bc.code).trim(),
              sort_order: 0,
              status: 1
            }, { transaction });
          }
        }
      }
    }

    if (manufacturerInput !== undefined || barcodes !== undefined) {
      const nextCodes = barcodes !== undefined
        ? getManufacturerCodes(barcodes, manufacturerInput)
        : getManufacturerCodes([], manufacturerInput);
      await ensureProductPns(productId, nextCodes, transaction);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  ctx.body = { code: 0, message: '商品更新成功' };
}

async function deleteProduct(ctx) {
  const { productId } = ctx.params;

  const product = await Product.findOne({
    where: { product_id: productId, is_deleted: 0 }
  });

  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  // 检查库存，有库存不允许删除
  const totalStock = await Inventory.sum('NORMAL_QTY', {
    where: { product_id: productId }
  }) || 0;
  const displayStock = await Inventory.sum('DISPLAY_QTY', {
    where: { product_id: productId }
  }) || 0;
  const demoeStock = await Inventory.sum('DEMO_QTY', {
    where: { product_id: productId }
  }) || 0;

  if (totalStock + displayStock + demoeStock > 0) {
    ctx.throw(400, `商品还有库存（正常:${totalStock} 铺货:${displayStock} 样机:${demoeStock}），不允许删除`);
  }

  // 软删除商品及关联数据
  await Promise.all([
    product.update({ is_deleted: 1 }),
    ProductPrice.update({ status: 0 }, { where: { product_id: productId } }),
    ProductBarcode.update({ status: 0 }, { where: { product_id: productId } }),
    ProductPn.update({ is_deleted: 1 }, { where: { product_id: productId } })
  ]);

  ctx.body = { code: 0, message: '删除成功' };
}

async function batchDeleteProducts(ctx) {
  const roles = getUserRoles(ctx.state.user);
  if (!roles.includes('admin') && !roles.includes('boss')) {
    ctx.throw(403, '仅admin/boss支持批量删除商品');
  }

  const productIds = Array.isArray(ctx.request.body?.productIds)
    ? [...new Set(ctx.request.body.productIds.map(id => String(id || '').trim()).filter(Boolean))]
    : [];
  if (productIds.length === 0) ctx.throw(400, '请选择要删除的商品');
  if (productIds.length > 100) ctx.throw(400, '单次最多批量删除100个商品');

  const results = [];
  for (const productId of productIds) {
    const product = await Product.findOne({
      where: { product_id: productId, is_deleted: 0 }
    });

    if (!product) {
      results.push({ productId, success: false, message: '商品不存在' });
      continue;
    }

    const totalStock = await Inventory.sum('NORMAL_QTY', {
      where: { product_id: productId }
    }) || 0;
    const displayStock = await Inventory.sum('DISPLAY_QTY', {
      where: { product_id: productId }
    }) || 0;
    const demoeStock = await Inventory.sum('DEMO_QTY', {
      where: { product_id: productId }
    }) || 0;

    if (totalStock + displayStock + demoeStock > 0) {
      results.push({
        productId,
        productCode: product.product_code,
        productName: product.name,
        success: false,
        message: `商品还有库存（正常:${totalStock} 铺货:${displayStock} 样机:${demoeStock}），不允许删除`
      });
      continue;
    }

    await Promise.all([
      product.update({ is_deleted: 1 }),
      ProductPrice.update({ status: 0 }, { where: { product_id: productId } }),
      ProductBarcode.update({ status: 0 }, { where: { product_id: productId } }),
      ProductPn.update({ is_deleted: 1 }, { where: { product_id: productId } })
    ]);

    results.push({
      productId,
      productCode: product.product_code,
      productName: product.name,
      success: true
    });
  }

  const success = results.filter(item => item.success).length;
  const failed = results.length - success;
  ctx.body = {
    code: 0,
    message: failed > 0 ? `批量删除完成，成功${success}个，失败${failed}个` : `批量删除成功，共${success}个`,
    data: { success, failed, results }
  };
}

async function togglePause(ctx) {
  const { productId } = ctx.params;

  const product = await Product.findOne({
    where: { product_id: productId, is_deleted: 0 }
  });

  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  const newStatus = product.status === 1 ? 0 : 1;
  await product.update({ status: newStatus });

  ctx.body = { code: 0, status: newStatus, message: newStatus === 0 ? '已暂停' : '已启用' };
}

// ===== 商品分类管理（三级树形） =====

async function getCategoryTree(ctx) {
  const categories = await ProductCategory.findAll({
    where: { status: 1 },
    order: [['level', 'ASC'], ['sort_order', 'ASC']],
    raw: true
  });

  const tree = buildCategoryTree(categories);
  ctx.body = { code: 0, data: tree };
}

function buildCategoryTree(list, parentId = null) {
  return list
    .filter(item => item.parent_id === parentId)
    .map(item => ({
      ...item,
      children: buildCategoryTree(list, item.category_id)
    }));
}

async function createCategory(ctx) {
  const { parentId, name, sortOrder = 0 } = ctx.request.body;

  if (!name) {
    ctx.throw(400, '分类名称不能为空');
  }

  let level = 1;
  if (parentId) {
    const parent = await ProductCategory.findByPk(parentId);
    if (!parent) {
      ctx.throw(400, '父级分类不存在');
    }
    if (parent.level >= 3) {
      ctx.throw(400, '分类最多支持三级');
    }
    level = parent.level + 1;
  }

  const categoryId = generateUUID();
  await ProductCategory.create({
    category_id: categoryId,
    parent_id: parentId || null,
    name,
    level,
    sort_order: sortOrder
  });

  ctx.body = { code: 0, categoryId, message: '分类创建成功' };
}

async function updateCategory(ctx) {
  const { categoryId } = ctx.params;
  const { name, sortOrder, status } = ctx.request.body;

  const category = await ProductCategory.findByPk(categoryId);
  if (!category) {
    ctx.throw(404, '分类不存在');
  }

  await category.update({
    name: name !== undefined ? name : category.name,
    sort_order: sortOrder !== undefined ? sortOrder : category.sort_order,
    status: status !== undefined ? status : category.status
  });

  ctx.body = { code: 0, message: '分类更新成功' };
}

async function deleteCategory(ctx) {
  const { categoryId } = ctx.params;

  const category = await ProductCategory.findByPk(categoryId);
  if (!category) {
    ctx.throw(404, '分类不存在');
  }

  const childCount = await ProductCategory.count({ where: { parent_id: categoryId, status: 1 } });
  if (childCount > 0) {
    ctx.throw(400, '该分类下还有子分类，请先删除子分类');
  }

  // 检查是否有商品用了此路径
  const path = await resolveCategoryPath(categoryId);
  const productCount = await Product.count({ where: { category: path, is_deleted: 0 } });
  if (productCount > 0) {
    ctx.throw(400, `该分类下还有 ${productCount} 个商品，请先将商品移至其他分类`);
  }

  await category.update({ status: 0 });
  ctx.body = { code: 0, message: '分类删除成功' };
}

async function sortCategories(ctx) {
  const { items } = ctx.request.body;
  if (!Array.isArray(items)) {
    ctx.throw(400, '排序数据格式无效');
  }

  const transaction = await sequelize.transaction();
  try {
    for (const item of items) {
      if (!item.id) continue;
      await ProductCategory.update(
        { sort_order: item.sortOrder },
        { where: { category_id: item.id }, transaction }
      );
    }
    await transaction.commit();
    ctx.body = { code: 0, message: '排序更新成功' };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

// ===== 商品价格管理 =====

async function applyPendingProductPriceChanges() {
  const now = new Date();
  const pendingLogs = await ProductPriceChangeLog.findAll({
    where: {
      status: 'pending',
      effective_time: { [Op.lte]: now }
    },
    order: [['effective_time', 'ASC'], ['create_time', 'ASC']]
  });
  pendingLogs.sort((a, b) => {
    const timeDiff = new Date(a.effective_time).getTime() - new Date(b.effective_time).getTime();
    if (timeDiff !== 0) return timeDiff;
    const productDiff = String(a.product_id).localeCompare(String(b.product_id));
    if (productDiff !== 0) return productDiff;
    if (a.price_field === b.price_field) return 0;
    const order = ['standard_price', 'retail_price', 'min_sale_price'];
    return order.indexOf(a.price_field) - order.indexOf(b.price_field);
  });

  let applied = 0;
  for (const log of pendingLogs) {
    const field = log.price_field;
    if (!['standard_price', 'retail_price', 'min_sale_price'].includes(field)) {
      await log.update({ status: 'failed', fail_reason: `不支持的价格字段: ${field}` });
      continue;
    }

    const transaction = await sequelize.transaction();
    try {
      let price = await ProductPrice.findOne({ where: { product_id: log.product_id }, transaction });
      const oldPrice = moneyNumber(price ? price[field] : 0);
      const nextStandardPrice = field === 'standard_price' ? moneyNumber(log.new_price) : moneyNumber(price?.standard_price);
      const nextRetailPrice = field === 'retail_price' ? moneyNumber(log.new_price) : moneyNumber(price?.retail_price);
      const nextMinSalePrice = field === 'min_sale_price' ? moneyNumber(log.new_price) : moneyNumber(price?.min_sale_price);
      const saleReference = nextRetailPrice > 0 ? nextRetailPrice : nextStandardPrice;
      if (nextMinSalePrice > saleReference) {
        throw new Error('最低售价必须小于或等于零售价');
      }
      if (price) {
        await price.update({
          [field]: moneyNumber(log.new_price),
          effective_time: log.effective_time,
          create_user: log.create_user || 'system'
        }, { transaction });
      } else {
        await ProductPrice.create({
          price_id: generateUUID(),
          product_id: log.product_id,
          cost_price: 0,
          standard_price: field === 'standard_price' ? moneyNumber(log.new_price) : 0,
          retail_price: field === 'retail_price' ? moneyNumber(log.new_price) : 0,
          min_sale_price: field === 'min_sale_price' ? moneyNumber(log.new_price) : 0,
          effective_time: log.effective_time,
          create_user: log.create_user || 'system'
        }, { transaction });
      }

      await log.update({
        old_price: oldPrice,
        status: 'effective',
        applied_time: new Date(),
        fail_reason: null
      }, { transaction });
      await transaction.commit();
      applied++;
    } catch (error) {
      await transaction.rollback();
      await log.update({ status: 'failed', fail_reason: error.message || '生效失败' });
    }
  }

  return applied;
}

async function getPriceList(ctx) {
  await applyPendingProductPriceChanges();

  const { keyword, page = 1, pageSize = 20 } = ctx.query;

  const productWhere = { is_deleted: 0 };
  if (keyword) {
    const keywordLike = `%${keyword}%`;
    const matchedPnRows = await ProductPn.findAll({
      where: {
        is_deleted: 0,
        pn_code: { [Op.like]: keywordLike }
      },
      attributes: ['product_id'],
      raw: true
    });
    const matchedBarcodeRows = await ProductBarcode.findAll({
      where: {
        barcode_type: 'manufacturer',
        barcode_code: { [Op.like]: keywordLike },
        status: 1
      },
      attributes: ['product_id'],
      raw: true
    });
    const matchedProductIds = [...new Set([
      ...matchedPnRows.map(row => row.product_id),
      ...matchedBarcodeRows.map(row => row.product_id)
    ].filter(Boolean))];
    productWhere[Op.or] = [
      { name: { [Op.like]: keywordLike } },
      { product_code: { [Op.like]: keywordLike } },
      { manufacturer_code: { [Op.like]: keywordLike } },
      ...(matchedProductIds.length > 0 ? [{ product_id: { [Op.in]: matchedProductIds } }] : [])
    ];
  }

  const { count, rows } = await Product.findAndCountAll({
    where: productWhere,
    attributes: ['product_id', 'product_code', 'manufacturer_code', 'name', 'unit', 'category'],
    include: [
      { model: ProductPrice, attributes: ['price_id', 'standard_price', 'retail_price', 'min_sale_price', 'cost_price'] }
    ],
    order: [['product_code', 'DESC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) }),
    distinct: true
  });

  const productIds = rows.map(p => p.product_id).filter(Boolean);
  const barcodeRows = productIds.length > 0
    ? await ProductBarcode.findAll({
        where: {
          product_id: { [Op.in]: productIds },
          barcode_type: 'manufacturer',
          status: 1
        },
        attributes: ['product_id', 'barcode_code'],
        order: [['sort_order', 'ASC']],
        raw: true
      })
    : [];
  const manufacturerCodeMap = new Map();
  for (const row of barcodeRows) {
    const list = manufacturerCodeMap.get(row.product_id) || [];
    if (row.barcode_code) list.push(row.barcode_code);
    manufacturerCodeMap.set(row.product_id, list);
  }

  const list = rows.map(p => ({
    product_id: p.product_id,
    product_code: p.product_code,
    manufacturer_code: splitPnCodes(p.manufacturer_code).length > 0
      ? splitPnCodes(p.manufacturer_code).join(', ')
      : (manufacturerCodeMap.get(p.product_id) || []).join(', '),
    name: p.name,
    unit: p.unit,
    category_name: p.category || '',
    price_id: p.ProductPrice ? p.ProductPrice.price_id : null,
    standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
    retail_price: p.ProductPrice ? p.ProductPrice.retail_price : 0,
    min_sale_price: p.ProductPrice ? p.ProductPrice.min_sale_price : 0,
    cost_price: p.ProductPrice ? p.ProductPrice.cost_price : 0
  }));

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function setPrice(ctx) {
  const { productId, standardPrice, retailPrice, minSalePrice } = ctx.request.body;

  if (!productId || standardPrice === undefined || minSalePrice === undefined) {
    ctx.throw(400, '商品ID、标准售价和最低销售价不能为空');
  }

  if (standardPrice < 0 || Number(retailPrice || 0) < 0 || minSalePrice < 0) {
    ctx.throw(400, '价格不能为负数');
  }

  const effectiveRetailPrice = retailPrice === undefined ? Number(standardPrice) : Number(retailPrice);
  if (Number(minSalePrice) > effectiveRetailPrice) {
    ctx.throw(400, '最低售价必须小于或等于零售价');
  }

  const product = await Product.findOne({ where: { product_id: productId, is_deleted: 0 } });
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  const transaction = await sequelize.transaction();
  const now = new Date();
  const userName = getUserName(ctx);

  try {
    let price = await ProductPrice.findOne({ where: { product_id: productId }, transaction });
    const oldStandardPrice = moneyNumber(price?.standard_price);
    const oldRetailPrice = moneyNumber(price?.retail_price);
    const oldMinSalePrice = moneyNumber(price?.min_sale_price);
    const nextStandardPrice = moneyNumber(standardPrice);
    const nextRetailPrice = moneyNumber(effectiveRetailPrice);
    const nextMinSalePrice = moneyNumber(minSalePrice);

    if (price) {
      await price.update({
        standard_price: nextStandardPrice,
        retail_price: nextRetailPrice,
        min_sale_price: nextMinSalePrice,
        effective_time: now,
        create_user: userName
      }, { transaction });
    } else {
      await ProductPrice.create({
        price_id: generateUUID(),
        product_id: productId,
        standard_price: nextStandardPrice,
        retail_price: nextRetailPrice,
        min_sale_price: nextMinSalePrice,
        cost_price: 0,
        effective_time: now,
        create_user: userName
      }, { transaction });
    }

    const logBase = {
      batch_id: null,
      batch_no: null,
      row_no: null,
      product_id: product.product_id,
      product_code: product.product_code,
      product_name: product.name,
      manufacturer_code: product.manufacturer_code || '',
      effective_time: now,
      source: 'manual',
      status: 'effective',
      create_user: userName,
      applied_time: now
    };

    await ProductPriceChangeLog.bulkCreate([
      {
        change_id: generateUUID(),
        ...logBase,
        price_field: 'standard_price',
        old_price: oldStandardPrice,
        new_price: nextStandardPrice
      },
      {
        change_id: generateUUID(),
        ...logBase,
        price_field: 'retail_price',
        old_price: oldRetailPrice,
        new_price: nextRetailPrice
      },
      {
        change_id: generateUUID(),
        ...logBase,
        price_field: 'min_sale_price',
        old_price: oldMinSalePrice,
        new_price: nextMinSalePrice
      }
    ], { transaction });

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  ctx.body = { code: 0, message: '价格设置成功' };
}

function getInventoryQty(inv) {
  return Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  ) + Number(inv.display_qty || 0) + Number(inv.demo_qty || 0) + Number(inv.unsellable_qty || 0);
}

function fifoRemainingAverageCost(layers, currentStockQty) {
  let remaining = Number(currentStockQty || 0);
  let totalCost = 0;
  let totalQty = 0;

  for (const layer of layers) {
    if (remaining <= 0) break;
    const price = Number(layer.unit_price || layer.UNIT_PRICE || 0);
    const qty = Number(layer.quantity || layer.QUANTITY || 0);
    if (price <= 0 || qty <= 0) continue;
    const takeQty = Math.min(qty, remaining);
    totalCost += takeQty * price;
    totalQty += takeQty;
    remaining -= takeQty;
  }

  if (totalQty <= 0) return 0;
  return parseFloat((totalCost / totalQty).toFixed(2));
}

// 计算当前库存平均成本。SN商品按在库SN个别成本平均；非SN商品按FIFO剩余成本层平均。
async function calculateFifoCost(productId) {
  const { sequelize } = require('../../models');
  const product = await Product.findOne({ where: { product_id: productId, is_deleted: 0 }, raw: true });
  if (!product) return 0;

  if (Number(product.need_sn || 0) === 1) {
    const snCost = await ProductSn.findOne({
      where: {
        product_id: productId,
        status: 'in_stock',
        is_deleted: 0,
        inbound_price: { [Op.gt]: 0 }
      },
      attributes: [
        [Sequelize.fn('SUM', Sequelize.col('inbound_price')), 'total_amount'],
        [Sequelize.fn('COUNT', Sequelize.col('sn_id')), 'total_qty']
      ],
      raw: true
    });
    const snQty = Number(snCost?.total_qty || 0);
    if (snQty <= 0) return 0;
    return parseFloat((Number(snCost.total_amount || 0) / snQty).toFixed(2));
  }

  const inventoryRows = await Inventory.findAll({
    where: { product_id: productId },
    raw: true
  });
  const currentStockQty = inventoryRows.reduce((sum, inv) => sum + getInventoryQty(inv), 0);
  if (currentStockQty <= 0) return 0;

  const batches = await sequelize.query(`
    SELECT unit_price, quantity, create_time FROM (
      SELECT 
        ii.UNIT_PRICE AS unit_price,
        ii.QUANTITY AS quantity,
        i.CREATE_TIME AS create_time
      FROM T_INBOUND_ITEM ii
      JOIN T_INBOUND i ON ii.INBOUND_ID = i.INBOUND_ID
      WHERE ii.PRODUCT_ID = ?
        AND i.STATUS IN ('completed', 'executed')
        AND COALESCE(ii.SN_CODE, '') = ''
        AND ii.UNIT_PRICE > 0
        AND ii.QUANTITY > 0
      UNION ALL
      SELECT
        item.UNIT_PRICE AS unit_price,
        item.QUANTITY AS quantity,
        COALESCE(app.EXECUTE_TIME, item.CREATE_TIME, app.CREATE_TIME) AS create_time
      FROM T_INVENTORY_BATCH_APPLICATION_ITEM item
      JOIN T_INVENTORY_BATCH_APPLICATION app ON item.APPLICATION_ID = app.APPLICATION_ID
      WHERE item.PRODUCT_ID = ?
        AND app.STATUS = 'executed'
        AND item.OPERATION_TYPE = 'INBOUND'
        AND COALESCE(item.NEED_SN, 0) = 0
        AND item.UNIT_PRICE > 0
        AND item.QUANTITY > 0
    ) layers
    ORDER BY create_time DESC
  `, {
    replacements: [productId, productId],
    type: sequelize.QueryTypes.SELECT
  });

  return fifoRemainingAverageCost(batches || [], currentStockQty);
}

async function refreshCostPrice(ctx) {
  const { productId } = ctx.params;

  const product = await Product.findOne({ where: { product_id: productId, is_deleted: 0 } });
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  const costPrice = await calculateFifoCost(productId);

  let price = await ProductPrice.findOne({ where: { product_id: productId } });
  if (price) {
    await price.update({
      cost_price: costPrice,
      ...(Number(price.standard_price || 0) <= 0 && costPrice > 0 ? { standard_price: costPrice } : {})
    });
  } else {
    await ProductPrice.create({
      price_id: generateUUID(),
      product_id: productId,
      cost_price: costPrice,
      standard_price: costPrice,
      min_sale_price: 0
    });
  }

  ctx.body = { code: 0, costPrice, message: '成本价刷新成功' };
}

async function batchRefreshCost(ctx) {
  const { productIds } = ctx.request.body;

  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    ctx.throw(400, '请提供商品ID列表');
  }

  const results = [];
  for (const productId of productIds) {
    const costPrice = await calculateFifoCost(productId);

    let price = await ProductPrice.findOne({ where: { product_id: productId } });
    if (price) {
      await price.update({
        cost_price: costPrice,
        ...(Number(price.standard_price || 0) <= 0 && costPrice > 0 ? { standard_price: costPrice } : {})
      });
    } else {
      await ProductPrice.create({
        price_id: generateUUID(),
        product_id: productId,
        cost_price: costPrice,
        standard_price: costPrice,
        min_sale_price: 0
      });
    }
    results.push({ productId, costPrice });
  }

  ctx.body = { code: 0, data: results, message: '批量刷新成本价完成' };
}

// ===== 其他 =====

const IMPORT_TASK_TERMINAL_STATUSES = new Set(['completed', 'partial_failed', 'failed']);
const scheduledProductImportTasks = new Set();

function normalizeImportHeader(value) {
  return String(value ?? '').trim();
}

function parseImportWorkbook(file, importType) {
  if (!file?.buffer) {
    const error = new Error('请上传Excel文件');
    error.status = 400;
    throw error;
  }

  const fileName = String(file.originalname || '').toLowerCase();
  if (fileName && !/\.(xlsx|xls)$/.test(fileName)) {
    const error = new Error('只支持 .xlsx 或 .xls 格式的Excel文件');
    error.status = 400;
    throw error;
  }

  let workbook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
  } catch (_) {
    const error = new Error('Excel文件解析失败，请检查文件格式');
    error.status = 400;
    throw error;
  }

  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) {
    const error = new Error('Excel文件没有可用工作表');
    error.status = 400;
    throw error;
  }
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headers = (matrix[0] || []).map(normalizeImportHeader).filter(Boolean);
  if (headers.length === 0) {
    const error = new Error('Excel文件缺少表头');
    error.status = 400;
    throw error;
  }
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length > 0) {
    const error = new Error(`Excel表头重复：${[...new Set(duplicateHeaders)].join('、')}`);
    error.status = 400;
    throw error;
  }

  const accepted = importType === 'price'
    ? {
        identifiers: ['商品编码', '商品代码', 'product_code', 'productCode', '厂商编码', 'manufacturer_code', 'manufacturerCode'],
        values: ['定价', '标准售价', '销售定价', 'standard_price', 'standardPrice', '零售价', '销售价', 'retail_price', 'retailPrice', '最低售价', '最低销售价', 'min_sale_price', 'minSalePrice']
      }
    : null;
  if (accepted && !headers.some(header => accepted.identifiers.includes(header))) {
    const error = new Error('定价模板缺少商品编码或厂商编码列');
    error.status = 400;
    throw error;
  }
  if (accepted && !headers.some(header => accepted.values.includes(header))) {
    const error = new Error('定价模板缺少定价、零售价或最低售价列');
    error.status = 400;
    throw error;
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows || rows.length === 0) {
    const error = new Error('文件中没有数据');
    error.status = 400;
    throw error;
  }
  return { workbook, sheetName, headers, rows };
}

function parseTaskErrors(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function importTaskData(task) {
  return {
    taskId: task.task_id,
    taskNo: task.task_no,
    importType: task.import_type,
    sourceFileName: task.source_file_name || '',
    status: task.status,
    totalRows: Number(task.total_rows || 0),
    processedRows: Number(task.processed_rows || 0),
    validRows: Number(task.valid_rows || 0),
    success: Number(task.success_rows || 0),
    failed: Number(task.failed_rows || 0),
    affectedProducts: Number(task.affected_products || 0),
    priceChanges: Number(task.price_changes || 0),
    pending: Number(task.pending_changes || 0),
    effective: Number(task.effective_changes || 0),
    batchNo: task.batch_no || '',
    errors: parseTaskErrors(task.error_json),
    errorMessage: task.error_message || '',
    createTime: task.create_time,
    startTime: task.start_time,
    finishTime: task.finish_time
  };
}

async function createProductImportTask(ctx, importType) {
  const parsed = parseImportWorkbook(ctx.file, importType);
  const task = await ProductImportTask.create({
    task_id: generateUUID(),
    task_no: generateId(importType === 'price' ? 'PIT' : 'PRT'),
    import_type: importType,
    source_file_name: ctx.file.originalname || '',
    file_data: ctx.file.buffer,
    total_rows: parsed.rows.length,
    status: 'queued',
    create_user: getUserName(ctx),
    create_time: new Date()
  });

  scheduleProductImportTask(task.task_id);
  ctx.status = 202;
  ctx.body = {
    code: 0,
    data: importTaskData(task),
    message: '文件格式校验通过，已提交后台导入，请查看任务状态'
  };
}

async function getProductImportTask(ctx) {
  const task = await ProductImportTask.findByPk(ctx.params.taskId);
  if (!task) ctx.throw(404, '导入任务不存在');
  ctx.body = { code: 0, data: importTaskData(task) };
}

async function parsePriceImportRows(ctx) {
  return parseImportWorkbook(ctx.file, 'price').rows;
}

async function findProductsForPriceImport(productCodes, manufacturerCodes) {
  const productsById = new Map();
  const loadProducts = async (where) => {
    const rows = await Product.findAll({
      where: { ...where, is_deleted: 0 },
      include: [{ model: ProductBarcode, attributes: ['barcode_type', 'barcode_code'], where: { status: 1 }, required: false }]
    });
    rows.forEach(product => productsById.set(product.product_id, product));
  };

  for (let i = 0; i < productCodes.length; i += 500) {
    await loadProducts({ product_code: { [Op.in]: productCodes.slice(i, i + 500) } });
  }

  const manufacturerProductIds = new Set();
  for (let i = 0; i < manufacturerCodes.length; i += 500) {
    const barcodeRows = await ProductBarcode.findAll({
      where: {
        barcode_type: 'manufacturer',
        barcode_code: { [Op.in]: manufacturerCodes.slice(i, i + 500) },
        status: 1
      },
      attributes: ['product_id'],
      raw: true
    });
    barcodeRows.forEach(row => manufacturerProductIds.add(row.product_id));
  }

  // 兼容历史数据中直接保存于商品 manufacturer_code 字段的厂商编码。
  for (let i = 0; i < manufacturerCodes.length; i += 100) {
    const codes = manufacturerCodes.slice(i, i + 100);
    if (codes.length === 0) continue;
    await loadProducts({
      [Op.or]: codes.map(code => ({ manufacturer_code: { [Op.like]: `%${code}%` } }))
    });
  }
  const manufacturerIds = [...manufacturerProductIds];
  for (let i = 0; i < manufacturerIds.length; i += 500) {
    await loadProducts({ product_id: { [Op.in]: manufacturerIds.slice(i, i + 500) } });
  }

  const allProducts = [...productsById.values()].filter(Boolean);
  const productByCode = new Map(allProducts.map(product => [String(product.product_code || '').trim(), product]));
  const productsByManufacturer = new Map();
  for (const code of manufacturerCodes) {
    productsByManufacturer.set(code, allProducts.filter(product => productHasManufacturerCode(product, code)));
  }
  return { productByCode, productsByManufacturer };
}

async function validatePriceImportRows(rows) {
  const errors = [];
  const targetRows = [];
  const parsedRows = rows.map((row, index) => {
    const productCode = String(getRowValue(row, ['商品编码', '商品代码', 'product_code', 'productCode']) || '').trim();
    const manufacturerCode = String(getRowValue(row, ['厂商编码', 'manufacturer_code', 'manufacturerCode']) || '').trim();
    const standardRaw = getRowValue(row, ['定价', '标准售价', '销售定价', 'standard_price', 'standardPrice']);
    const retailRaw = getRowValue(row, ['零售价', '销售价', 'retail_price', 'retailPrice']);
    const minRaw = getRowValue(row, ['最低售价', '最低销售价', 'min_sale_price', 'minSalePrice']);
    return {
      row,
      rowNo: index + 2,
      productCode,
      manufacturerCode,
      standardPrice: isEmptyCell(standardRaw) ? 0 : parseMoney(standardRaw),
      retailPrice: isEmptyCell(retailRaw) ? 0 : parseMoney(retailRaw),
      minSalePrice: isEmptyCell(minRaw) ? 0 : parseMoney(minRaw),
      changeReason: String(getRowValue(row, ['调价原因', '原因', 'change_reason', 'reason']) || '').trim(),
      remark: String(getRowValue(row, ['备注', 'remark']) || '').trim()
    };
  });
  const productCodes = [...new Set(parsedRows.map(item => item.productCode).filter(Boolean))];
  const manufacturerCodes = [...new Set(parsedRows.map(item => item.manufacturerCode).filter(Boolean))];
  const lookup = await findProductsForPriceImport(productCodes, manufacturerCodes);
  const candidates = [];

  for (const item of parsedRows) {
    if (!item.productCode && !item.manufacturerCode) {
      errors.push({ row: item.rowNo, product: item.row, message: '请填写商品编码或厂商编码' });
      continue;
    }
    if (item.standardPrice === null || item.retailPrice === null || item.minSalePrice === null) {
      errors.push({ row: item.rowNo, product: item.row, message: '价格格式错误' });
      continue;
    }
    if (item.standardPrice < 0 || item.retailPrice < 0 || item.minSalePrice < 0) {
      errors.push({ row: item.rowNo, product: item.row, message: '价格不能为负数' });
      continue;
    }

    let matchedProducts = [];
    if (item.productCode) {
      const product = lookup.productByCode.get(item.productCode);
      if (!product) {
        errors.push({ row: item.rowNo, product: item.row, message: `商品编码不存在: ${item.productCode}` });
        continue;
      }
      if (item.manufacturerCode && !productHasManufacturerCode(product, item.manufacturerCode)) {
        errors.push({ row: item.rowNo, product: item.row, message: '商品编码与厂商编码不匹配' });
        continue;
      }
      matchedProducts = [product];
    } else {
      matchedProducts = lookup.productsByManufacturer.get(item.manufacturerCode) || [];
      if (matchedProducts.length === 0) {
        errors.push({ row: item.rowNo, product: item.row, message: `厂商编码不存在或未关联商品: ${item.manufacturerCode}` });
        continue;
      }
    }
    matchedProducts.forEach(product => candidates.push({ ...item, product }));
  }

  const productIds = [...new Set(candidates.map(item => item.product.product_id))];
  const prices = productIds.length > 0
    ? await ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } } })
    : [];
  const priceByProductId = new Map(prices.map(price => [price.product_id, price]));
  for (const item of candidates) {
    const existingPrice = priceByProductId.get(item.product.product_id);
    const nextStandardPrice = moneyNumber(item.standardPrice);
    const nextRetailPrice = moneyNumber(item.retailPrice);
    const nextMinSalePrice = moneyNumber(item.minSalePrice);
    if (nextMinSalePrice > nextRetailPrice) {
      errors.push({ row: item.rowNo, product: item.row, message: `${item.product.product_code} 最低售价必须小于或等于零售价` });
      continue;
    }
    targetRows.push({
      rowNo: item.rowNo,
      row: item.row,
      product: item.product,
      manufacturerCode: item.manufacturerCode,
      hasStandardPrice: true,
      hasRetailPrice: true,
      hasMinSalePrice: true,
      standardPrice: nextStandardPrice,
      retailPrice: nextRetailPrice,
      minSalePrice: nextMinSalePrice,
      effectiveTime: new Date(),
      changeReason: item.changeReason,
      remark: item.remark,
      existingPrice
    });
  }

  const productRowMap = new Map();
  for (const item of targetRows) {
    const list = productRowMap.get(item.product.product_id) || [];
    list.push(item.rowNo);
    productRowMap.set(item.product.product_id, list);
  }
  const duplicatedProductIds = new Set();
  for (const [productId, rowNos] of productRowMap.entries()) {
    if (rowNos.length > 1) {
      duplicatedProductIds.add(productId);
      const item = targetRows.find(row => row.product.product_id === productId);
      errors.push({
        row: rowNos.join(','),
        product: item?.row || {},
        message: `${item?.product.product_code || productId} 在本批次被多行命中，请合并后再导入`
      });
    }
  }

  const validRows = targetRows.filter(item => !duplicatedProductIds.has(item.product.product_id));
  const validSourceRows = new Set(validRows.map(item => item.rowNo)).size;
  const errorSourceRows = new Set(errors.flatMap(item => String(item.row).split(',').map(v => v.trim()).filter(Boolean))).size;
  const priceChangeCount = validRows.reduce((sum, item) => {
    return sum + (item.hasStandardPrice ? 1 : 0) + (item.hasRetailPrice ? 1 : 0) + (item.hasMinSalePrice ? 1 : 0);
  }, 0);

  return {
    rows,
    validRows,
    errors,
    validSourceRows,
    errorSourceRows,
    affectedProducts: validRows.length,
    priceChangeCount
  };
}

async function validateImportPrices(ctx) {
  const rows = await parsePriceImportRows(ctx);
  await applyPendingProductPriceChanges();
  const validation = await validatePriceImportRows(rows);

  ctx.body = {
    code: 0,
    data: {
      success: validation.validSourceRows,
      failed: validation.errorSourceRows,
      errors: validation.errors,
      affectedProducts: validation.affectedProducts,
      priceChanges: validation.priceChangeCount,
      canImport: validation.validRows.length > 0
    },
    message: '价格导入校验完成'
  };
}

async function executePriceImportRows(rows, sourceFileName, userName) {
  const results = { success: 0, failed: 0, errors: [], affectedProducts: 0, pending: 0, effective: 0, batchNo: '', priceChanges: 0 };

  await applyPendingProductPriceChanges();
  const validation = await validatePriceImportRows(rows);
  const targetRows = validation.validRows;
  results.failed = validation.errorSourceRows;
  results.errors = validation.errors;

  if (targetRows.length === 0) {
    return results;
  }

  const now = new Date();
  const batchNo = generateId('PPI');
  const batchId = generateUUID();
  const transaction = await sequelize.transaction();

  try {
    let totalChanges = 0;
    let pendingCount = 0;
    let effectiveCount = 0;

    await ProductPriceImportBatch.create({
      batch_id: batchId,
      batch_no: batchNo,
      source_file_name: sourceFileName || '',
      total_rows: rows.length,
      total_products: targetRows.length,
      total_changes: 0,
      status: 'effective',
      create_user: userName,
      create_time: now
    }, { transaction });

    const immediatePriceRows = [];
    const changeLogs = [];
    for (const item of targetRows) {
      const isImmediate = item.effectiveTime.getTime() <= now.getTime();
      const price = item.existingPrice;
      const oldStandardPrice = moneyNumber(price?.standard_price);
      const oldRetailPrice = moneyNumber(price?.retail_price);
      const oldMinSalePrice = moneyNumber(price?.min_sale_price);

      if (isImmediate) {
        immediatePriceRows.push({
          price_id: price?.price_id || generateUUID(),
          product_id: item.product.product_id,
          cost_price: moneyNumber(price?.cost_price),
          standard_price: item.standardPrice,
          retail_price: item.retailPrice,
          min_sale_price: item.minSalePrice,
          effective_time: item.effectiveTime,
          create_user: userName
        });
      }
      const logBase = {
        batch_id: batchId,
        batch_no: batchNo,
        row_no: item.rowNo,
        product_id: item.product.product_id,
        product_code: item.product.product_code,
        product_name: item.product.name,
        manufacturer_code: item.manufacturerCode || item.product.manufacturer_code || '',
        effective_time: item.effectiveTime,
        source: 'import',
        change_reason: item.changeReason,
        remark: item.remark,
        status: isImmediate ? 'effective' : 'pending',
        create_user: userName,
        applied_time: isImmediate ? now : null
      };

      if (item.hasStandardPrice) {
        changeLogs.push({
          change_id: generateUUID(),
          ...logBase,
          price_field: 'standard_price',
          old_price: oldStandardPrice,
          new_price: item.standardPrice
        });
      }
      if (item.hasRetailPrice) {
        changeLogs.push({
          change_id: generateUUID(),
          ...logBase,
          price_field: 'retail_price',
          old_price: oldRetailPrice,
          new_price: item.retailPrice
        });
      }
      if (item.hasMinSalePrice) {
        changeLogs.push({
          change_id: generateUUID(),
          ...logBase,
          price_field: 'min_sale_price',
          old_price: oldMinSalePrice,
          new_price: item.minSalePrice
        });
      }
      const itemChangeCount = (item.hasStandardPrice ? 1 : 0) + (item.hasRetailPrice ? 1 : 0) + (item.hasMinSalePrice ? 1 : 0);
      totalChanges += itemChangeCount;
      if (isImmediate) effectiveCount += itemChangeCount;
      else pendingCount += itemChangeCount;
    }

    if (immediatePriceRows.length > 0) {
      await ProductPrice.bulkCreate(immediatePriceRows, {
        updateOnDuplicate: ['standard_price', 'retail_price', 'min_sale_price', 'effective_time', 'create_user'],
        transaction
      });
    }
    for (let i = 0; i < changeLogs.length; i += 1000) {
      await ProductPriceChangeLog.bulkCreate(changeLogs.slice(i, i + 1000), { transaction });
    }

    await ProductPriceImportBatch.update({
      total_changes: totalChanges,
      status: pendingCount > 0 ? 'pending' : 'effective'
    }, { where: { batch_id: batchId }, transaction });

    await transaction.commit();
    results.success = validation.validSourceRows;
    results.affectedProducts = targetRows.length;
    results.pending = pendingCount;
    results.effective = effectiveCount;
    results.batchNo = batchNo;
    results.priceChanges = totalChanges;
    return results;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function importPrices(ctx) {
  return createProductImportTask(ctx, 'price');
}

async function processProductImportTask(taskId) {
  const task = await ProductImportTask.findByPk(taskId);
  if (!task || IMPORT_TASK_TERMINAL_STATUSES.has(task.status)) return;

  await task.update({ status: 'processing', start_time: task.start_time || new Date(), error_message: null });
  try {
    const parsed = parseImportWorkbook({
      buffer: task.file_data,
      originalname: task.source_file_name
    }, task.import_type);

    const results = task.import_type === 'price'
      ? await executePriceImportRows(parsed.rows, task.source_file_name, task.create_user || 'system')
      : await executeProductImportRows(parsed.rows);
    const failed = Number(results.failed || 0);
    const success = Number(results.success || 0);
    const status = failed > 0 ? (success > 0 ? 'partial_failed' : 'failed') : 'completed';

    await task.update({
      status,
      processed_rows: parsed.rows.length,
      valid_rows: success,
      success_rows: success,
      failed_rows: failed,
      affected_products: Number(results.affectedProducts || success),
      price_changes: Number(results.priceChanges || 0),
      pending_changes: Number(results.pending || 0),
      effective_changes: Number(results.effective || 0),
      batch_no: results.batchNo || null,
      error_json: JSON.stringify(results.errors || []),
      error_message: failed > 0 ? (success > 0 ? '部分记录导入成功，失败记录请下载修改后重新导入' : '没有可导入的有效记录') : null,
      finish_time: new Date()
    });
  } catch (error) {
    await ProductImportTask.update({
      status: 'failed',
      error_message: String(error.message || error).slice(0, 1000),
      finish_time: new Date()
    }, { where: { task_id: taskId } });
    console.error(`[ProductImport] 后台任务失败 ${taskId}:`, error.stack || error.message);
  }
}

function scheduleProductImportTask(taskId) {
  if (!taskId || scheduledProductImportTasks.has(taskId)) return;
  scheduledProductImportTasks.add(taskId);
  setImmediate(() => processProductImportTask(taskId)
    .catch(error => console.error(`[ProductImport] 后台任务启动失败 ${taskId}:`, error.stack || error.message))
    .finally(() => scheduledProductImportTasks.delete(taskId)));
}

async function recoverProductImportTasks() {
  const tasks = await ProductImportTask.findAll({
    where: { status: { [Op.in]: ['queued', 'processing'] } },
    attributes: ['task_id'],
    order: [['create_time', 'ASC']]
  });
  tasks.forEach(task => scheduleProductImportTask(task.task_id));
  if (tasks.length > 0) {
    console.log(`[ProductImport] 已恢复 ${tasks.length} 个商品/定价导入任务`);
  }
  return tasks.length;
}

async function getPriceChangeHistory(ctx) {
  await applyPendingProductPriceChanges();

  const { productId, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (productId) where.product_id = productId;

  const { count, rows } = await ProductPriceChangeLog.findAndCountAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'ProductPriceChangeLog.status',
      pendingStatuses: ['pending'],
      dateColumns: ['ProductPriceChangeLog.effective_time', 'ProductPriceChangeLog.create_time'],
      idColumn: 'ProductPriceChangeLog.change_id'
    }),
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) })
  });

  const list = rows.map(row => ({
    change_id: row.change_id,
    batch_no: row.batch_no || '',
    row_no: row.row_no,
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name,
    manufacturer_code: row.manufacturer_code || '',
    price_field: row.price_field,
    price_field_label: priceFieldLabel(row.price_field),
    old_price: row.old_price,
    new_price: row.new_price,
    effective_time: row.effective_time,
    source: row.source,
    source_label: row.source === 'manual' ? '手工修改' : '批量导入',
    change_reason: row.change_reason || '',
    remark: row.remark || '',
    status: row.status,
    status_label: row.status === 'pending' ? '待生效' : (row.status === 'failed' ? '已失败' : '已生效'),
    create_user: row.create_user,
    create_time: row.create_time,
    applied_time: row.applied_time,
    fail_reason: row.fail_reason || ''
  }));

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function importCostRefresh(ctx) {
  if (!ctx.file) {
    ctx.throw(400, '请上传文件');
  }

  const workbook = XLSX.read(ctx.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const results = { success: 0, failed: 0, errors: [] };

  for (const [index, row] of rows.entries()) {
    try {
      const productCode = String(getRowValue(row, ['商品编码', '商品代码', 'product_code', 'productCode']) || '').trim();
      const productName = String(getRowValue(row, ['商品名称', 'name']) || '').trim();

      if (!productCode && !productName) {
        results.failed++;
        results.errors.push({ row: index + 2, product: row, message: '请填写商品编码或商品名称' });
        continue;
      }

      const productWhere = { is_deleted: 0 };
      if (productCode) productWhere.product_code = productCode;
      else productWhere.name = productName;

      const product = await Product.findOne({ where: productWhere });
      if (!product) {
        results.failed++;
        results.errors.push({ row: index + 2, product: row, message: '商品不存在' });
        continue;
      }

      const costPrice = await calculateFifoCost(product.product_id);
      const existingPrice = await ProductPrice.findOne({ where: { product_id: product.product_id } });

      if (existingPrice) {
        await existingPrice.update({
          cost_price: costPrice,
          ...(Number(existingPrice.standard_price || 0) <= 0 && costPrice > 0 ? { standard_price: costPrice } : {})
        });
      } else {
        await ProductPrice.create({
          price_id: generateUUID(),
          product_id: product.product_id,
          cost_price: costPrice,
          standard_price: costPrice,
          min_sale_price: 0
        });
      }

      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({ row: index + 2, product: row, message: error.message || '成本刷新失败' });
    }
  }

  ctx.body = { code: 0, data: results, message: '成本批量刷新完成' };
}

async function getPnList(ctx) {
  const { productId, keyword, storeId, page = 1, pageSize = 20 } = ctx.query;

  // 调拨出库需要读取调出门店的 PN，不应再次套用账号的普通门店查询权限。
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
    include: [{
      model: Product,
      attributes: ['product_id', 'name', 'product_code', 'category', 'config', 'brand', 'series', 'model', 'need_sn'],
      include: [{ model: ProductPrice, attributes: ['standard_price', 'retail_price', 'min_sale_price'] }]
    }],
    order: [['pn_code', 'ASC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) })
  });

  const productIds = rows.map(row => row.product_id).filter(Boolean);
  const stockMap = await buildSalesStockMap(productIds, storeId);
  const salesMap = await buildSalesCountMap(productIds);
  const list = rows.map(row => {
    const data = row.toJSON();
    const product = data.Product || {};
    const price = product.ProductPrice || {};
    const stock = stockMap[data.product_id] || { current: 0, other: 0, total: 0 };
    const sales = salesMap[data.product_id] || { sales_7_qty: 0, sales_30_qty: 0 };
    return {
      ...data,
      product_name: product.name || data.product_name || '',
      name: product.name || data.product_name || '',
      product_code: product.product_code || '',
      category: product.category || '',
      config: product.config || '',
      spec: product.config || '',
      brand: product.brand || '',
      series: product.series || '',
      model: product.model || '',
      need_sn: product.need_sn || 0,
      standard_price: price.standard_price || 0,
      retail_price: price.retail_price || 0,
      min_sale_price: price.min_sale_price || 0,
      settlement_price: price.retail_price || price.standard_price || 0,
      current_store_stock_qty: stock.current,
      other_store_stock_qty: stock.other,
      total_stock_qty: stock.total,
      current_store_name: stock.currentStore?.store_name || '',
      store_stock_info: stock.stores || [],
      other_store_stock_info: stock.otherStores || [],
      sales_7_qty: sales.sales_7_qty,
      sales_30_qty: sales.sales_30_qty,
      stock_qty: storeId ? stock.current : stock.total,
      stock_rank: stock.current > 0 ? 0 : (stock.total > 0 ? 1 : 2)
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function addPn(ctx) {
  const { productId, pnCode, barcode, isPrimary } = ctx.request.body;

  if (!productId || !pnCode) {
    ctx.throw(400, '商品ID和PN码不能为空');
  }

  const cleanedPnCode = String(pnCode).trim();
  if (!isUsablePnCode(cleanedPnCode)) ctx.throw(400, 'PN码不能为空或不能使用占位值');
  const product = await Product.findByPk(productId);
  if (!product) ctx.throw(404, '商品不存在');

  const transaction = await sequelize.transaction();
  let pnId = null;
  try {
    const rows = await ensureProductPns(productId, [cleanedPnCode], transaction);
    const pnRecord = rows[0];
    pnId = pnRecord?.pn_id || null;
    if (barcode !== undefined && pnRecord) {
      await pnRecord.update({ barcode: String(barcode || '').trim(), is_primary: isPrimary ? 1 : pnRecord.is_primary }, { transaction });
    }
    await product.update({ manufacturer_code: appendCode(product.manufacturer_code, cleanedPnCode) }, { transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    if (error.status === 409) ctx.throw(400, error.message);
    throw error;
  }

  ctx.body = { code: 0, pnId, message: 'PN添加成功' };
}

async function searchProduct(ctx) {
  const { keyword, storeId, page = 1, pageSize = 10 } = ctx.query;
  const pageNum = parseInt(page);
  const sizeNum = parseInt(pageSize);

  if (!keyword || keyword.trim() === '') {
    ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
    return;
  }

  const kw = keyword.trim();

  const barcodeRecords = await ProductBarcode.findAll({
    where: {
      barcode_code: { [Op.like]: `%${kw}%` },
      status: 1
    },
    attributes: ['product_id'],
    raw: true
  });

  const productIdsFromBarcode = [...new Set(barcodeRecords.map(b => b.product_id))];

  const pnMatches = await ProductPn.findAll({
    where: {
      pn_code: { [Op.like]: `%${kw}%` },
      is_deleted: 0
    },
    attributes: ['product_id'],
    raw: true
  });
  const productIdsFromPn = [...new Set(pnMatches.map(row => row.product_id))];

  const snRecords = await ProductSn.findAll({
    where: {
      [Op.or]: [
        { pn_code: { [Op.like]: `%${kw}%` } },
        { sn_code: { [Op.like]: `%${kw}%` } }
      ],
      is_deleted: 0,
      status: 'in_stock'
    },
    attributes: ['product_id', 'pn_code'],
    raw: true
  });

  const productIdsFromSn = [...new Set(snRecords.map(s => s.product_id))];
  const snPnsByProduct = {};
  for (const s of snRecords) {
    if (!snPnsByProduct[s.product_id]) snPnsByProduct[s.product_id] = new Set();
    if (s.pn_code) snPnsByProduct[s.product_id].add(s.pn_code);
  }

  const where = { is_deleted: 0, status: 1 };
  const orConditions = [
    { name: { [Op.like]: `%${kw}%` } },
    { product_code: { [Op.like]: `%${kw}%` } },
    { manufacturer_code: { [Op.like]: `%${kw}%` } }
  ];

  if (productIdsFromBarcode.length > 0) {
    orConditions.push({ product_id: { [Op.in]: productIdsFromBarcode } });
  }
  if (productIdsFromPn.length > 0) {
    orConditions.push({ product_id: { [Op.in]: productIdsFromPn } });
  }
  if (productIdsFromSn.length > 0) {
    orConditions.push({ product_id: { [Op.in]: productIdsFromSn } });
  }

  where[Op.or] = orConditions;

  const rows = await Product.findAll({
    where,
    attributes: ['product_id', 'product_code', 'name', 'category', 'config', 'brand', 'series', 'model', 'manufacturer_code', 'need_sn', 'unit'],
    include: [
      { model: ProductPrice, attributes: ['standard_price', 'retail_price', 'min_sale_price'] }
    ],
    order: [['product_code', 'DESC']],
  });
  const count = rows.length;

  const productIds = rows.map(p => p.product_id);
  const pnRecords = productIds.length > 0
    ? await ProductPn.findAll({
        where: { product_id: { [Op.in]: productIds }, is_deleted: 0 },
        attributes: ['product_id', 'pn_code', 'is_primary'],
        order: [['is_primary', 'DESC'], ['pn_code', 'ASC']],
        raw: true
      })
    : [];
  const productPnMap = {};
  for (const pn of pnRecords) {
    if (!productPnMap[pn.product_id]) productPnMap[pn.product_id] = [];
    if (pn.pn_code && !productPnMap[pn.product_id].includes(pn.pn_code)) {
      productPnMap[pn.product_id].push(pn.pn_code);
    }
  }

  const inventoryMap = await buildSalesStockMap(productIds, storeId);
  const salesMap = await buildSalesCountMap(productIds);

  const splitPnCodes = (value) => String(value || '').split(new RegExp('[,\\s\\uFF0C\\u3001]+')).map(v => v.trim()).filter(Boolean);

  const list = rows
    .map(p => {
      const stock = inventoryMap[p.product_id] || { current: 0, other: 0, total: 0 };
      const sales = salesMap[p.product_id] || { sales_7_qty: 0, sales_30_qty: 0 };
      const stockRank = stock.current > 0 ? 0 : (stock.other > 0 ? 1 : 2);
      const pnList = [
        ...(productPnMap[p.product_id] || []),
        ...splitPnCodes(p.manufacturer_code),
        ...(p.need_sn === 1 ? [...(snPnsByProduct[p.product_id] || [])] : [])
      ];
      const uniquePnList = [...new Set(pnList)];
      return {
        product_id: p.product_id,
        product_code: p.product_code,
        name: p.name,
        spec: p.config || '',
        config: p.config || '',
        brand: p.brand || '',
        series: p.series || '',
        model: p.model || '',
        category: p.category || '',
        standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
        retail_price: p.ProductPrice ? p.ProductPrice.retail_price : 0,
        min_sale_price: p.ProductPrice ? p.ProductPrice.min_sale_price : 0,
        settlement_price: p.ProductPrice ? (p.ProductPrice.retail_price || p.ProductPrice.standard_price || 0) : 0,
        need_sn: p.need_sn,
        unit: p.unit,
        stock_qty: storeId ? stock.current : stock.total,
        current_store_stock_qty: stock.current,
        other_store_stock_qty: stock.other,
        total_stock_qty: stock.total,
        current_store_name: stock.currentStore?.store_name || '',
        store_stock_info: stock.stores || [],
        other_store_stock_info: stock.otherStores || [],
        sales_7_qty: sales.sales_7_qty,
        sales_30_qty: sales.sales_30_qty,
        stock_rank: stockRank,
        pn: uniquePnList[0] || '',
        pn_list: uniquePnList
      };
    })
    .sort((a, b) => {
      if (a.stock_rank !== b.stock_rank) return a.stock_rank - b.stock_rank;
      if (a.stock_rank === 0 && b.current_store_stock_qty !== a.current_store_stock_qty) {
        return b.current_store_stock_qty - a.current_store_stock_qty;
      }
      if (a.stock_rank === 1 && b.other_store_stock_qty !== a.other_store_stock_qty) {
        return b.other_store_stock_qty - a.other_store_stock_qty;
      }
      return String(b.product_code || '').localeCompare(String(a.product_code || ''));
    });

  const offset = (pageNum - 1) * sizeNum;
  const pagedList = list.slice(offset, offset + sizeNum);
  ctx.body = formatPaginatedResult(pagedList, { page: pageNum, pageSize: sizeNum, count });
}

// ==================== 分类字段配置 ====================

// 获取某个分类的字段配置
async function getCategoryFields(ctx) {
  const { categoryId } = ctx.query;
  if (!categoryId) ctx.throw(400, '请指定分类');

  const fields = await ProductCategoryField.findAll({
    where: { category_id: categoryId, status: 1 },
    order: [['sort_order', 'ASC']],
    raw: true
  });

  ctx.body = { code: 0, data: fields };
}

// 批量保存分类字段配置
async function saveCategoryFields(ctx) {
  const { categoryId, fields } = ctx.request.body;
  if (!categoryId) ctx.throw(400, '请指定分类');
  if (!Array.isArray(fields)) ctx.throw(400, '字段配置格式错误');

  await ProductCategoryField.destroy({ where: { category_id: categoryId } });

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f.field_label || !f.field_key) continue;
    await ProductCategoryField.create({
      field_id: generateUUID(),
      category_id: categoryId,
      field_label: f.field_label,
      field_key: f.field_key,
      field_type: f.field_type || 'text',
      field_options: f.field_type === 'select' ? JSON.stringify(f.options || []) : null,
      field_placeholder: f.placeholder || null,
      sort_order: f.sort_order != null ? f.sort_order : i,
      required: f.required ? 1 : 0,
      status: 1
    });
  }

  ctx.body = { code: 0, message: '保存成功' };
}

// 获取分类字段配置（前端新建商品时调用，返回包含 options 的完整配置）
async function getCategoryFieldConfig(ctx) {
  const { categoryId } = ctx.query;
  if (!categoryId) ctx.throw(400, '请指定分类');

  const fields = await ProductCategoryField.findAll({
    where: { category_id: categoryId, status: 1 },
    order: [['sort_order', 'ASC']],
    raw: true
  });

  const result = fields.map(f => ({
    field_label: f.field_label,
    field_key: f.field_key,
    field_type: f.field_type,
    options: f.field_options ? JSON.parse(f.field_options) : [],
    placeholder: f.field_placeholder || '',
    required: f.required === 1
  }));

  const category = await ProductCategory.findByPk(categoryId, { raw: true });

  ctx.body = { code: 0, data: { fields: result, categoryName: category ? category.name : '' } };
}

async function executeProductImportRows(rows) {
  // 缓存分类→字段映射，避免每行重复查询
  const catFieldCache = {};

  const results = { success: 0, failed: 0, errors: [] };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    try {
      // 调试: 打印前3行的原始数据
      if (rowIndex < 3) {
        console.log(`[导入调试] 第 ${rowIndex+1} 行原始数据:`, JSON.stringify(row));
      }

      const categoryPath = row['商品分类'] || row['分类'] || row['category'] || '';

      // 查找分类
      let categoryId = null;
      if (categoryPath) {
        categoryId = await findCategoryByName(categoryPath);
      }

      // 直接映射 Excel 列到独立字段
      const attrMap = {};
      for (const key of Object.keys(row)) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
          attrMap[String(key).trim()] = String(row[key]).trim();
        }
      }

      // 调试: 打印前3行的 attrMap
      if (rowIndex < 3) {
        console.log(`[导入调试] 第 ${rowIndex+1} 行 attrMap:`, attrMap);
      }

      const { cols, extras } = splitAttributes(attrMap);

      // 自动拼装名称 - 先使用标准字段，再使用分类补充字段
      const autoNameParts = [];
      
      // 1. 优先使用标准字段
      const standardFieldLabels = {
        brand: '品牌', series: '系列', model: '型号',
        processor: '处理器', memory: '内存', storage: '存储',
        color: '颜色', gpu: '显卡', accessory_type: '配件类别'
      };
      for (const [col, label] of Object.entries(standardFieldLabels)) {
        const val = attrMap[label] || attrMap[col];
        if (val) autoNameParts.push(val);
      }
      
      // 2. 如果有分类，再使用分类补充字段（避免与标准字段重复）
      if (categoryId) {
        // 缓存分类字段
        if (!catFieldCache[categoryId]) {
          const catFields = await ProductCategoryField.findAll({
            where: { category_id: categoryId, status: 1 },
            order: [['sort_order', 'ASC'], ['field_id', 'ASC']],
            raw: true
          });
          catFieldCache[categoryId] = catFields;
        }
        const fields = catFieldCache[categoryId];
        for (const f of fields) {
          // 避免重复添加标准字段
          if (['brand','series','model','processor','memory','storage','color','gpu','accessory_type'].includes(f.field_key)) {
            continue;
          }
          const val = attrMap[f.field_label] || attrMap[f.field_key];
          if (val) autoNameParts.push(val);
        }
      }
      const autoName = autoNameParts.join(' ');

      // 调试: 打印前3行的名称信息
      if (rowIndex < 3) {
        console.log(`[导入调试] 第 ${rowIndex+1} 行 autoNameParts:`, autoNameParts);
        console.log(`[导入调试] 第 ${rowIndex+1} 行 autoName:`, autoName);
        console.log(`[导入调试] 第 ${rowIndex+1} 行 商品名称列:`, attrMap['商品名称'] || attrMap['name']);
      }

      // 名称优先级: Excel商品名称 > 自动拼装
      let finalName = attrMap['商品名称'] || attrMap['name'] || '';
      if (!finalName && autoName) finalName = autoName;
      
      // 调试: 如果名称为空，打印原因
      if (!finalName && rowIndex < 10) {
        console.log(`[导入调试] 第 ${rowIndex+1} 行名称为空! cols:`, cols);
      }
      
      if (!finalName) {
        results.failed++;
        results.errors.push({ row: rowIndex + 2, product: row, message: '商品名称不能为空（请填写"商品名称"列或确保分类字段能拼装出名称）' });
        continue;
      }

      // 基于厂商编码查找是否已存在商品
      const manufacturerCodes = attrMap['厂商编码'] || '';
      let product = null;
      let productId = null;

      if (manufacturerCodes) {
        const primaryManufacturerCode = splitPnCodes(manufacturerCodes)[0];
        if (primaryManufacturerCode) {
          const existingBarcodes = await ProductBarcode.findAll({
            where: {
              [Op.and]: [
                { barcode_type: 'manufacturer', status: 1 },
                sequelize.where(
                  sequelize.fn('LOWER', sequelize.fn('REPLACE', sequelize.fn('TRIM', sequelize.col('barcode_code')), ' ', '')),
                  normalizePnCode(primaryManufacturerCode)
                )
              ]
            },
            include: [{
              model: Product,
              attributes: [],
              where: { status: 1, is_deleted: 0 },
              required: true
            }],
            raw: true
          });
          const existingProductIds = [...new Set(existingBarcodes.map(row => row.product_id).filter(Boolean))];
          if (existingProductIds.length > 1) {
            throw new Error(`厂商PN [${primaryManufacturerCode}] 已关联多个商品，无法自动匹配，请先清理重复主数据`);
          }
          if (existingProductIds.length === 1) {
            product = await Product.findByPk(existingProductIds[0]);
            productId = existingProductIds[0];
          }
        }
      }

      // 使用事务确保数据一致性
      const transaction = await sequelize.transaction();
      try {
        // 准备更新/新增数据
        const productData = {
          name: finalName,
          category: categoryPath || '',
          manufacturer_code: splitPnCodes(manufacturerCodes).join(', '),
          config: attrMap['厂商商品名称'] || attrMap['产品配置'] || attrMap['config'] || '',
          brand: cols.brand || null,
          series: cols.series || null,
          model: cols.model || null,
          processor: cols.processor || null,
          memory: cols.memory || null,
          storage: cols.storage || null,
          color: cols.color || null,
          gpu: cols.gpu || null,
          accessory_type: cols.accessory_type || null,
          extras: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
          need_sn: attrMap['需要SN码'] === '是' || attrMap['needSn'] === '是' ? 1 : 0,
          unit: attrMap['单位'] || attrMap['unit'] || '台',
          remark: attrMap['详细配置'] || attrMap['备注'] || attrMap['remark'] || '',
          status: (attrMap['状态'] === '启用' || attrMap['status'] === '启用') ? 1 : 1
        };

        if (product) {
          // 存在则更新
          await product.update(productData, { transaction });
          productId = product.product_id;
        } else {
          // 不存在则新增
          const productCode = await generateProductCode(Product);
          productId = generateUUID();
          productData.product_id = productId;
          productData.product_code = productCode;
          productData.create_time = new Date();
          productData.need_imei = 0;
          await Product.create(productData, { transaction });
        }

        // 先禁用旧的条码(无论是更新还是新增，都要清理旧条码)
        await ProductBarcode.update({ status: 0 }, { where: { product_id: productId }, transaction });

        // 导入厂商编码
        if (manufacturerCodes) {
          const codes = splitPnCodes(manufacturerCodes);
          for (const code of codes) {
            await ProductBarcode.create({
              barcode_id: generateUUID(), product_id: productId,
              barcode_type: 'manufacturer', barcode_code: code.trim(),
              sort_order: 0, status: 1
            }, { transaction });
          }
        }

        // 导入69码
        const barcode69List = attrMap['69码'] || '';
        if (barcode69List) {
          const codes = String(barcode69List).split(/[,;，；\s]+/).map(code => code.trim()).filter(Boolean);
          for (const code of codes) {
            await ProductBarcode.create({
              barcode_id: generateUUID(), product_id: productId,
              barcode_type: 'barcode69', barcode_code: code.trim(),
              sort_order: 0, status: 1
            }, { transaction });
          }
        }

        await ensureProductPns(productId, manufacturerCodes, transaction);

        // 提交事务
        await transaction.commit();

        results.success++;
        
        // 打印调试日志
        console.log(`[导入成功] 第 ${rowIndex+1} 行: ${finalName} (productId: ${productId})`);
      } catch (txError) {
        // 回滚事务
        await transaction.rollback();
        throw txError;
      }
    } catch (error) {
      results.failed++;
      let errorMessage = error.message || '导入失败';
      if (error.name === 'SequelizeUniqueConstraintError') {
        errorMessage = '商品编码已存在';
      } else if (error.parent) {
        errorMessage = '数据库错误: ' + (error.parent.sqlMessage || error.parent.message);
      }
      // 打印详细错误日志
      console.error(`[导入失败] 第 ${rowIndex+1} 行:`, error);
      results.errors.push({ row: rowIndex + 2, product: row, message: errorMessage });
    }
  }

  return results;
}

async function importProducts(ctx) {
  return createProductImportTask(ctx, 'product');
}

/**
 * 批量导出商品
 * @param {Object} ctx - Koa上下文
 */
async function exportProducts(ctx) {
  const { keyword, categoryId } = ctx.query;

  // 构建查询条件（复用getProductList的逻辑）
  const where = { is_deleted: 0 };
  if (categoryId) {
    const path = await resolveCategoryPath(categoryId);
    if (path) where.category = { [Op.like]: `${path}%` };
  }

  if (keyword) {
    const keywords = keyword.trim().split(/\s+/).filter(k => k);
    
    // 1. 先查找匹配条码的商品ID
    const matchedProductIdsByBarcode = new Set();
    const barcodeMatches = await ProductBarcode.findAll({
      where: {
        status: 1,
        [Op.or]: keywords.map(k => ({
          barcode_code: { [Op.like]: `%${k}%` }
        }))
      },
      attributes: ['product_id'],
      raw: true
    });
    barcodeMatches.forEach(b => matchedProductIdsByBarcode.add(b.product_id));

    // 2. 构建商品字段查询条件（每个关键字都要匹配）
    const productFieldConditions = [];
    for (const k of keywords) {
      productFieldConditions.push({
        [Op.or]: [
          { name: { [Op.like]: `%${k}%` } },
          { product_code: { [Op.like]: `%${k}%` } },
          { config: { [Op.like]: `%${k}%` } },
          { brand: { [Op.like]: `%${k}%` } },
          { series: { [Op.like]: `%${k}%` } },
          { model: { [Op.like]: `%${k}%` } },
          { processor: { [Op.like]: `%${k}%` } },
          { memory: { [Op.like]: `%${k}%` } },
          { storage: { [Op.like]: `%${k}%` } },
          { color: { [Op.like]: `%${k}%` } },
          { gpu: { [Op.like]: `%${k}%` } },
          { accessory_type: { [Op.like]: `%${k}%` } }
        ]
      });
    }

    // 3. 合并查询条件：商品字段匹配 OR 条码匹配
    if (matchedProductIdsByBarcode.size > 0) {
      if (productFieldConditions.length > 0) {
        where[Op.or] = [
          { product_id: { [Op.in]: Array.from(matchedProductIdsByBarcode) } },
          { [Op.and]: productFieldConditions }
        ];
      } else {
        where.product_id = { [Op.in]: Array.from(matchedProductIdsByBarcode) };
      }
    } else if (productFieldConditions.length > 0) {
      where[Op.and] = productFieldConditions;
    }
  }

  // 查询所有匹配的商品（不分页）
  const products = await Product.findAll({
    where,
    include: [
      { model: ProductBarcode, attributes: ['barcode_id', 'barcode_type', 'barcode_code'], where: { status: 1 }, required: false }
    ],
    order: [['create_time', 'DESC']]
  });

  // 构建导出数据
  const exportData = products.map(p => {
    const allBarcodes = (p.ProductBarcodes || []);
    const manufacturerCodes = allBarcodes.filter(b => b.barcode_type === 'manufacturer').map(b => b.barcode_code).join(',');
    const barcode69List = allBarcodes.filter(b => b.barcode_type === 'barcode69').map(b => b.barcode_code).join(',');
    const { cols: mappedExtras } = splitAttributes(parseProductExtras(p.extras));

    return {
      '商品编码': p.product_code,
      '商品名称': p.name,
      '商品分类': p.category || '',
      '品牌': getProductAttributeValue(p, 'brand', mappedExtras),
      '系列': getProductAttributeValue(p, 'series', mappedExtras),
      '型号': getProductAttributeValue(p, 'model', mappedExtras),
      '处理器': getProductAttributeValue(p, 'processor', mappedExtras),
      '内存': getProductAttributeValue(p, 'memory', mappedExtras),
      '存储': getProductAttributeValue(p, 'storage', mappedExtras),
      '颜色': getProductAttributeValue(p, 'color', mappedExtras),
      '显卡': getProductAttributeValue(p, 'gpu', mappedExtras),
      '配件类别': getProductAttributeValue(p, 'accessory_type', mappedExtras),
      '厂商商品名称': p.config || '',
      '单位': p.unit || '台',
      '需要SN码': p.need_sn === 1 ? '是' : '否',
      '厂商编码': manufacturerCodes,
      '69码': barcode69List,
      '详细配置': p.remark || '',
      '状态': p.status === 1 ? '启用' : '停用',
      '创建时间': p.create_time ? p.create_time.toISOString().slice(0, 19).replace('T', ' ') : ''
    };
  });

  // 生成Excel文件
  const worksheet = XLSX.utils.json_to_sheet(exportData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '商品');
  
  // 设置列宽
  worksheet['!cols'] = [
    { wch: 15 }, { wch: 25 }, { wch: 20 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
    { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 8 }, { wch: 10 },
    { wch: 20 }, { wch: 20 }, { wch: 25 }, { wch: 10 }, { wch: 20 }
  ];

  // 输出Excel
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `商品导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
  ctx.set('Content-Disposition', `attachment; filename="products.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.body = buffer;
}

module.exports = {
  getProductList, createProduct, submitProductApplication, getProductApplicationList, reviewProductApplication,
  updateProduct, deleteProduct, batchDeleteProducts, togglePause, importProducts, exportProducts,
  getCategoryFields, saveCategoryFields, getCategoryFieldConfig,
  getBarcodes: async (ctx) => {
    const { productId } = ctx.query;
    const where = { status: 1 };
    if (productId) where.product_id = productId;
    const rows = await ProductBarcode.findAll({ where, order: [['barcode_type', 'ASC'], ['sort_order', 'ASC']] });
    ctx.body = { code: 0, data: rows };
  },
  addBarcode: async (ctx) => {
    const { productId, barcodeType, barcodeCode } = ctx.request.body;
    if (!productId || !barcodeType || !barcodeCode) ctx.throw(400, '参数不全');
    const transaction = await sequelize.transaction();
    const id = generateUUID();
    try {
      await ProductBarcode.create({ barcode_id: id, product_id: productId, barcode_type: barcodeType, barcode_code: String(barcodeCode).trim(), sort_order: 0, status: 1 }, { transaction });
      if (barcodeType === 'manufacturer') {
        await ensureProductPns(productId, [barcodeCode], transaction);
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    ctx.body = { code: 0, barcodeId: id, message: '添加成功' };
  },
  deleteBarcode: async (ctx) => {
    const bc = await ProductBarcode.findByPk(ctx.params.barcodeId);
    if (!bc) ctx.throw(404, '条码不存在');
    await bc.update({ status: 0 });
    ctx.body = { code: 0, message: '删除成功' };
  },
  getCategoryTree, createCategory, updateCategory, deleteCategory, sortCategories,
  getPriceList, setPrice, refreshCostPrice, batchRefreshCost, validateImportPrices, importPrices, importCostRefresh, getPriceChangeHistory, applyPendingProductPriceChanges,
  getProductImportTask, recoverProductImportTasks,
  getPnList, addPn, searchProduct,
  _test: { parseImportWorkbook, importTaskData, normalizePnCode, splitPnCodes, ensureProductPns }
};
