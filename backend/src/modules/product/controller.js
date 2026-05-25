/**
 * 商品管理控制器
 * 基础信息 / 分类管理 / 条码管理 / 价格管理
 */
const { Product, ProductPn, ProductSn, ProductBarcode, ProductCategory, ProductCategoryField, ProductPrice, Inventory } = require('../../models');
const { Op, Sequelize } = require('sequelize');
const { sequelize } = require('../../config/database');
const { generateProductCode, generateUUID, paginate, formatPaginatedResult } = require('../../utils');
const XLSX = require('xlsx');

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
    const col = FIELD_TO_COLUMN[k];
    if (col) {
      cols[col] = v;
    } else {
      extras[k] = v;
    }
  }
  return { cols, extras };
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
    order: [['create_time', 'DESC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) }),
    distinct: true
  });

  const list = rows.map(p => {
    const allBarcodes = (p.ProductBarcodes || []).map(b => ({ barcode_id: b.barcode_id, type: b.barcode_type, code: b.barcode_code }));
    const extras = p.extras ? (typeof p.extras === 'string' ? JSON.parse(p.extras) : p.extras) : {};
    return {
      product_id: p.product_id,
      product_code: p.product_code,
      name: p.name,
      config: p.config || '',
      category: p.category || '',
      brand: p.brand || '',
      series: p.series || '',
      model: p.model || '',
      processor: p.processor || '',
      memory: p.memory || '',
      storage: p.storage || '',
      color: p.color || '',
      gpu: p.gpu || '',
      accessory_type: p.accessory_type || '',
      extras,
      manufacturer_codes: allBarcodes.filter(b => b.type === 'manufacturer').map(b => b.code),
      barcodes: allBarcodes,
      create_time: p.create_time || '',
      status: p.status
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function createProduct(ctx) {
  const { name, categoryId, config, needSn, needImei, unit, remark, barcodes, attributes, status = 1 } = ctx.request.body;

  const productId = generateUUID();
  const categoryPath = categoryId ? await resolveCategoryPath(categoryId) : '';

  let parsedAttrs = attributes;
  if (typeof attributes === 'string') {
    try { parsedAttrs = JSON.parse(attributes); } catch { parsedAttrs = {}; }
  }

  const { cols, extras } = splitAttributes(parsedAttrs);

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
  if (!finalName) {
    ctx.throw(400, '商品名称不能为空');
  }

  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    const productCode = await generateProductCode(Product);
    try {
      await Product.create({
        product_id: productId,
        product_code: productCode,
        name: finalName,
        category: categoryPath,
        config: config || '',
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
        create_time: new Date(),
        status
      });

      // 创建条码
      if (barcodes && Array.isArray(barcodes)) {
        for (const bc of barcodes) {
          if (bc.code) {
            await ProductBarcode.create({
              barcode_id: generateUUID(),
              product_id: productId,
              barcode_type: bc.type || 'manufacturer',
              barcode_code: bc.code,
              sort_order: 0,
              status: 1
            });

            if ((bc.type || 'manufacturer') === 'manufacturer') {
              const existingPn = await ProductPn.findOne({
                where: { pn_code: bc.code, is_deleted: 0 }
              });
              if (!existingPn) {
                await ProductPn.create({
                  pn_id: generateUUID(),
                  product_id: productId,
                  pn_code: bc.code,
                  barcode: bc.code,
                  is_primary: 0,
                  status: 1,
                  is_deleted: 0
                });
              }
            }
          }
        }
      }

      ctx.body = { code: 0, productId, productCode, message: '商品创建成功' };
      return;
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  ctx.throw(409, '商品编码生成冲突，请重试');
}

async function updateProduct(ctx) {
  const { productId } = ctx.params;
  const body = ctx.request.body;
  const { name, categoryId, config, needSn, needImei, unit, remark, barcodes, status, attributes } = body;

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

  await product.update(updateData);

  // 条码：删除旧的全部，重新创建
  if (barcodes !== undefined) {
    await ProductBarcode.update({ status: 0 }, { where: { product_id: productId } });
    if (Array.isArray(barcodes)) {
      for (const bc of barcodes) {
        if (bc.code) {
          await ProductBarcode.create({
            barcode_id: generateUUID(),
            product_id: productId,
            barcode_type: bc.type || 'manufacturer',
            barcode_code: bc.code,
            sort_order: 0,
            status: 1
          });

          if ((bc.type || 'manufacturer') === 'manufacturer') {
            const [pnRecord] = await ProductPn.findOrCreate({
              where: { pn_code: bc.code, is_deleted: 0 },
              defaults: {
                pn_id: generateUUID(),
                product_id: productId,
                pn_code: bc.code,
                barcode: bc.code,
                is_primary: 0,
                status: 1,
                is_deleted: 0
              }
            });
            if (pnRecord.product_id !== productId) {
              await pnRecord.update({ product_id: productId });
            }
          }
        }
      }
    }
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

// ===== 商品价格管理 =====

async function getPriceList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;

  const productWhere = { is_deleted: 0 };
  if (keyword) {
    productWhere[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { product_code: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Product.findAndCountAll({
    where: productWhere,
    attributes: ['product_id', 'product_code', 'name', 'unit', 'category'],
    include: [
      { model: ProductPrice, attributes: ['price_id', 'standard_price', 'min_sale_price', 'cost_price'] }
    ],
    order: [['product_code', 'DESC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) }),
    distinct: true
  });

  const list = rows.map(p => ({
    product_id: p.product_id,
    product_code: p.product_code,
    name: p.name,
    unit: p.unit,
    category_name: p.category || '',
    price_id: p.ProductPrice ? p.ProductPrice.price_id : null,
    standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
    min_sale_price: p.ProductPrice ? p.ProductPrice.min_sale_price : 0,
    cost_price: p.ProductPrice ? p.ProductPrice.cost_price : 0
  }));

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function setPrice(ctx) {
  const { productId, standardPrice, minSalePrice } = ctx.request.body;

  if (!productId || standardPrice === undefined || minSalePrice === undefined) {
    ctx.throw(400, '商品ID、标准售价和最低销售价不能为空');
  }

  if (standardPrice < 0 || minSalePrice < 0) {
    ctx.throw(400, '价格不能为负数');
  }

  const product = await Product.findOne({ where: { product_id: productId, is_deleted: 0 } });
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  let price = await ProductPrice.findOne({ where: { product_id: productId } });
  const now = new Date();

  if (price) {
    await price.update({
      standard_price: standardPrice,
      min_sale_price: minSalePrice,
      effective_time: now,
      create_user: ctx.state.user?.name || 'system'
    });
  } else {
    await ProductPrice.create({
      price_id: generateUUID(),
      product_id: productId,
      standard_price: standardPrice,
      min_sale_price: minSalePrice,
      cost_price: 0,
      effective_time: now,
      create_user: ctx.state.user?.name || 'system'
    });
  }

  ctx.body = { code: 0, message: '价格设置成功' };
}

// 计算库存成本价（先进先出加权平均）
async function calculateFifoCost(productId) {
  const { sequelize } = require('../../models');

  const batches = await sequelize.query(`
    SELECT 
      ii.UNIT_PRICE,
      ii.QUANTITY,
      i.INBOUND_NO,
      i.CREATE_TIME
    FROM T_INBOUND_ITEM ii
    JOIN T_INBOUND i ON ii.INBOUND_ID = i.INBOUND_ID
    WHERE ii.PRODUCT_ID = ?
      AND i.STATUS = 'executed'
      AND ii.UNIT_PRICE > 0
      AND ii.QUANTITY > 0
    ORDER BY i.CREATE_TIME ASC
  `, {
    replacements: [productId],
    type: sequelize.QueryTypes.SELECT
  });

  if (!batches || batches.length === 0) {
    return 0;
  }

  let totalWeighted = 0;
  let totalQty = 0;

  for (const batch of batches) {
    const price = parseFloat(batch.UNIT_PRICE);
    const qty = parseInt(batch.QUANTITY);
    totalWeighted += price * qty;
    totalQty += qty;
  }

  if (totalQty === 0) return 0;
  return parseFloat((totalWeighted / totalQty).toFixed(2));
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
    await price.update({ cost_price: costPrice });
  } else {
    await ProductPrice.create({
      price_id: generateUUID(),
      product_id: productId,
      cost_price: costPrice,
      standard_price: 0,
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
      await price.update({ cost_price: costPrice });
    } else {
      await ProductPrice.create({
        price_id: generateUUID(),
        product_id: productId,
        cost_price: costPrice,
        standard_price: 0,
        min_sale_price: 0
      });
    }
    results.push({ productId, costPrice });
  }

  ctx.body = { code: 0, data: results, message: '批量刷新成本价完成' };
}

// ===== 其他 =====

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
    order: [['pn_code', 'ASC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function addPn(ctx) {
  const { productId, pnCode, barcode, isPrimary } = ctx.request.body;

  if (!productId || !pnCode) {
    ctx.throw(400, '商品ID和PN码不能为空');
  }

  const existing = await ProductPn.findOne({
    where: { pn_code: pnCode, is_deleted: 0 }
  });
  if (existing) {
    ctx.throw(400, `PN码 [${pnCode}] 已存在`);
  }

  const pnId = generateUUID();

  await ProductPn.create({
    pn_id: pnId,
    product_id: productId,
    pn_code: pnCode,
    barcode: barcode || '',
    is_primary: isPrimary ? 1 : 0
  });

  ctx.body = { code: 0, pnId, message: 'PN添加成功' };
}

async function searchProduct(ctx) {
  const { keyword, storeId, page = 1, pageSize = 10 } = ctx.query;

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
    { product_code: { [Op.like]: `%${kw}%` } }
  ];

  if (productIdsFromBarcode.length > 0) {
    orConditions.push({ product_id: { [Op.in]: productIdsFromBarcode } });
  }
  if (productIdsFromSn.length > 0) {
    orConditions.push({ product_id: { [Op.in]: productIdsFromSn } });
  }

  where[Op.or] = orConditions;

  const { count, rows } = await Product.findAndCountAll({
    where,
    attributes: ['product_id', 'product_code', 'name', 'category', 'need_sn', 'unit'],
    include: [
      { model: ProductPrice, attributes: ['standard_price', 'min_sale_price'] }
    ],
    order: [['product_code', 'DESC']],
    ...paginate({}, { page: parseInt(page), pageSize: parseInt(pageSize) }),
    distinct: true
  });

  const productIds = rows.map(p => p.product_id);

  let inventoryMap = {};
  if (storeId) {
    const { Inventory } = require('../../models');
    const inventories = await Inventory.findAll({
      where: { product_id: { [Op.in]: productIds }, store_id: storeId }
    });
    for (const inv of inventories) {
      inventoryMap[inv.product_id] = (inv.normal_qty || 0) + (inv.display_qty || 0);
    }
  }

  const list = rows
    .filter(p => !storeId || (inventoryMap[p.product_id] || 0) > 0)
    .map(p => ({
      product_id: p.product_id,
      product_code: p.product_code,
      name: p.name,
      spec: p.specs_json ? JSON.stringify(p.specs_json) : '',
      standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
      min_sale_price: p.ProductPrice ? p.ProductPrice.min_sale_price : 0,
      need_sn: p.need_sn,
      unit: p.unit,
      stock_qty: storeId ? (inventoryMap[p.product_id] || 0) : null,
      pn_list: p.need_sn === 1 ? [...(snPnsByProduct[p.product_id] || [])] : []
    }));

  ctx.body = formatPaginatedResult(list, { page, pageSize, count: list.length });
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

async function importProducts(ctx) {
  if (!ctx.file) {
    ctx.throw(400, '请上传Excel文件');
  }

  let rows = [];
  try {
    const workbook = XLSX.read(ctx.file.buffer);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    rows = XLSX.utils.sheet_to_json(worksheet);
  } catch (error) {
    ctx.throw(400, 'Excel文件解析失败，请检查文件格式');
  }

  if (!rows || rows.length === 0) {
    ctx.throw(400, '文件中没有数据');
  }

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
        results.errors.push({ product: row, message: '商品名称不能为空（请填写"商品名称"列或确保分类字段能拼装出名称）' });
        continue;
      }

      // 基于厂商编码查找是否已存在商品
      const manufacturerCodes = attrMap['厂商编码'] || '';
      let product = null;
      let productId = null;

      if (manufacturerCodes) {
        const primaryManufacturerCode = String(manufacturerCodes).split(/[,;，；\s]+/).filter(Boolean)[0];
        if (primaryManufacturerCode) {
          const existingBarcode = await ProductBarcode.findOne({
            where: { barcode_type: 'manufacturer', barcode_code: primaryManufacturerCode, status: 1 },
            raw: true
          });
          if (existingBarcode) {
            product = await Product.findByPk(existingBarcode.product_id);
            productId = existingBarcode.product_id;
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
          const codes = String(manufacturerCodes).split(/[,;，；\s]+/).filter(Boolean);
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
          const codes = String(barcode69List).split(/[,;，；\s]+/).filter(Boolean);
          for (const code of codes) {
            await ProductBarcode.create({
              barcode_id: generateUUID(), product_id: productId,
              barcode_type: 'barcode69', barcode_code: code.trim(),
              sort_order: 0, status: 1
            }, { transaction });
          }
        }

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
      results.errors.push({ product: row, message: errorMessage });
    }
  }

  ctx.body = { code: 0, data: results, message: '导入完成' };
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

    return {
      '商品编码': p.product_code,
      '商品名称': p.name,
      '商品分类': p.category || '',
      '品牌': p.brand || '',
      '系列': p.series || '',
      '型号': p.model || '',
      '处理器': p.processor || '',
      '内存': p.memory || '',
      '存储': p.storage || '',
      '颜色': p.color || '',
      '显卡': p.gpu || '',
      '配件类别': p.accessory_type || '',
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
  ctx.set('Content-Disposition', `attachment; filename=商品导出_${new Date().toISOString().slice(0, 10)}.xlsx`);
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.body = buffer;
}

module.exports = {
  getProductList, createProduct, updateProduct, deleteProduct, togglePause, importProducts, exportProducts,
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
    const id = generateUUID();
    await ProductBarcode.create({ barcode_id: id, product_id: productId, barcode_type: barcodeType, barcode_code: barcodeCode, sort_order: 0, status: 1 });
    ctx.body = { code: 0, barcodeId: id, message: '添加成功' };
  },
  deleteBarcode: async (ctx) => {
    const bc = await ProductBarcode.findByPk(ctx.params.barcodeId);
    if (!bc) ctx.throw(404, '条码不存在');
    await bc.update({ status: 0 });
    ctx.body = { code: 0, message: '删除成功' };
  },
  getCategoryTree, createCategory, updateCategory, deleteCategory,
  getPriceList, setPrice, refreshCostPrice, batchRefreshCost,
  getPnList, addPn, searchProduct
};