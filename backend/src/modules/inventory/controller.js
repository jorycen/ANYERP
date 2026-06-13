/**
 * 库房管理控制器
 * 优化版：非SN商品直接操作聚合库存，SN商品同时维护SN记录和聚合库存
 */
const { sequelize, ProductSn, Product, ProductPn, ProductPrice, ProductBarcode, Store, Location, InventoryWarning, Inbound, InboundItem, ReturnStock, ReturnStockItem, PurchaseRequest, Payable, Supplier, Inventory, SnLog, Order, OrderItem, Transfer, TransferItem, InventoryConversion, InventoryConversionItem } = require('../../models');
const { Op, Sequelize } = require('sequelize');
const { generateInboundNo, generateOutboundNo, generateTransferNo, generateUUID, generateBatchNo, paginate, formatPaginatedResult } = require('../../utils');

function splitCodes(value) {
  return String(value || '')
    .split(/[,，\s]+/)
    .map(code => code.trim())
    .filter(Boolean);
}

function normalizePnCode(value) {
  const code = String(value || '').trim();
  return code.length > 64 ? code.slice(0, 64) : code;
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

const INVENTORY_CATEGORY_KEYWORDS = {
  computer: ['电脑', '笔记本', '台式机', '一体机', '主机'],
  tablet: ['平板', 'pad', 'ipad'],
  phone: ['手机', 'iphone'],
  accessory: ['配件', '鼠标', '键盘', '手柄', '支架', '摄像头', '保护夹', '保护壳', '贴膜', '充电器', '耳机', '数据线', 'u盘', '杯', '包', '硬盘', '打印机', '内存', '膜']
};

function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function getInventoryCategoryRank(category, accessoryType, name, config) {
  const categoryText = String(category || '').toLowerCase();
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.computer)) return 0;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.tablet)) return 1;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.phone)) return 2;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.accessory)) return 3;

  const accessoryText = String(accessoryType || '').toLowerCase();
  if (accessoryText) return 3;

  const text = [name, config].map(value => String(value || '')).join(' ').toLowerCase();
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.accessory)) return 3;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.computer)) return 0;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.tablet)) return 1;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.phone)) return 2;
  return 4;
}

/**
 * 库存聚合列表 - 按商品汇总，显示5种库存数量
 */
async function getList(ctx) {
  try {
    const { storeId, category, keyword, page = 1, pageSize = 20 } = ctx.query;
    const user = ctx.state.user;

    const whereStore = {};
    if (storeId) whereStore.store_id = storeId;

    const stores = await Store.findAll({ where: whereStore });
    const storeIds = stores.map(s => s.store_id);

    const productWhere = { is_deleted: 0, status: 1 };
    if (category) productWhere.category = category;
    if (keyword) {
      productWhere[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { product_code: { [Op.like]: `%${keyword}%` } },
        { config: { [Op.like]: `%${keyword}%` } },
        { manufacturer_code: { [Op.like]: `%${keyword}%` } },
        { remark: { [Op.like]: `%${keyword}%` } }
      ];
    }

    const products = await Product.findAll({
      where: productWhere,
      include: [{ model: ProductPrice, attributes: ['standard_price', 'cost_price'] }],
      order: [['create_time', 'DESC']]
    });
    const count = products.length;

    const productIds = products.map(p => p.product_id);
    const allStockMap = await buildSalesStockMap(productIds, storeId);
    const salesMap = await buildSalesCountMap(productIds);

    const inventoryWhere = { product_id: { [Op.in]: productIds } };
    if (storeIds.length > 0) {
      inventoryWhere.store_id = { [Op.in]: storeIds };
    }

    const inventories = await Inventory.findAll({
      where: inventoryWhere,
      include: [{ model: Store, attributes: ['store_id', 'name'] }]
    });

    const allStoreMap = new Map();
    stores.forEach(s => allStoreMap.set(s.store_id, s.name));

    const locations = await Location.findAll({
      where: storeIds.length > 0 ? { store_id: { [Op.in]: storeIds }, status: 1 } : { status: 1 },
      raw: true
    });
    const locationMap = new Map();
    locations.forEach(loc => locationMap.set(loc.location_id, loc.name));

    const invMap = {};
    const storeStockMap = {};
    for (const inv of inventories) {
      if (!invMap[inv.product_id]) {
        invMap[inv.product_id] = {
          normal_qty: 0,
          regular_qty: 0,
          subsidy_qty: 0,
          second_qty: 0,
          display_qty: 0,
          demo_qty: 0,
          unsellable_qty: 0,
          pending_qty: 0
        };
        storeStockMap[inv.product_id] = [];
      }
      invMap[inv.product_id].regular_qty += inv.regular_qty || 0;
      invMap[inv.product_id].subsidy_qty += inv.subsidy_qty || 0;
      invMap[inv.product_id].second_qty += inv.second_qty || 0;
      const computedNormal = (inv.regular_qty || 0) + (inv.subsidy_qty || 0) + (inv.second_qty || 0);
      const effectiveNormal = (inv.normal_qty || 0) > 0 ? (inv.normal_qty || 0) : computedNormal;
      invMap[inv.product_id].normal_qty += effectiveNormal;
      invMap[inv.product_id].display_qty += inv.display_qty || 0;
      invMap[inv.product_id].demo_qty += inv.demo_qty || 0;
      invMap[inv.product_id].unsellable_qty += inv.unsellable_qty || 0;
      invMap[inv.product_id].pending_qty += inv.pending_qty || 0;

      if ((effectiveNormal) > 0) {
        const storeName = inv.Store?.name || allStoreMap.get(inv.store_id) || inv.store_id;
        const locationId = inv.location_id || '';
        storeStockMap[inv.product_id].push({
          store_id: inv.store_id,
          store_name: storeName,
          location_id: locationId,
          location_name: locationId ? (locationMap.get(locationId) || locationId) : '未指定库位',
          normal_qty: effectiveNormal
        });
      }
    }

    if (productIds.length > 0) {
      const snRows = await ProductSn.findAll({
        where: {
          product_id: { [Op.in]: productIds },
          status: 'in_stock',
          is_deleted: 0,
          ...(storeIds.length > 0 ? { store_id: { [Op.in]: storeIds } } : {})
        },
        attributes: ['product_id', 'store_id', 'location_id'],
        raw: true
      });
      const snLocationMap = {};
      for (const sn of snRows) {
        const key = `${sn.store_id || ''}|${sn.location_id || ''}`;
        if (!snLocationMap[sn.product_id]) snLocationMap[sn.product_id] = {};
        if (!snLocationMap[sn.product_id][key]) {
          snLocationMap[sn.product_id][key] = {
            store_id: sn.store_id || '',
            store_name: allStoreMap.get(sn.store_id) || sn.store_id || '未知门店',
            location_id: sn.location_id || '',
            location_name: sn.location_id ? (locationMap.get(sn.location_id) || sn.location_id) : '未指定库位',
            normal_qty: 0
          };
        }
        snLocationMap[sn.product_id][key].normal_qty += 1;
      }

      for (const [productId, rowsByLocation] of Object.entries(snLocationMap)) {
        const rows = Object.values(rowsByLocation);
        if (rows.length > 0) {
          storeStockMap[productId] = rows;
        }
      }
    }

    const sortedRows = products.map(p => {
      const inv = invMap[p.product_id] || {
        normal_qty: 0, regular_qty: 0, subsidy_qty: 0, second_qty: 0, display_qty: 0, demo_qty: 0, unsellable_qty: 0, pending_qty: 0
      };
      const stock = allStockMap[p.product_id] || { current: 0, other: 0, total: 0, stores: [], otherStores: [] };
      const sales = salesMap[p.product_id] || { sales_7_qty: 0, sales_30_qty: 0 };
      return {
        product_id: p.product_id,
        category: p.category || '',
        product_name: p.name || '',
        spec: p.config || '',
        product_code: p.product_code || '',
        manufacturer_code: p.manufacturer_code || '',
        standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
        cost_price: p.ProductPrice ? p.ProductPrice.cost_price : 0,
        need_sn: p.need_sn || 0,
        normal_qty: inv.normal_qty,
        regular_qty: inv.regular_qty,
        subsidy_qty: inv.subsidy_qty,
        second_qty: inv.second_qty,
        display_qty: inv.display_qty,
        demo_qty: inv.demo_qty,
        unsellable_qty: inv.unsellable_qty,
        pending_qty: inv.pending_qty,
        current_store_stock_qty: stock.current,
        other_store_stock_qty: stock.other,
        total_stock_qty: stock.total,
        current_store_name: stock.currentStore?.store_name || '',
        store_stock_info: stock.stores || storeStockMap[p.product_id] || [],
        other_store_stock_info: stock.otherStores || [],
        sales_7_qty: sales.sales_7_qty,
        sales_30_qty: sales.sales_30_qty,
        _category_rank: getInventoryCategoryRank(p.category, p.accessory_type, p.name, p.config),
        _create_time: p.create_time
      };
    }).sort((a, b) => {
      const aHasStock = Number(a.normal_qty || 0) > 0 ? 0 : 1;
      const bHasStock = Number(b.normal_qty || 0) > 0 ? 0 : 1;
      if (aHasStock !== bHasStock) return aHasStock - bHasStock;
      if (a._category_rank !== b._category_rank) return a._category_rank - b._category_rank;
      return new Date(b._create_time || 0).getTime() - new Date(a._create_time || 0).getTime();
    });

    const currentPage = Math.max(Number(page) || 1, 1);
    const currentPageSize = Math.max(Number(pageSize) || 20, 1);
    const rows = sortedRows
      .slice((currentPage - 1) * currentPageSize, currentPage * currentPageSize)
      .map(({ _category_rank, _create_time, ...row }) => row);

    ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getList:', error);
    throw error;
  }
}

