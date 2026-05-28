/**
 * 库房管理控制器
 * 优化版：非SN商品直接操作聚合库存，SN商品同时维护SN记录和聚合库存
 */
const { sequelize, ProductSn, Product, ProductPn, ProductPrice, ProductBarcode, Store, Location, InventoryWarning, Inbound, InboundItem, ReturnStock, ReturnStockItem, PurchaseRequest, Payable, Supplier, Inventory, SnLog, Order, OrderItem, Transfer, TransferItem } = require('../../models');
const { Op } = require('sequelize');
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

    const { count, rows: products } = await Product.findAndCountAll({
      where: productWhere,
      include: [{ model: ProductPrice, attributes: ['standard_price'] }],
      order: [['create_time', 'DESC']],
      ...paginate({}, { page, pageSize })
    });

    const productIds = products.map(p => p.product_id);

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
        storeStockMap[inv.product_id].push({
          store_id: inv.store_id,
          store_name: storeName,
          location_id: '',
          location_name: '未指定库位',
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

    const rows = products.map(p => {
      const inv = invMap[p.product_id] || {
        normal_qty: 0, regular_qty: 0, subsidy_qty: 0, second_qty: 0, display_qty: 0, demo_qty: 0, unsellable_qty: 0, pending_qty: 0
      };
      return {
        product_id: p.product_id,
        category: p.category || '',
        product_name: p.name || '',
        spec: p.config || '',
        product_code: p.product_code || '',
        manufacturer_code: p.manufacturer_code || '',
        standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
        need_sn: p.need_sn || 0,
        normal_qty: inv.normal_qty,
        regular_qty: inv.regular_qty,
        subsidy_qty: inv.subsidy_qty,
        second_qty: inv.second_qty,
        display_qty: inv.display_qty,
        demo_qty: inv.demo_qty,
        unsellable_qty: inv.unsellable_qty,
        pending_qty: inv.pending_qty,
        store_stock_info: storeStockMap[p.product_id] || []
      };
    });

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
    const { productId, storeId, status, snCode, page = 1, pageSize = 20 } = ctx.query;

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
        sn.dataValues.Product = await Product.findByPk(sn.product_id, { attributes: ['name', 'category', 'need_sn'] });
      }
      if (sn.store_id) {
        sn.dataValues.Store = await Store.findByPk(sn.store_id, { attributes: ['name', 'region_id'] });
      }
      if (sn.location_id) {
        sn.dataValues.Location = await Location.findByPk(sn.location_id, { attributes: ['name'] });
      }
    }

    const flatRows = rows.map(row => {
      const data = row.toJSON();
      return {
        ...data,
        product_name: data.Product?.name || '',
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
      where: { sn_code: newSnCode.trim(), is_deleted: 0 }
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

    const sn = await ProductSn.findOne({
      where: { sn_code: snCode, is_deleted: 0 }
    });

    ctx.body = {
      code: 0,
      data: {
        snCode,
        currentStatus: sn ? sn.status : 'unknown',
        productId: sn ? sn.product_id : '',
        productName: sn ? sn.product_name : '',
        storeId: sn ? sn.store_id : '',
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
async function updateInventory(productId, storeId, field, delta, transaction) {
  let inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });

  if (!inv) {
    inv = await Inventory.create({
      inventory_id: generateUUID(),
      product_id: productId,
      store_id: storeId,
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

/**
 * 执行入库
 */
async function executeInbound(ctx) {
  const VALID_INVENTORY_TYPES = ['normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty'];
  const PRODUCT_TYPE_TO_FIELD = {
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

      if (product.need_sn === 1) {
        if (!item.snCode || item.snCode.trim() === '') {
          ctx.throw(400, `商品 ${dbItem.product_name} 需要SN管理，SN码不能为空`);
        }

        const pnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');

        const existingSn = await ProductSn.findOne({
          where: { sn_code: item.snCode, is_deleted: 0 },
          transaction: t
        });
        if (existingSn) {
          ctx.throw(400, `SN码 [${item.snCode}] 已存在`);
        }

        await ProductSn.create({
          sn_id: generateUUID(),
          product_id: dbItem.product_id,
          product_name: dbItem.product_name || '',
          pn_code: pnCode,
          sn_code: item.snCode,
          status: 'in_stock',
          inventory_type: inventoryType,
          store_id: inbound.store_id,
          location_id: locationId,
          inbound_time: new Date(),
          inbound_price: dbItem.unit_price,
          remark: item.remark || '',
          is_deleted: 0
        }, { transaction: t });

        await dbItem.update({
          sn_code: item.snCode,
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
          inventory_type: inventoryType
        }, { transaction: t });
      } else {
        const pnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');

        await dbItem.update({
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
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

      await updateInventory(item.productId, inbound.store_id, inventoryType, quantity, t);

      if (inventoryType === 'normal_qty' && dbItem.product_type) {
        const typeField = PRODUCT_TYPE_TO_FIELD[dbItem.product_type];
        if (typeField) {
          await updateInventory(item.productId, inbound.store_id, typeField, quantity, t);
        }
      }
    }

    await inbound.update({ status: 'completed', update_time: new Date() }, { transaction: t });

    if (inbound.purchase_request_id) {
      const allInbounds = await Inbound.findAll({
        where: { purchase_request_id: inbound.purchase_request_id },
        transaction: t
      });
      const request = await PurchaseRequest.findByPk(inbound.purchase_request_id, { transaction: t });
      if (request && request.supplier_id) {
        const completedInbounds = allInbounds.filter(ib => ib.status === 'completed');
        const completedAmount = completedInbounds.reduce((sum, ib) => sum + parseFloat(ib.total_amount || 0), 0);
        const allCompleted = allInbounds.length > 0 && allInbounds.every(ib => ib.status === 'completed');
        const rebateDeduction = parseFloat(request.rebate_deduction || 0);
        const totalAmount = allCompleted && rebateDeduction > 0
          ? parseFloat(request.actual_total || completedAmount)
          : completedAmount;

        if (totalAmount > 0) {
          const existingPayable = await Payable.findOne({
            where: { request_id: inbound.purchase_request_id },
            transaction: t
          });
          if (existingPayable) {
            if (existingPayable.status !== 'paid') {
              await existingPayable.update({
                total_amount: totalAmount,
                paid_amount: existingPayable.status === 'unpaid' ? 0 : existingPayable.paid_amount
              }, { transaction: t });
            }
          } else {
            const supplier = await Supplier.findByPk(request.supplier_id, { transaction: t });
            await Payable.create({
              payable_id: generateUUID(),
              supplier_id: request.supplier_id,
              supplier_name: supplier ? supplier.name : '',
              request_id: inbound.purchase_request_id,
              request_no: request.request_no,
              total_amount: totalAmount,
              paid_amount: 0,
              status: 'unpaid',
              create_time: new Date()
            }, { transaction: t });
          }
        }
      }
    }

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
    const { fromStoreId, toStoreId, items } = ctx.request.body;

    if (!fromStoreId || !toStoreId) {
      ctx.throw(400, '调出门店和调入门店不能为空');
    }
    if (fromStoreId === toStoreId) {
      ctx.throw(400, '调出门店和调入门店不能相同');
    }
    if (!items || items.length === 0) {
      ctx.throw(400, '调拨商品不能为空');
    }

    const transferNo = generateTransferNo();
    const transferId = generateUUID();
    const totalQuantity = items.reduce((sum, item) => sum + (item.quantity || 1), 0);

    await Transfer.create({
      transfer_id: transferId,
      transfer_no: transferNo,
      from_store_id: fromStoreId,
      to_store_id: toStoreId,
      total_quantity: totalQuantity,
      status: 'pending',
      apply_user: user.name || user.staffId
    }, { transaction: t });

    for (const item of items) {
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
          remark: `调拨申请：${fromStoreId} → ${toStoreId}，单号：${transferNo}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }
    }

    await t.commit();
    ctx.body = { code: 0, data: { transferId, transferNo }, message: '调拨申请已创建' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('transfer error:', err);
    ctx.throw(500, '创建调拨申请失败');
  }
}

/**
 * 调拨列表
 */
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

    const list = rows.map(row => {
      const data = row.toJSON();
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

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }]
    });

    if (!transfer) {
      ctx.throw(404, '调拨单不存在');
    }
    if (transfer.status !== 'pending') {
      ctx.throw(400, '当前状态不允许确认出库');
    }

    const items = transfer.TransferItems || [];

    for (const item of items) {
      if (item.sn_id && item.sn_code) {
        await ProductSn.update(
          { status: 'transferring' },
          { where: { sn_id: item.sn_id }, transaction: t }
        );

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          store_id: transfer.from_store_id,
          action: 'transfer_out_confirm',
          remark: `调拨出库确认：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, transfer.from_store_id, 'normal_qty', -(item.quantity || 1), t);
    }

    await transfer.update({
      status: 'out_confirmed',
      confirm_user: user.name || user.staffId
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '调拨出库确认成功' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferOut error:', err);
    ctx.throw(500, '确认调拨出库失败');
  }
}

/**
 * 确认调拨入库（目标门店操作）
 */
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

/**
 * 执行退库
 */
async function executeReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { inboundId, reason } = ctx.request.body;
    const user = ctx.state.user;

    const inbound = await Inbound.findByPk(inboundId, { transaction: t });
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (inbound.status !== 'completed') ctx.throw(400, '只有已完成的入库单才能退库');

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

    const allProductSns = await ProductSn.findAll({
      where: { store_id: inbound.store_id, status: 'in_stock', is_deleted: 0 },
      transaction: t
    });

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
      total_quantity: 0,
      total_amount: 0,
      reason: reason || '',
      create_user: user.name,
      create_time: new Date()
    }, { transaction: t });

    const snMap = new Map();
    allProductSns.forEach(sn => {
      if (!snMap.has(sn.product_id)) snMap.set(sn.product_id, []);
      snMap.get(sn.product_id).push(sn);
    });

    for (const item of items) {
      const product = productMap.get(item.product_id);
      const quantity = item.quantity || 1;
      const inventoryType = item.inventory_type || 'normal_qty';
      totalQuantity += quantity;
      totalAmount += (Number(item.unit_price) || 0) * quantity;

      if (product && product.need_sn === 1 && item.sn_code) {
        const snCode = item.sn_code;
        const snRecord = await ProductSn.findOne({
          where: { sn_code: snCode, store_id: inbound.store_id, status: 'in_stock', is_deleted: 0 },
          transaction: t
        });

        await ReturnStockItem.create({
          return_id: returnId,
          product_id: item.product_id,
          product_name: item.product_name || '',
          pn_code: item.pn_code || '',
          sn_code: snCode,
          sn_id: snRecord ? snRecord.sn_id : null,
          quantity: 1,
          unit_price: item.unit_price,
          remark: ''
        }, { transaction: t });

        if (snRecord) {
          await snRecord.update({ status: 'returned', remark: (snRecord.remark || '') + ' [退库]' }, { transaction: t });
        }

        await updateInventory(item.product_id, inbound.store_id, inventoryType, -1, t);
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
          remark: ''
        }, { transaction: t });

        await updateInventory(item.product_id, inbound.store_id, inventoryType, -quantity, t);
      }
    }

    await ReturnStock.update(
      { total_quantity: totalQuantity, total_amount: totalAmount },
      { where: { return_id: returnId }, transaction: t }
    );

    await inbound.update({ status: 'returned', update_time: new Date() }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, returnId, returnNo, message: '退库成功' };
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
  executeReturn,
  inbound,
  outbound,
  transfer,
  getTransferList,
  confirmTransferOut,
  confirmTransferIn,
  getLocationsByStore,
  updateSn,
  snTrace
};