/**
 * 查看序列号 - 仅用于需要SN管理的商品
 */
async function getSnList(ctx) {
  try {
    const { productId, storeId, currentStoreId, status, snCode, page = 1, pageSize = 20 } = ctx.query;

    const where = { is_deleted: 0 };
    if (productId) where.product_id = productId;

    if (storeId) {
      where.store_id = storeId;
    } else {
      const whereStore = {};
      const stores = await Store.findAll({ where: whereStore });
      const storeIds = stores.map(s => s.store_id);
      if (storeIds.length > 0) {
        where.store_id = { [Op.in]: storeIds };
      }
    }

    if (status) where.status = status;
    if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };

    const { count, rows } = await ProductSn.findAndCountAll({
      where,
      order: [
        [sequelize.literal("FIELD(status, 'in_stock', 'transferring', 'sold')"), 'ASC'],
        ['inbound_time', 'ASC']
      ],
      ...paginate({}, { page, pageSize })
    });

    for (const sn of rows) {
      if (sn.product_id) {
        sn.dataValues.Product = await Product.findByPk(sn.product_id, {
          attributes: ['product_id', 'name', 'category', 'config', 'brand', 'series', 'model', 'need_sn'],
          include: [{ model: ProductPrice, attributes: ['standard_price', 'min_sale_price'] }]
        });
      }
      if (sn.store_id) {
        sn.dataValues.Store = await Store.findByPk(sn.store_id, { attributes: ['name', 'region_id'] });
      }
      if (sn.location_id) {
        sn.dataValues.Location = await Location.findByPk(sn.location_id, { attributes: ['name'] });
      }
    }

    const productIds = rows.map(row => row.product_id).filter(Boolean);
    const stockMap = await buildSalesStockMap(productIds, currentStoreId || storeId || '');
    const salesMap = await buildSalesCountMap(productIds);

    const flatRows = rows.map(row => {
      const data = row.toJSON();
      const price = data.Product?.ProductPrice || {};
      const stock = stockMap[data.product_id] || { current: 0, other: 0, total: 0 };
      const sales = salesMap[data.product_id] || { sales_7_qty: 0, sales_30_qty: 0 };
      return {
        ...data,
        product_name: data.Product?.name || '',
        name: data.Product?.name || '',
        category: data.Product?.category || '',
        config: data.Product?.config || '',
        spec: data.Product?.config || '',
        brand: data.Product?.brand || '',
        series: data.Product?.series || '',
        model: data.Product?.model || '',
        standard_price: price.standard_price || 0,
        min_sale_price: price.min_sale_price || 0,
        settlement_price: price.min_sale_price || price.standard_price || 0,
        need_sn: data.Product?.need_sn || 0,
        current_store_stock_qty: stock.current,
        other_store_stock_qty: stock.other,
        total_stock_qty: stock.total,
        current_store_name: stock.currentStore?.store_name || '',
        store_stock_info: stock.stores || [],
        other_store_stock_info: stock.otherStores || [],
        sales_7_qty: sales.sales_7_qty,
        sales_30_qty: sales.sales_30_qty,
        stock_qty: currentStoreId || storeId ? stock.current : stock.total,
        stock_rank: stock.current > 0 ? 0 : (stock.total > 0 ? 1 : 2),
        store_name: data.Store?.name || '',
        location_name: data.Location?.name || ''
      };
    });

    ctx.body = formatPaginatedResult(flatRows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getSnList:', error);
    throw error;
  }
}

async function updateSn(ctx) {
  try {
    const { snId } = ctx.params;
    const { newSnCode } = ctx.request.body;
    const user = ctx.state?.staff || {};

    if (!newSnCode || newSnCode.trim() === '') {
      ctx.throw(400, '新SN码不能为空');
    }

    const sn = await ProductSn.findByPk(snId);
    if (!sn) {
      ctx.throw(404, 'SN记录不存在');
    }

    const exists = await ProductSn.findOne({
      where: {
        pn_code: sn.pn_code || '',
        sn_code: newSnCode.trim(),
        is_deleted: 0
      }
    });
    if (exists && exists.sn_id !== snId) {
      ctx.throw(400, `SN码 [${newSnCode}] 已被使用`);
    }

    const oldSnCode = sn.sn_code;

    await SnLog.create({
      log_id: generateUUID(),
      sn_id: snId,
      sn_code: newSnCode.trim(),
      old_sn_code: oldSnCode,
      product_id: sn.product_id,
      product_name: sn.product_name || '',
      store_id: sn.store_id,
      action: 'modify_sn',
      remark: `SN码由 ${oldSnCode} 修改为 ${newSnCode.trim()}`,
      create_user: user.name || user.phone || '-'
    });

    await sn.update({ sn_code: newSnCode.trim() });

    ctx.body = { code: 0, message: 'SN码修改成功' };
  } catch (err) {
    if (err.status) ctx.throw(err.status, err.message);
    console.error('updateSn error:', err);
    ctx.throw(500, '修改SN失败');
  }
}

async function snTrace(ctx) {
  try {
    const { snCode } = ctx.params;
    const { pnCode } = ctx.query;

    if (!snCode) {
      ctx.throw(400, 'SN码不能为空');
    }

    const timeline = [];

    const traces = await sequelize.query(
      `SELECT log_id, sn_code, old_sn_code, action, remark, create_user, create_time
       FROM T_SN_LOG
       WHERE sn_code = :snCode OR old_sn_code = :snCode2
       ORDER BY create_time ASC`,
      {
        replacements: { snCode, snCode2: snCode },
        type: sequelize.QueryTypes.SELECT
      }
    );

    for (const t of traces) {
      timeline.push({
        id: t.log_id,
        type: t.action,
        label: t.action === 'modify_sn' ? 'SN修改' :
               t.action === 'sale' ? '已销售' :
               t.action === 'inbound' ? '入库' :
               t.action === 'return' ? '退库' : t.action,
        description: t.remark || '',
        user: t.create_user || '-',
        time: t.create_time,
        oldSnCode: t.old_sn_code || null
      });
    }

    const inboundItems = await sequelize.query(
      `SELECT ii.sn_code, i.inbound_no, i.inbound_id, i.create_time, i.create_user
       FROM T_INBOUND_ITEM ii
       JOIN T_INBOUND i ON ii.inbound_id = i.inbound_id
       WHERE ii.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const ib of inboundItems) {
      timeline.push({
        id: 'ib-' + ib.inbound_id,
        type: 'inbound',
        label: '入库',
        description: `入库单号: ${ib.inbound_no}`,
        ref_no: ib.inbound_no,
        ref_id: ib.inbound_id,
        user: ib.create_user || '-',
        time: ib.create_time
      });
    }

    const orderItems = await sequelize.query(
      `SELECT oi.sn_code, o.order_no, o.order_id, o.create_time, o.create_user
       FROM T_ORDER_ITEM oi
       JOIN T_ORDER o ON oi.order_id = o.order_id
       WHERE oi.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const ord of orderItems) {
      timeline.push({
        id: 'ord-' + ord.order_id,
        type: 'sale',
        label: '已销售',
        description: `销售订单号: ${ord.order_no}`,
        ref_no: ord.order_no,
        ref_id: ord.order_id,
        user: ord.create_user || '-',
        time: ord.create_time
      });
    }

    const returnItems = await sequelize.query(
      `SELECT ri.sn_code, rs.return_no, rs.return_id, rs.create_time, rs.create_user
       FROM T_RETURN_STOCK_ITEM ri
       JOIN T_RETURN_STOCK rs ON ri.return_id = rs.return_id
       WHERE ri.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const rt of returnItems) {
      timeline.push({
        id: 'rt-' + rt.return_id,
        type: 'return',
        label: '退库',
        description: `退库单号: ${rt.return_no}`,
        ref_no: rt.return_no,
        ref_id: rt.return_id,
        user: rt.create_user || '-',
        time: rt.create_time
      });
    }

    const transferItems = await sequelize.query(
      `SELECT ti.sn_code, t.transfer_no, t.transfer_id, t.from_store_id, t.to_store_id,
              fs.name as from_store_name, ts.name as to_store_name,
              t.apply_user, t.create_time, t.status as transfer_status
       FROM T_TRANSFER_ITEM ti
       JOIN T_TRANSFER t ON ti.transfer_id = t.transfer_id
       LEFT JOIN T_STORE fs ON t.from_store_id = fs.store_id
       LEFT JOIN T_STORE ts ON t.to_store_id = ts.store_id
       WHERE ti.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const tr of transferItems) {
      const isOut = tr.transfer_status === 'pending' || tr.transfer_status === 'out_confirmed';
      timeline.push({
        id: 'tr-' + tr.transfer_id,
        type: 'transfer',
        label: '调拨' + (tr.transfer_status === 'completed' ? '（已完成）' : '（进行中）'),
        description: `${tr.from_store_name || tr.from_store_id} → ${tr.to_store_name || tr.to_store_id}，单号：${tr.transfer_no}`,
        ref_no: tr.transfer_no,
        ref_id: tr.transfer_id,
        user: tr.apply_user || '-',
        time: tr.create_time
      });
    }

    timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

    const snWhere = { sn_code: snCode, is_deleted: 0 };
    if (pnCode) {
      snWhere.pn_code = pnCode;
    }

    const sn = await ProductSn.findOne({
      where: snWhere,
      include: [{ model: Product, attributes: ['name'] }]
    });
    const snData = sn ? sn.toJSON() : null;

    ctx.body = {
      code: 0,
      data: {
        snCode,
        currentStatus: snData ? snData.status : 'unknown',
        productId: snData ? snData.product_id : '',
        productName: snData ? (snData.product_name || snData.Product?.name || '') : '',
        storeId: snData ? snData.store_id : '',
        timeline
      }
    };
  } catch (err) {
    if (err.status) ctx.throw(err.status, err.message);
    console.error('snTrace error:', err);
    ctx.throw(500, '查询SN追踪失败');
  }
}

/**
 * 入库单列表
 */
async function getInboundList(ctx) {
  try {
    const { storeId, status, page = 1, pageSize = 20 } = ctx.query;

    const where = {};
    if (storeId) where.store_id = storeId;
    if (status) where.status = status;

    const { count, rows } = await Inbound.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
      ...paginate({}, { page, pageSize })
    });

    for (const inbound of rows) {
      const items = await InboundItem.findAll({ where: { inbound_id: inbound.inbound_id } });
      const store = await Store.findByPk(inbound.store_id);
      inbound.dataValues.items = items;
      inbound.dataValues.Store = store;
    }

    const allProductIds = [];
    rows.forEach(row => {
      if (row.dataValues.items && row.dataValues.items.length > 0) {
        row.dataValues.items.forEach(item => {
          if (item.product_id) allProductIds.push(item.product_id);
        });
      }
    });

    const products = await Product.findAll({
      where: { product_id: { [Op.in]: [...new Set(allProductIds)] } }
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    const formattedRows = rows.map(row => {
      const result = row.toJSON();
      result.Store = row.dataValues.Store;
      result.items = row.dataValues.items;
      result.store_name = result.Store?.name || '';

      if (result.items && result.items.length > 0) {
        const itemsSummary = result.items.map(item => {
          let productName = item.product_name;
          if (!productName || productName.trim() === '') {
            const product = productMap.get(item.product_id);
            if (product) productName = product.name;
          }
          return `${productName || '未知商品'} x${item.quantity}`;
        });
        result.items_summary = itemsSummary.join('、');
      } else {
        result.items_summary = '';
      }
      return result;
    });

    ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getInboundList:', error);
    throw error;
  }
}

/**
 * 获取入库单详情
 */
async function getInboundDetail(ctx) {
  try {
    const { inboundId } = ctx.params;

    const inbound = await Inbound.findByPk(inboundId);
    if (!inbound) ctx.throw(404, '入库单不存在');

    const items = await InboundItem.findAll({ where: { inbound_id: inboundId } });
    const store = await Store.findByPk(inbound.store_id);
    inbound.dataValues.items = items.map(i => i.toJSON());
    inbound.dataValues.Store = store ? store.toJSON() : null;

    const result = inbound.toJSON();
    result.store_name = result.Store?.name || '';

    if (result.items && result.items.length > 0) {
      const productIds = result.items.map(item => item.product_id).filter(id => id);
      const products = await Product.findAll({
        where: { product_id: { [Op.in]: productIds } }
      });
      const productMap = new Map();
      products.forEach(p => productMap.set(p.product_id, p));

      result.items = result.items.map(item => {
        if (!item.product_name || item.product_name.trim() === '') {
          const product = productMap.get(item.product_id);
          if (product) item.product_name = product.name;
        }
        return {
          ...item,
          need_sn: productMap.get(item.product_id)?.need_sn || 0
        };
      });

      const pnRecords = await ProductPn.findAll({
        where: { product_id: { [Op.in]: productIds }, is_deleted: 0 }
      });
      const barcodeRecords = await ProductBarcode.findAll({
        where: { product_id: { [Op.in]: productIds }, barcode_type: 'manufacturer', status: 1 },
        raw: true
      });
      const pnMap = {};
      for (const pn of pnRecords) {
        if (!pnMap[pn.product_id]) pnMap[pn.product_id] = [];
        pnMap[pn.product_id].push({
          pn_id: pn.pn_id,
          pn_code: pn.pn_code,
          product_name: pn.product_name || ''
        });
      }

      for (const bc of barcodeRecords) {
        if (!bc.barcode_code) continue;
        if (!pnMap[bc.product_id]) pnMap[bc.product_id] = [];
        if (!pnMap[bc.product_id].some(p => p.pn_code === bc.barcode_code)) {
          pnMap[bc.product_id].push({
            pn_id: '',
            pn_code: bc.barcode_code,
            product_name: ''
          });
        }
      }

      for (const product of products) {
        const manufacturerCodes = splitCodes(product.manufacturer_code);
        if (manufacturerCodes.length > 0) {
          if (!pnMap[product.product_id]) pnMap[product.product_id] = [];
          for (const code of manufacturerCodes) {
            if (!pnMap[product.product_id].some(p => p.pn_code === code)) {
              pnMap[product.product_id].push({
                pn_id: '',
                pn_code: code,
                product_name: product.name || ''
              });
            }
          }
        }
      }

      for (const item of items) {
        const itemData = item.toJSON ? item.toJSON() : item;
        const pnCode = itemData.pn_code;
        if (!pnCode) continue;
        if (!pnMap[itemData.product_id]) pnMap[itemData.product_id] = [];
        if (!pnMap[itemData.product_id].some(p => p.pn_code === pnCode)) {
          pnMap[itemData.product_id].push({
            pn_id: '',
            pn_code: pnCode,
            product_name: ''
          });
        }
      }

      result.product_pns = pnMap;
    }

    ctx.body = { code: 0, data: result };
  } catch (error) {
    console.error('Error in getInboundDetail:', error);
    throw error;
  }
}

/**
 * 更新库存聚合（入库/退库）
 * @param {string} productId 商品ID
 * @param {string} storeId 门店ID
 * @param {string} field 字段名: normal_qty | display_qty | demo_qty | unsellable_qty | pending_qty
 * @param {number} delta 变化量（入库为正，退库为负）
 * @param {object} transaction Sequelize事务
 */
async function updateInventory(productId, storeId, field, delta, transaction, locationId = '') {
  const normalizedLocationId = locationId || '';

  if (delta < 0 && !normalizedLocationId) {
    let remaining = Math.abs(delta);
    const rows = await Inventory.findAll({
      where: { product_id: productId, store_id: storeId },
      order: [
        [sequelize.literal(`CASE WHEN LOCATION_ID = '' THEN 1 ELSE 0 END`), 'ASC'],
        [field, 'DESC']
      ],
      transaction
    });

    for (const row of rows) {
      if (remaining <= 0) break;
      const current = Number(row[field] || 0);
      if (current <= 0) continue;
      const deduct = Math.min(current, remaining);
      await row.update({ [field]: current - deduct }, { transaction });
      remaining -= deduct;
    }

    if (remaining <= 0) return;
    delta = -remaining;
  }

  let inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId, location_id: normalizedLocationId },
    transaction
  });

  if (!inv) {
    inv = await Inventory.create({
      inventory_id: generateUUID(),
      product_id: productId,
      store_id: storeId,
      location_id: normalizedLocationId,
      normal_qty: 0,
      regular_qty: 0,
      subsidy_qty: 0,
      second_qty: 0,
      display_qty: 0,
      demo_qty: 0,
      unsellable_qty: 0,
      pending_qty: 0
    }, { transaction });
  }

  const newVal = Math.max(0, (inv[field] || 0) + delta);
  await inv.update({ [field]: newVal }, { transaction });
}


async function getTransferableStock(product, productId, storeId, transaction) {
  const inventory = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  const inventoryQty = inventory ? Number(inventory.normal_qty || 0) : 0;

  if (Number(product.need_sn) !== 1) {
    return inventoryQty;
  }

  const snQty = await ProductSn.count({
    where: {
      product_id: productId,
      store_id: storeId,
      status: 'in_stock',
      is_deleted: 0
    },
    transaction
  });

  return Math.max(inventoryQty, snQty);
}

function normalizeTransferItem(raw) {
  const productId = raw.productId || raw.product_id;
  const snId = raw.snId || raw.sn_id || null;
  const snCode = raw.snCode || raw.sn_code || '';
  const quantity = Math.max(parseInt(raw.quantity || raw.qty || 1, 10), 1);

  return { productId, snId, snCode, quantity };
}

/**
 * 执行入库
 */
async function executeInbound(ctx) {
  const VALID_INVENTORY_TYPES = ['normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty'];
  const PRODUCT_TYPE_TO_FIELD = {
    '服务商全资源': 'regular_qty',
    '含税仅国补': 'subsidy_qty',
    '含税无国补': 'regular_qty',
    '未税': 'second_qty',
    '正规货': 'regular_qty',
    '国补货': 'subsidy_qty',
    '纯二批': 'second_qty'
  };

  const t = await sequelize.transaction();
  try {
    const { inboundId, items } = ctx.request.body;
    const user = ctx.state.user;

    const inbound = await Inbound.findByPk(inboundId);
    if (!inbound) ctx.throw(404, '入库单不存在');

    if (inbound.status !== 'pending') {
      ctx.throw(400, '该入库单已处理');
    }

    const inboundItems = await InboundItem.findAll({ where: { inbound_id: inboundId } });
    const productIds = inboundItems.map(item => item.product_id);
    const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } } });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        ctx.throw(400, `商品 ${item.productId} 不存在`);
      }

      const dbItems = inboundItems.filter(di => di.product_id === item.productId);
      const dbItem = dbItems[0];
      if (!dbItem) {
        ctx.throw(400, `入库单中未找到商品 ${item.productId || product.name} 的明细`);
      }

      const quantity = parseInt(item.quantity) || 1;
      const inventoryType = VALID_INVENTORY_TYPES.includes(item.inventoryType)
        ? item.inventoryType
        : 'normal_qty';
      const locationId = item.locationId || null;
      const originalPickupPrice = Number(item.originalPickupPrice || item.original_pickup_price || dbItem.original_pickup_price || dbItem.unit_price || 0);

      if (product.need_sn === 1) {
        if (!item.snCode || item.snCode.trim() === '') {
          ctx.throw(400, `商品 ${dbItem.product_name} 需要SN管理，SN码不能为空`);
        }

        const pnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');
        const snCode = item.snCode.trim();

        const existingSn = await ProductSn.findOne({
          where: {
            product_id: dbItem.product_id,
            pn_code: pnCode,
            sn_code: snCode,
            status: { [Op.in]: ['in_stock', 'transferring'] },
            is_deleted: 0
          },
          transaction: t
        });
        if (existingSn) {
          ctx.throw(400, `PN码 [${pnCode || '-'}] 下的SN码 [${snCode}] 已存在`);
        }

        await ProductSn.create({
          sn_id: generateUUID(),
          product_id: dbItem.product_id,
          product_name: dbItem.product_name || '',
          pn_code: pnCode,
          sn_code: snCode,
          status: 'in_stock',
          inventory_type: inventoryType,
          store_id: inbound.store_id,
          location_id: locationId,
          inbound_time: new Date(),
          inbound_price: dbItem.unit_price,
          original_pickup_price: originalPickupPrice,
          remark: item.remark || '',
          is_deleted: 0
        }, { transaction: t });

        await dbItem.update({
          sn_code: snCode,
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
          original_pickup_price: originalPickupPrice,
          inventory_type: inventoryType
        }, { transaction: t });
      } else {
        const pnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');

        await dbItem.update({
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
          original_pickup_price: originalPickupPrice,
          inventory_type: inventoryType
        }, { transaction: t });
      }

      const savedPnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');
      if (savedPnCode) {
        const existingPn = await ProductPn.findOne({
          where: { pn_code: savedPnCode, is_deleted: 0 },
          transaction: t
        });
        if (!existingPn) {
          await ProductPn.create({
            pn_id: generateUUID(),
            product_id: item.productId,
            pn_code: savedPnCode,
            barcode: '',
            is_primary: 0,
            status: 1,
            is_deleted: 0
          }, { transaction: t });
        }
      }

      await updateInventory(item.productId, inbound.store_id, inventoryType, quantity, t, locationId);

      if (inventoryType === 'normal_qty' && dbItem.product_type) {
        const typeField = PRODUCT_TYPE_TO_FIELD[dbItem.product_type];
        if (typeField) {
          await updateInventory(item.productId, inbound.store_id, typeField, quantity, t, locationId);
        }
      }
    }

    await inbound.update({ status: 'completed', update_time: new Date() }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '入库完成' };
  } catch (error) {
    await t.rollback();
    console.error('Error in executeInbound:', error);
    throw error;
  }
}

/**
 * 入库操作 - 创建入库单
 */
async function inbound(ctx) {
  try {
    const user = ctx.state.user;
    const { storeId, sourceType, sourceNo, items } = ctx.request.body;

    const inboundNo = generateInboundNo();
    const inboundId = generateUUID();

    const totalQuantity = items.reduce((sum, item) => sum + (item.quantity || 0), 0);

    await Inbound.create({
      inbound_id: inboundId,
      inbound_no: inboundNo,
      store_id: storeId,
      source_type: sourceType,
      source_no: sourceNo,
      total_quantity: totalQuantity,
      status: 'pending',
      create_user: user.name,
      create_time: new Date(),
      update_time: new Date()
    });

    for (const item of items) {
      await InboundItem.create({
        inbound_id: inboundId,
        product_id: item.productId,
        product_name: item.productName,
        pn_code: item.pnCode,
        unit_price: item.unitPrice,
        quantity: item.quantity,
        remark: item.remark
      });
    }

    ctx.body = { inboundId, inboundNo, message: '入库单创建成功' };
  } catch (error) {
    console.error('Error in inbound:', error);
    throw error;
  }
}

/**
 * 出库操作
 */
async function outbound(ctx) {
  const user = ctx.state.user;
  const { storeId, outType, items } = ctx.request.body;

  const outboundNo = generateOutboundNo();
  const outboundId = generateUUID();

  ctx.body = { outboundId, outboundNo, message: '出库成功' };
}

/**
 * 调拨操作 - 创建调拨申请
 */
async function transfer(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { fromStoreId, toStoreId } = ctx.request.body;
    const rawItems = Array.isArray(ctx.request.body.items) ? ctx.request.body.items : [];
    const items = rawItems.map(normalizeTransferItem);

    if (!fromStoreId || !toStoreId) {
      ctx.throw(400, '?????????????');
    }
    if (fromStoreId === toStoreId) {
      ctx.throw(400, '?????????????');
    }
    if (items.length === 0) {
      ctx.throw(400, '????????');
    }
    if (items.some(item => !item.productId)) {
      ctx.throw(400, '?????????');
    }

    const productIds = [...new Set(items.map(item => item.productId))];
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds }, is_deleted: 0 },
      transaction: t
    });
    const productMap = new Map(products.map(product => [product.product_id, product]));
    const normalizedItems = [];

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        ctx.throw(400, `????????${item.productId || '-'}`);
      }

      if (item.snId || item.snCode) {
        if (!item.snId || !item.snCode) {
          ctx.throw(400, `?? ${product.name} ?SN?????`);
        }
        const sn = await ProductSn.findOne({
          where: {
            sn_id: item.snId,
            sn_code: item.snCode,
            product_id: item.productId,
            store_id: fromStoreId,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!sn) {
          ctx.throw(400, `SN?[${item.snCode}]???????????`);
        }
        normalizedItems.push({ ...item, quantity: 1, productName: product.name });
        continue;
      }

      const quantity = Math.max(parseInt(item.quantity || 1, 10), 1);
      const availableQty = await getTransferableStock(product, item.productId, fromStoreId, t);
      if (availableQty < quantity) {
        ctx.throw(400, `?? ${product.name} ????????${availableQty}???${quantity}`);
      }

      if (Number(product.need_sn) === 1) {
        for (let i = 0; i < quantity; i++) {
          normalizedItems.push({
            productId: item.productId,
            snId: null,
            snCode: '',
            quantity: 1,
            productName: product.name
          });
        }
      } else {
        normalizedItems.push({
          productId: item.productId,
          snId: null,
          snCode: '',
          quantity,
          productName: product.name
        });
      }
    }

    const transferNo = generateTransferNo();
    const transferId = generateUUID();
    const totalQuantity = normalizedItems.reduce((sum, item) => sum + Number(item.quantity || 1), 0);

    await Transfer.create({
      transfer_id: transferId,
      transfer_no: transferNo,
      from_store_id: fromStoreId,
      to_store_id: toStoreId,
      total_quantity: totalQuantity,
      status: 'pending',
      apply_user: user.name || user.staffId
    }, { transaction: t });

    for (const item of normalizedItems) {
      await TransferItem.create({
        transfer_id: transferId,
        product_id: item.productId,
        sn_id: item.snId || null,
        sn_code: item.snCode || '',
        quantity: item.quantity || 1
      }, { transaction: t });

      if (item.snId && item.snCode) {
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.snId,
          sn_code: item.snCode,
          product_id: item.productId,
          store_id: fromStoreId,
          action: 'transfer_out',
          remark: `?????${fromStoreId} -> ${toStoreId}????${transferNo}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }
    }

    await t.commit();
    ctx.body = { code: 0, data: { transferId, transferNo }, message: '???????' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('transfer error:', err);
    ctx.throw(500, '????????');
  }
}

async function getTransferList(ctx) {
  try {
    const { status, fromStoreId, toStoreId, page = 1, pageSize = 20 } = ctx.query;

    const where = {};
    if (status) where.status = status;
    if (fromStoreId) where.from_store_id = fromStoreId;
    if (toStoreId) where.to_store_id = toStoreId;

    const { count, rows } = await Transfer.findAndCountAll({
      where,
      include: [
        { model: Store, as: 'FromStore', attributes: ['store_id', 'name'] },
        { model: Store, as: 'ToStore', attributes: ['store_id', 'name'] },
        { model: TransferItem, attributes: ['item_id', 'product_id', 'sn_id', 'sn_code', 'quantity'] }
      ],
      order: [['create_time', 'DESC']],
      ...paginate({}, { page, pageSize })
    });

    const productIds = [...new Set(rows.flatMap(row => (row.TransferItems || []).map(item => item.product_id)).filter(Boolean))];
    const products = productIds.length > 0
      ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, attributes: ['product_id', 'name', 'need_sn'] })
      : [];
    const productMap = new Map(products.map(product => [product.product_id, product]));

    const list = rows.map(row => {
      const data = row.toJSON();
      data.TransferItems = (data.TransferItems || []).map(item => {
        const product = productMap.get(item.product_id);
        return {
          ...item,
          product_name: product?.name || '',
          need_sn: product?.need_sn || 0
        };
      });
      return {
        ...data,
        from_store_name: data.FromStore?.name || '',
        to_store_name: data.ToStore?.name || ''
      };
    });

    ctx.body = formatPaginatedResult(list, { page, pageSize, count });
  } catch (err) {
    console.error('getTransferList error:', err);
    ctx.throw(500, '查询调拨列表失败');
  }
}

/**
 * 确认调拨出库（原门店操作）
 */
async function confirmTransferOut(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { transferId } = ctx.request.body;
    const selectedSnByItemId = new Map(
      (Array.isArray(ctx.request.body.items) ? ctx.request.body.items : [])
        .filter(item => item && item.itemId && item.snId)
        .map(item => [String(item.itemId), item.snId])
    );
    const selectedSnIds = new Set();

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }],
      transaction: t
    });

    if (!transfer) {
      ctx.throw(404, '??????');
    }
    if (transfer.status !== 'pending') {
      ctx.throw(400, '???????????');
    }

    const items = transfer.TransferItems || [];
    const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
    const products = productIds.length > 0
      ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction: t })
      : [];
    const productMap = new Map(products.map(product => [product.product_id, product]));

    for (const item of items) {
      const product = productMap.get(item.product_id);
      let snId = item.sn_id;
      let snCode = item.sn_code;
      const quantity = Number(item.quantity || 1);

      if (!snId && product && Number(product.need_sn) === 1) {
        snId = selectedSnByItemId.get(String(item.item_id)) || '';
        if (!snId) {
          ctx.throw(400, `商品 ${product.name} 需要选择SN后才能确认出库`);
        }
      }

      if (snId && !snCode) {
        if (selectedSnIds.has(snId)) {
          ctx.throw(400, '同一个SN不能重复选择');
        }
        selectedSnIds.add(snId);

        const sn = await ProductSn.findOne({
          where: {
            sn_id: snId,
            product_id: item.product_id,
            store_id: transfer.from_store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!sn) {
          ctx.throw(400, `商品 ${product?.name || item.product_id} 选择的SN不在当前门店可用库存中`);
        }
        snId = sn.sn_id;
        snCode = sn.sn_code;
        await item.update({ sn_id: snId, sn_code: snCode, quantity: 1 }, { transaction: t });
      } else if (snId) {
        if (selectedSnIds.has(snId)) {
          ctx.throw(400, '同一个SN不能重复选择');
        }
        selectedSnIds.add(snId);
      }

      if (snId && snCode) {
        const [updated] = await ProductSn.update(
          { status: 'transferring' },
          {
            where: {
              sn_id: snId,
              product_id: item.product_id,
              store_id: transfer.from_store_id,
              status: 'in_stock',
              is_deleted: 0
            },
            transaction: t
          }
        );
        if (updated === 0) {
          ctx.throw(400, `SN?[${snCode}]???????????`);
        }

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: snId,
          sn_code: snCode,
          product_id: item.product_id,
          store_id: transfer.from_store_id,
          action: 'transfer_out_confirm',
          remark: `???????${transfer.from_store_id} -> ${transfer.to_store_id}????${transfer.transfer_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, transfer.from_store_id, 'normal_qty', -quantity, t);
    }

    await transfer.update({
      status: 'out_confirmed',
      confirm_user: user.name || user.staffId
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '????????' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferOut error:', err);
    ctx.throw(500, '????????');
  }
}

async function confirmTransferIn(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { transferId } = ctx.request.body;

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }]
    });

    if (!transfer) {
      ctx.throw(404, '调拨单不存在');
    }
    if (transfer.status !== 'out_confirmed') {
      ctx.throw(400, '当前状态不允许确认入库');
    }

    const items = transfer.TransferItems || [];

    for (const item of items) {
      if (item.sn_id && item.sn_code) {
        await ProductSn.update(
          {
            store_id: transfer.to_store_id,
            status: 'in_stock',
            location_id: null
          },
          { where: { sn_id: item.sn_id }, transaction: t }
        );

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          store_id: transfer.to_store_id,
          action: 'transfer_in_confirm',
          remark: `调拨入库确认：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, transfer.to_store_id, 'normal_qty', item.quantity || 1, t);
    }

    await transfer.update({
      status: 'completed',
      inbound_confirm_user: user.name || user.staffId
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '调拨入库确认成功，调拨完成' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferIn error:', err);
    ctx.throw(500, '确认调拨入库失败');
  }
}

/**
 * 生成退库单号
 */
function generateReturnNo() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 900) + 100;
  return `RTN${year}${month}${day}${hour}${minute}${second}${random}`;
}

function getProductTypeInventoryField(productType) {
  const map = {
    '服务商全资源': 'regular_qty',
    '含税仅国补': 'subsidy_qty',
    '含税无国补': 'regular_qty',
    '未税': 'second_qty',
    '正规货': 'regular_qty',
    '国补货': 'subsidy_qty',
    '纯二批': 'second_qty'
  };
  return map[productType] || null;
}

function generateConversionNo(type = 'split') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 900) + 100;
  return `${type === 'assemble' ? 'ASM' : 'SPL'}${year}${month}${day}${hour}${minute}${second}${random}`;
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeConversionType(value) {
  return value === 'assemble' ? 'assemble' : 'split';
}

async function ensurePn(productId, pnCode, transaction) {
  const code = normalizePnCode(pnCode);
  if (!code) return null;
  let pn = await ProductPn.findOne({ where: { pn_code: code, is_deleted: 0 }, transaction });
  if (!pn) {
    pn = await ProductPn.create({
      pn_id: generateUUID(),
      product_id: productId,
      pn_code: code,
      barcode: '',
      is_primary: 0,
      status: 1,
      is_deleted: 0
    }, { transaction });
  }
  return pn;
}

async function setProductCostPrice(productId, costPrice, user, transaction) {
  let price = await ProductPrice.findOne({ where: { product_id: productId }, transaction });
  const payload = {
    cost_price: money(costPrice),
    effective_time: new Date(),
    create_user: user.name || user.staffId || 'system'
  };
  if (price) {
    await price.update(payload, { transaction });
  } else {
    await ProductPrice.create({
      price_id: generateUUID(),
      product_id: productId,
      standard_price: 0,
      min_sale_price: 0,
      status: 1,
      ...payload
    }, { transaction });
  }
}

async function getAvailableQty(productId, storeId, inventoryType, locationId, transaction) {
  const column = inventoryType || 'normal_qty';
  const where = { product_id: productId, store_id: storeId };
  if (locationId) where.location_id = locationId;
  const rows = await Inventory.findAll({ where, transaction });
  return rows.reduce((sum, inv) => {
    if (column === 'normal_qty') {
      const detailTotal = Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0);
      return sum + Math.max(Number(inv.normal_qty || 0), detailTotal);
    }
    return sum + Number(inv[column] || 0);
  }, 0);
}

async function buildConversionSourceRows(sourceItems, conversionType, storeId, transaction) {
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    const label = conversionType === 'assemble' ? '组装组件' : '被拆商品';
    const err = new Error(`请添加${label}`);
    err.status = 400;
    throw err;
  }

  const rows = [];
  for (const raw of sourceItems) {
    const productId = raw.productId || raw.product_id;
    const product = await Product.findByPk(productId, { transaction });
    if (!product || product.is_deleted === 1) {
      const err = new Error(`来源商品不存在：${productId || ''}`);
      err.status = 400;
      throw err;
    }

    let snRecord = null;
    let inventoryType = raw.inventoryType || raw.inventory_type || 'normal_qty';
    let locationId = raw.locationId || raw.location_id || '';
    let quantity = Math.max(1, parseInt(raw.quantity, 10) || 1);
    let pnCode = normalizePnCode(raw.pnCode || raw.pn_code || splitCodes(product.manufacturer_code)[0] || '');
    let snCode = String(raw.snCode || raw.sn_code || '').trim();

    if (Number(product.need_sn) === 1) {
      if (!raw.snId && !raw.sn_id && !snCode) {
        const err = new Error(`来源商品 ${product.name} 需要SN管理，请选择SN`);
        err.status = 400;
        throw err;
      }
      const snWhere = {
        product_id: product.product_id,
        store_id: storeId,
        status: 'in_stock',
        is_deleted: 0
      };
      if (raw.snId || raw.sn_id) snWhere.sn_id = raw.snId || raw.sn_id;
      if (snCode) snWhere.sn_code = snCode;
      if (pnCode) snWhere.pn_code = pnCode;
      snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord) {
        const err = new Error(`来源商品 ${product.name} 未找到可转换的在库SN`);
        err.status = 400;
        throw err;
      }
      quantity = 1;
      inventoryType = snRecord.inventory_type || inventoryType;
      locationId = snRecord.location_id || locationId || '';
      pnCode = snRecord.pn_code || pnCode;
      snCode = snRecord.sn_code || snCode;
    } else {
      const available = await getAvailableQty(product.product_id, storeId, inventoryType, locationId, transaction);
      if (available < quantity) {
        const err = new Error(`来源商品 ${product.name} 库存不足，可用 ${available}，需要 ${quantity}`);
        err.status = 400;
        throw err;
      }
    }

    let fallbackCost = 0;
    if (Number(product.need_sn) !== 1) {
      const price = await ProductPrice.findOne({ where: { product_id: product.product_id }, transaction });
      fallbackCost = Number(price?.cost_price || 0);
    }
    const unitCost = Number(product.need_sn) === 1
      ? money(snRecord?.inbound_price ?? raw.unitCost ?? raw.unit_cost ?? 0)
      : money(conversionType === 'split' && fallbackCost > 0 ? fallbackCost : (raw.unitCost ?? raw.unit_cost ?? fallbackCost));
    if (unitCost <= 0) {
      const err = new Error(`来源商品 ${product.name} 的单位成本必须大于0`);
      err.status = 400;
      throw err;
    }

    rows.push({
      line_role: 'source',
      product,
      product_id: product.product_id,
      product_name: product.name,
      pn_code: pnCode,
      sn_id: snRecord?.sn_id || raw.snId || raw.sn_id || null,
      sn_code: snCode,
      quantity,
      unit_cost: unitCost,
      total_cost: money(unitCost * quantity),
      inventory_type: inventoryType,
      location_id: locationId,
      snRecord,
      remark: raw.remark || ''
    });
  }
  return rows;
}

async function buildConversionTargetRows(targetItems, conversionType, storeId, sourceRows, transaction) {
  if (!Array.isArray(targetItems) || targetItems.length === 0) {
    const label = conversionType === 'assemble' ? '组装成品' : '拆出商品';
    const err = new Error(`请添加${label}`);
    err.status = 400;
    throw err;
  }

  const defaultSourceSn = sourceRows.length === 1 ? sourceRows[0] : null;
  const rows = [];
  for (const raw of targetItems) {
    const productId = raw.productId || raw.product_id;
    const product = await Product.findByPk(productId, { transaction });
    if (!product || product.is_deleted === 1) {
      const err = new Error(`目标商品不存在：${productId || ''}`);
      err.status = 400;
      throw err;
    }

    const inventoryType = raw.inventoryType || raw.inventory_type || 'normal_qty';
    const locationId = raw.locationId || raw.location_id || '';
    const quantity = Number(product.need_sn) === 1 ? 1 : Math.max(1, parseInt(raw.quantity, 10) || 1);
    const unitCost = money(raw.unitCost ?? raw.unit_cost ?? 0);
    const totalCost = money(raw.totalCost ?? raw.total_cost ?? unitCost * quantity);
    const finalUnitCost = unitCost > 0 ? unitCost : money(totalCost / quantity);
    const pnCode = normalizePnCode(raw.pnCode || raw.pn_code || splitCodes(product.manufacturer_code)[0] || '');
    const snCode = String(raw.snCode || raw.sn_code || '').trim();

    if (totalCost <= 0 || finalUnitCost <= 0) {
      const err = new Error(`目标商品 ${product.name} 的成本必须大于0`);
      err.status = 400;
      throw err;
    }

    if (Number(product.need_sn) === 1) {
      if (!snCode) {
        const err = new Error(`目标商品 ${product.name} 需要SN管理，请录入SN`);
        err.status = 400;
        throw err;
      }
      const existingSn = await ProductSn.findOne({
        where: { pn_code: pnCode, sn_code: snCode, is_deleted: 0 },
        transaction
      });
      if (existingSn) {
        const err = new Error(`PN码 [${pnCode || '-'}] 下的SN码 [${snCode}] 已存在`);
        err.status = 400;
        throw err;
      }
    }

    rows.push({
      line_role: 'target',
      product,
      product_id: product.product_id,
      product_name: product.name,
      pn_code: pnCode,
      sn_id: null,
      sn_code: snCode,
      source_sn_id: raw.sourceSnId || raw.source_sn_id || defaultSourceSn?.sn_id || null,
      source_sn_code: raw.sourceSnCode || raw.source_sn_code || defaultSourceSn?.sn_code || '',
      quantity,
      unit_cost: finalUnitCost,
      total_cost: totalCost,
      inventory_type: inventoryType,
      location_id: locationId,
      remark: raw.remark || ''
    });
  }
  return rows;
}

async function createConversionItem(conversionId, row, transaction) {
  return InventoryConversionItem.create({
    conversion_id: conversionId,
    line_role: row.line_role,
    product_id: row.product_id || null,
    product_name: row.product_name || '',
    pn_code: row.pn_code || '',
    sn_id: row.sn_id || null,
    sn_code: row.sn_code || '',
    source_sn_id: row.source_sn_id || null,
    source_sn_code: row.source_sn_code || '',
    quantity: row.quantity || 1,
    unit_cost: row.unit_cost || 0,
    total_cost: row.total_cost || 0,
    inventory_type: row.inventory_type || 'normal_qty',
    location_id: row.location_id || '',
    remark: row.remark || ''
  }, { transaction });
}

async function getConversionList(ctx) {
  const { conversionType, status, storeId, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (conversionType) where.conversion_type = conversionType;
  if (status) where.status = status;
  if (storeId) where.store_id = storeId;

  const { count, rows } = await InventoryConversion.findAndCountAll({
    where,
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: InventoryConversionItem, as: 'items' }
    ],
    order: [['create_time', 'DESC']],
    limit: parseInt(pageSize, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(pageSize, 10),
    distinct: true
  });

  const list = rows.map(row => {
    const data = row.toJSON();
    const items = data.items || [];
    const sourceNames = items.filter(item => item.line_role === 'source').map(item => item.product_name || item.product_id);
    const targetNames = items.filter(item => item.line_role === 'target').map(item => item.product_name || item.product_id);
    return {
      ...data,
      store_name: data.Store?.name || data.store_id,
      source_summary: sourceNames.join('、'),
      target_summary: targetNames.join('、')
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function getConversionDetail(ctx) {
  const { conversionId } = ctx.params;
  const conversion = await InventoryConversion.findByPk(conversionId, {
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: InventoryConversionItem, as: 'items' }
    ]
  });
  if (!conversion) ctx.throw(404, '库存转换单不存在');

  const data = conversion.toJSON();
  ctx.body = {
    code: 0,
    data: {
      ...data,
      store_name: data.Store?.name || data.store_id
    }
  };
}

async function createConversion(ctx) {
  const t = await sequelize.transaction();
  try {
    const body = ctx.request.body || {};
    const user = ctx.state.user || {};
    const conversionType = normalizeConversionType(body.conversionType || body.conversion_type);
    const storeId = body.storeId || body.store_id;
    const serviceCost = conversionType === 'assemble' ? money(body.serviceCost ?? body.service_cost ?? 0) : 0;

    if (!storeId) ctx.throw(400, '请选择转换门店');
    if (serviceCost < 0) ctx.throw(400, '组装服务成本不能小于0');

    const store = await Store.findByPk(storeId, { transaction: t });
    if (!store) ctx.throw(400, '转换门店不存在');

    const sourceRows = await buildConversionSourceRows(body.sourceItems || body.source_items, conversionType, storeId, t);
    const targetRows = await buildConversionTargetRows(body.targetItems || body.target_items, conversionType, storeId, sourceRows, t);

    const totalSourceCost = money(sourceRows.reduce((sum, item) => sum + Number(item.total_cost || 0), 0));
    const totalTargetCost = money(targetRows.reduce((sum, item) => sum + Number(item.total_cost || 0), 0));
    const expectedTargetCost = money(totalSourceCost + serviceCost);
    if (conversionType === 'split') {
      if (sourceRows.length !== 1 || Number(sourceRows[0].quantity || 1) !== 1) {
        ctx.throw(400, '拆分单一次只能选择一个被拆商品，且数量必须为1');
      }
      if (totalTargetCost <= 0) {
        ctx.throw(400, '拆出商品价格合计必须大于0');
      }
      if (totalTargetCost - totalSourceCost > 0.01) {
        ctx.throw(400, `拆出商品价格合计 ${totalTargetCost} 不能超过被拆商品当前成本 ${totalSourceCost}`);
      }
    } else if (Math.abs(totalTargetCost - expectedTargetCost) > 0.01) {
      ctx.throw(400, `成本不守恒：目标成本 ${totalTargetCost} 必须等于来源成本 ${totalSourceCost}${serviceCost ? ` + 服务成本 ${serviceCost}` : ''}`);
    }

    const conversionId = generateUUID();
    const conversionNo = generateConversionNo(conversionType);
    await InventoryConversion.create({
      conversion_id: conversionId,
      conversion_no: conversionNo,
      conversion_type: conversionType,
      store_id: storeId,
      status: 'completed',
      total_source_cost: totalSourceCost,
      total_target_cost: totalTargetCost,
      service_cost: serviceCost,
      remark: body.remark || '',
      create_user: user.name || user.staffId || '',
      create_time: new Date()
    }, { transaction: t });

    const sourceStatus = conversionType === 'assemble' ? 'assembled' : 'split';
    const sourceAction = conversionType === 'assemble' ? 'inventory_assemble_source' : 'inventory_split_source';
    const targetAction = conversionType === 'assemble' ? 'inventory_assemble_target' : 'inventory_split_target';
    const splitRemainingCost = conversionType === 'split' ? money(totalSourceCost - totalTargetCost) : 0;

    for (const row of sourceRows) {
      if (row.snRecord) {
        const updatePayload = conversionType === 'split'
          ? { inbound_price: splitRemainingCost }
          : { status: sourceStatus };
        await row.snRecord.update(updatePayload, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: row.snRecord.sn_id,
          sn_code: row.snRecord.sn_code,
          product_id: row.product_id,
          product_name: row.product_name,
          store_id: storeId,
          action: sourceAction,
          remark: conversionType === 'split'
            ? `库存拆分来源成本调整，单号：${conversionNo}，拆分前成本：${totalSourceCost}，拆出金额：${totalTargetCost}，剩余成本：${splitRemainingCost}`
            : `库存组装来源，单号：${conversionNo}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      } else if (conversionType === 'split') {
        await setProductCostPrice(row.product_id, splitRemainingCost, user, t);
      }
      if (conversionType !== 'split') {
        await updateInventory(row.product_id, storeId, row.inventory_type, -Number(row.quantity || 1), t, row.location_id);
      }
      await createConversionItem(conversionId, {
        ...row,
        remark: conversionType === 'split'
          ? [row.remark, `拆分前成本:${totalSourceCost};拆出金额:${totalTargetCost};拆分后原商品成本:${splitRemainingCost}`].filter(Boolean).join(' ')
          : row.remark
      }, t);
    }

    for (const row of targetRows) {
      let snId = null;
      if (Number(row.product.need_sn) === 1) {
        await ensurePn(row.product_id, row.pn_code, t);
        snId = generateUUID();
        await ProductSn.create({
          sn_id: snId,
          product_id: row.product_id,
          pn_code: row.pn_code,
          sn_code: row.sn_code,
          status: 'in_stock',
          inventory_type: row.inventory_type,
          store_id: storeId,
          location_id: row.location_id || null,
          inbound_time: new Date(),
          inbound_price: row.unit_cost,
          original_pickup_price: row.unit_cost,
          batch_no: conversionNo,
          remark: `库存${conversionType === 'assemble' ? '组装' : '拆分'}生成，单号：${conversionNo}`,
          is_deleted: 0
        }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: snId,
          sn_code: row.sn_code,
          product_id: row.product_id,
          product_name: row.product_name,
          store_id: storeId,
          action: targetAction,
          remark: `库存${conversionType === 'assemble' ? '组装' : '拆分'}生成，单号：${conversionNo}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(row.product_id, storeId, row.inventory_type, Number(row.quantity || 1), t, row.location_id);
      await createConversionItem(conversionId, { ...row, sn_id: snId }, t);
    }

    if (serviceCost > 0) {
      await createConversionItem(conversionId, {
        line_role: 'service',
        product_name: '组装服务成本',
        quantity: 1,
        unit_cost: serviceCost,
        total_cost: serviceCost,
        remark: body.serviceRemark || body.service_remark || ''
      }, t);
    }

    await t.commit();
    ctx.body = { code: 0, data: { conversionId, conversionNo }, message: '库存转换已完成' };
  } catch (error) {
    await t.rollback();
    if (error.status) ctx.throw(error.status, error.message);
    console.error('createConversion error:', error);
    ctx.throw(500, error.message || '库存转换失败');
  }
}

async function voidConversion(ctx) {
  const t = await sequelize.transaction();
  try {
    const { conversionId } = ctx.params;
    const { reason = '' } = ctx.request.body || {};
    const user = ctx.state.user || {};
    const conversion = await InventoryConversion.findByPk(conversionId, {
      include: [{ model: InventoryConversionItem, as: 'items' }],
      transaction: t
    });
    if (!conversion) ctx.throw(404, '库存转换单不存在');
    if (conversion.status === 'voided') ctx.throw(400, '该转换单已冲销');

    const items = conversion.items || [];
    const targetItems = items.filter(item => item.line_role === 'target');
    const sourceItems = items.filter(item => item.line_role === 'source');

    for (const item of targetItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        if (!sn || sn.status !== 'in_stock') {
          ctx.throw(400, `目标SN ${item.sn_code || item.sn_id} 已被销售、占用或不存在，不能冲销`);
        }
      } else {
        const available = await getAvailableQty(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', item.location_id || '', t);
        if (available < Number(item.quantity || 1)) {
          ctx.throw(400, `目标商品 ${item.product_name || item.product_id} 库存不足，不能冲销`);
        }
      }
    }

    const reverseAction = conversion.conversion_type === 'assemble' ? 'inventory_assemble_void' : 'inventory_split_void';

    for (const item of targetItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        await sn.update({ status: 'voided' }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          product_name: item.product_name,
          store_id: conversion.store_id,
          action: reverseAction,
          remark: `库存转换冲销，单号：${conversion.conversion_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }
      await updateInventory(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', -Number(item.quantity || 1), t, item.location_id || '');
    }

    for (const item of sourceItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        if (sn) {
          const sourceUpdate = conversion.conversion_type === 'split'
            ? { inbound_price: money(item.unit_cost || 0) }
            : { status: 'in_stock' };
          await sn.update(sourceUpdate, { transaction: t });
          await SnLog.create({
            log_id: generateUUID(),
            sn_id: item.sn_id,
            sn_code: item.sn_code,
            product_id: item.product_id,
            product_name: item.product_name,
            store_id: conversion.store_id,
            action: reverseAction,
            remark: conversion.conversion_type === 'split'
              ? `库存拆分冲销恢复来源SN成本，单号：${conversion.conversion_no}，恢复成本：${money(item.unit_cost || 0)}`
              : `库存转换冲销恢复来源SN，单号：${conversion.conversion_no}`,
            create_user: user.name || user.staffId
          }, { transaction: t });
        }
      } else if (conversion.conversion_type === 'split' && item.product_id) {
        await setProductCostPrice(item.product_id, item.unit_cost || 0, user, t);
      }
      if (conversion.conversion_type !== 'split') {
        await updateInventory(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', Number(item.quantity || 1), t, item.location_id || '');
      }
    }

    await conversion.update({
      status: 'voided',
      void_reason: reason,
      void_user: user.name || user.staffId || '',
      void_time: new Date()
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '库存转换单已冲销' };
  } catch (error) {
    await t.rollback();
    if (error.status) ctx.throw(error.status, error.message);
    console.error('voidConversion error:', error);
    ctx.throw(500, error.message || '库存转换冲销失败');
  }
}

async function getReturnStockWithItems(returnId, transaction) {
  return ReturnStock.findByPk(returnId, {
    include: [{ model: ReturnStockItem, as: 'items' }],
    transaction
  });
}

/**
 * 查询退库申请列表
 */
async function getReturnList(ctx) {
  const { status, inboundId, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (status) where.status = status;
  if (inboundId) where.inbound_id = inboundId;

  const { count, rows } = await ReturnStock.findAndCountAll({
    where,
    include: [{ model: ReturnStockItem, as: 'items' }],
    order: [[sequelize.literal("CASE WHEN STATUS = 'pending' THEN 0 WHEN STATUS = 'approved' THEN 1 ELSE 2 END"), 'ASC'], ['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  const storeIds = [...new Set(rows.map(row => row.store_id).filter(Boolean))];
  const stores = storeIds.length > 0
    ? await Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'name'] })
    : [];
  const storeMap = new Map(stores.map(store => [store.store_id, store.name]));

  const list = rows.map(row => {
    const data = row.toJSON();
    return {
      ...data,
      store_name: storeMap.get(data.store_id) || ''
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

/**
 * 发起退库申请
 */
async function requestReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { inboundId, reason } = ctx.request.body;
    const user = ctx.state.user;

    const inbound = await Inbound.findByPk(inboundId, { transaction: t });
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (inbound.status !== 'completed') ctx.throw(400, '只有已完成的入库单才能发起退库申请');

    const activeReturn = await ReturnStock.findOne({
      where: {
        inbound_id: inboundId,
        status: { [Op.in]: ['pending', 'approved'] }
      },
      transaction: t
    });
    if (activeReturn) {
      ctx.throw(400, '该入库单已有待处理的退库申请');
    }

    const items = await InboundItem.findAll({
      where: { inbound_id: inboundId },
      transaction: t
    });
    if (items.length === 0) ctx.throw(400, '该入库单没有商品明细');

    const productIds = items.map(item => item.product_id);
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds } }
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    const request = inbound.purchase_request_id
      ? await PurchaseRequest.findByPk(inbound.purchase_request_id, { transaction: t })
      : null;
    const supplier = request?.supplier_id
      ? await Supplier.findByPk(request.supplier_id, { transaction: t })
      : null;

    let totalQuantity = 0;
    let totalAmount = 0;

    const returnId = generateUUID();
    const returnNo = generateReturnNo();

    await ReturnStock.create({
      return_id: returnId,
      return_no: returnNo,
      inbound_id: inboundId,
      inbound_no: inbound.inbound_no,
      store_id: inbound.store_id,
      purchase_request_id: inbound.purchase_request_id || '',
      supplier_id: request?.supplier_id || '',
      supplier_name: supplier?.name || '',
      total_quantity: 0,
      total_amount: 0,
      reason: reason || '',
      status: 'pending',
      create_user: user.name || user.staffId,
      create_time: new Date()
    }, { transaction: t });

    for (const item of items) {
      const product = productMap.get(item.product_id);
      const quantity = item.quantity || 1;
      const inventoryType = item.inventory_type || 'normal_qty';
      totalQuantity += quantity;
      totalAmount += (Number(item.unit_price) || 0) * quantity;

      if (product && product.need_sn === 1) {
        const snRecords = await ProductSn.findAll({
          where: {
            product_id: item.product_id,
            ...(item.pn_code ? { pn_code: item.pn_code } : {}),
            store_id: inbound.store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          order: [['inbound_time', 'ASC']],
          limit: quantity,
          transaction: t
        });
        if (snRecords.length < quantity) {
          ctx.throw(400, `商品 ${item.product_name || item.product_id} 当前在库SN数量不足，不能发起退库`);
        }

        for (const snRecord of snRecords) {
          await ReturnStockItem.create({
            return_id: returnId,
            product_id: item.product_id,
            product_name: item.product_name || '',
            pn_code: snRecord.pn_code || item.pn_code || '',
            sn_code: snRecord.sn_code || '',
            sn_id: snRecord.sn_id,
            quantity: 1,
            unit_price: item.unit_price,
            location_id: snRecord.location_id || item.location_id || '',
            inventory_type: snRecord.inventory_type || inventoryType,
            product_type: item.product_type || '',
            remark: ''
          }, { transaction: t });
        }
      } else {
        await ReturnStockItem.create({
          return_id: returnId,
          product_id: item.product_id,
          product_name: item.product_name || '',
          pn_code: item.pn_code || '',
          sn_code: '',
          sn_id: null,
          quantity: quantity,
          unit_price: item.unit_price,
          location_id: item.location_id || '',
          inventory_type: inventoryType,
          product_type: item.product_type || '',
          remark: ''
        }, { transaction: t });
      }
    }

    await ReturnStock.update(
      { total_quantity: totalQuantity, total_amount: totalAmount },
      { where: { return_id: returnId }, transaction: t }
    );

    await t.commit();
    ctx.body = { code: 0, returnId, returnNo, message: '退库申请已提交，待审批' };
  } catch (error) {
    await t.rollback();
    console.error('Error in requestReturn:', error);
    throw error;
  }
}

/**
 * 审批退库申请
 */
async function approveReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { returnId, action = 'approved', comment = '' } = ctx.request.body;
    const user = ctx.state.user;

    const returnStock = await ReturnStock.findByPk(returnId, { transaction: t });
    if (!returnStock) ctx.throw(404, '退库申请不存在');
    if (returnStock.status !== 'pending') ctx.throw(400, '只有待审批的退库申请才能审批');

    const nextStatus = action === 'rejected' ? 'rejected' : 'approved';
    await returnStock.update({
      status: nextStatus,
      approve_user: user.name || user.staffId,
      approve_comment: comment || '',
      approve_time: new Date()
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: nextStatus === 'approved' ? '退库申请已通过' : '退库申请已拒绝' };
  } catch (error) {
    await t.rollback();
    console.error('Error in approveReturn:', error);
    throw error;
  }
}

/**
 * 执行已审批退库
 */
async function executeReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { returnId } = ctx.request.body;
    const user = ctx.state.user;

    const returnStock = await getReturnStockWithItems(returnId, t);
    if (!returnStock) ctx.throw(404, '退库申请不存在');
    if (returnStock.status !== 'approved') ctx.throw(400, '只有已审批通过的退库申请才能执行退库');

    const inbound = await Inbound.findByPk(returnStock.inbound_id, { transaction: t });
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (inbound.status !== 'completed') ctx.throw(400, '当前入库单状态不能执行退库');

    const items = returnStock.items || [];
    if (items.length === 0) ctx.throw(400, '退库申请没有商品明细');

    for (const item of items) {
      const quantity = Number(item.quantity || 1);
      const inventoryType = item.inventory_type || 'normal_qty';
      const locationId = item.location_id || '';

      if (item.sn_id) {
        const snRecord = await ProductSn.findOne({
          where: {
            sn_id: item.sn_id,
            store_id: returnStock.store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!snRecord) {
          ctx.throw(400, `SN ${item.sn_code || item.sn_id} 当前不在库，不能执行退库`);
        }

        await snRecord.update({
          status: 'returned',
          remark: `${snRecord.remark || ''} [退库:${returnStock.return_no}]`
        }, { transaction: t });

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          product_name: item.product_name || '',
          store_id: returnStock.store_id,
          action: 'return',
          remark: `采购退库：${returnStock.return_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, returnStock.store_id, inventoryType, -quantity, t, locationId);

      if (inventoryType === 'normal_qty' && item.product_type) {
        const typeField = getProductTypeInventoryField(item.product_type);
        if (typeField) {
          await updateInventory(item.product_id, returnStock.store_id, typeField, -quantity, t, locationId);
        }
      }
    }

    let payableId = '';
    if (returnStock.supplier_id) {
      payableId = generateUUID();
      await Payable.create({
        payable_id: payableId,
        supplier_id: returnStock.supplier_id,
        supplier_name: returnStock.supplier_name || '',
        request_id: returnStock.return_id,
        request_no: returnStock.return_no,
        total_amount: -Math.abs(Number(returnStock.total_amount || 0)),
        paid_amount: 0,
        status: 'unpaid',
        create_time: new Date()
      }, { transaction: t });
    }

    await returnStock.update({
      status: 'completed',
      execute_user: user.name || user.staffId,
      execute_time: new Date(),
      payable_id: payableId
    }, { transaction: t });

    await inbound.update({ status: 'returned', update_time: new Date() }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, returnId, payableId, message: '退库已执行，已生成负向应付' };
  } catch (error) {
    await t.rollback();
    console.error('Error in executeReturn:', error);
    throw error;
  }
}

/**
 * 获取指定门店的库位列表
 */
async function getLocationsByStore(ctx) {
  try {
    const { storeId } = ctx.params;
    const locations = await Location.findAll({
      where: { store_id: storeId, status: 1 },
      order: [['name', 'ASC']]
    });
    ctx.body = { code: 0, data: locations };
  } catch (error) {
    console.error('Error in getLocationsByStore:', error);
    throw error;
  }
}

module.exports = {
  getList,
  getSnList,
  getInboundList,
  getInboundDetail,
  executeInbound,
  getReturnList,
  requestReturn,
  approveReturn,
  executeReturn,
  inbound,
  outbound,
  transfer,
  getTransferList,
  confirmTransferOut,
  confirmTransferIn,
  getConversionList,
  getConversionDetail,
  createConversion,
  voidConversion,
  getLocationsByStore,
  updateSn,
  snTrace
};
