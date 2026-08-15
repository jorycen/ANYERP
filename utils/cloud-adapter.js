const api = require('./api.js');
const { normalizeId, normalizeMoney, normalizeSnCode } = require('./model.js');

const MYSQL_FUNCTIONS = [
  'queryOrders',
  'queryGoods',
  'updateOrder',
  'updateOrderRemark',
  'getDailySummary',
  'exportOrders'
];

const CLOUD_UTILITY_FUNCTIONS = [
  'paddleOCR',
  'listCloudFiles',
  'testGuanghuanApi',
  'orderItemRepair'
];

function runWithCallbacks(promise, options) {
  if (!options || typeof options !== 'object') return promise;
  return promise.then(res => {
    if (typeof options.success === 'function') options.success(res);
    if (typeof options.complete === 'function') options.complete(res);
    return res;
  }).catch(err => {
    if (typeof options.fail === 'function') options.fail(err);
    if (typeof options.complete === 'function') options.complete(err);
    throw err;
  });
}

function getList(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  if (Array.isArray(result.list)) return result.list;
  return [];
}

function normalizeProduct(item) {
  const productId = normalizeId(item._id || item.productId || item.product_id || item.inventoryId || item.inventory_id);
  const standardPrice = normalizeMoney(item.standardPrice || item.standard_price || item.price || item.PRICE || 0);
  const minSalePrice = normalizeMoney(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price ||
    item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price ||
    item.floorPrice || item.floor_price || 0);
  return {
    _id: productId,
    productId,
    name: item.name || item.NAME || item.productName || item.product_name || '',
    pnCode: item.pnCode || '',
    snCode: normalizeSnCode(item.snCode || item.SN || item.sn_code || item.sn),
    price: normalizeMoney(item.price || item.PRICE || standardPrice),
    standardPrice,
    standard_price: standardPrice,
    minSalePrice,
    min_sale_price: minSalePrice,
    needSn: item.needSn !== undefined ? item.needSn : !!item.need_sn
  };
}

function normalizeStore(item) {
  return Object.assign({}, item, {
    _id: item._id || item.storeId || item.store_id || item.id || '',
    storeId: item.storeId || item.store_id || item.id || '',
    store_id: item.store_id || item.storeId || item.id || '',
    staffList: item.staffList || []
  });
}

function normalizeOrder(item) {
  return Object.assign({}, item, {
    _id: item._id || item.orderId || item.order_id || '',
    orderId: item.orderId || item.order_id || '',
    orderNo: item.orderNo || item.order_no || '',
    order_no: item.order_no || item.orderNo || ''
  });
}

function normalizeWhere(where) {
  if (!where || typeof where !== 'object') return {};
  const result = {};
  Object.keys(where).forEach(key => {
    const value = where[key];
    if (value && typeof value === 'object' && value.__anyerpCommand) {
      result[key] = value;
    } else {
      result[key] = value;
    }
  });
  return result;
}

function valueOf(item, key) {
  const aliases = {
    _id: ['_id', 'id', 'orderId', 'order_id', 'productId', 'product_id', 'storeId', 'store_id', 'sourceId', 'methodId', 'itemId'],
    orderNo: ['orderNo', 'order_no'],
    storeId: ['storeId', 'store_id'],
    productId: ['productId', 'product_id'],
    name: ['name', 'NAME', 'product_name'],
    NAME: ['NAME', 'name', 'product_name'],
    pnCode: ['pnCode'],
    SN: ['SN', 'sn_code']
  };
  const keys = aliases[key] || [key];
  for (let i = 0; i < keys.length; i += 1) {
    if (item[keys[i]] !== undefined) return item[keys[i]];
  }
  return undefined;
}

function matchCommand(actual, command) {
  const op = command.op;
  const expected = command.value;
  if (op === 'in') return (expected || []).map(String).indexOf(String(actual)) >= 0;
  if (op === 'neq') return String(actual) !== String(expected);
  if (op === 'gte') return actual >= expected;
  if (op === 'lte') return actual <= expected;
  if (op === 'regex') return new RegExp(expected, command.options || '').test(String(actual || ''));
  return true;
}

function matchesWhere(item, where) {
  const normalized = normalizeWhere(where);
  const keys = Object.keys(normalized);
  if (!keys.length) return true;

  return keys.every(key => {
    const expected = normalized[key];
    const actual = valueOf(item, key);

    if (expected && expected.__anyerpCommand) {
      return matchCommand(actual, expected);
    }
    if (expected instanceof RegExp) {
      return expected.test(String(actual || ''));
    }
    if (expected && typeof expected === 'object') {
      if (expected.$regex) return new RegExp(expected.$regex, expected.$options || '').test(String(actual || ''));
      if (expected.$in) return expected.$in.map(String).indexOf(String(actual)) >= 0;
    }
    return expected === undefined || String(actual) === String(expected);
  });
}

function applyQueryState(rows, state) {
  let list = rows.filter(item => matchesWhere(item, state.where));
  if (state.orderBy && state.orderBy.field) {
    const field = state.orderBy.field;
    const dir = String(state.orderBy.direction || 'asc').toLowerCase();
    list = list.slice().sort((a, b) => {
      const av = valueOf(a, field);
      const bv = valueOf(b, field);
      if (av === bv) return 0;
      return av > bv ? (dir === 'desc' ? -1 : 1) : (dir === 'desc' ? 1 : -1);
    });
  }
  if (state.skip) list = list.slice(state.skip);
  if (state.limit) list = list.slice(0, state.limit);
  return list;
}

function keywordFromWhere(where) {
  const keys = ['keyword', 'keywords', 'name', 'NAME', 'pnCode', 'SN', 'snCode'];
  for (let i = 0; i < keys.length; i += 1) {
    const value = where && where[keys[i]];
    if (value instanceof RegExp) return value.source;
    if (value && value.__anyerpCommand && value.op === 'regex') return value.value;
    if (value && value.$regex) return value.$regex;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function fetchCollection(name, state) {
  const where = normalizeWhere(state.where);
  const limit = state.limit || 100;

  if (name === 'goods' || name === 'products') {
    const keyword = keywordFromWhere(where);
    const source = keyword
      ? api.product.search(keyword, { page: 1, pageSize: limit, storeId: where.storeId || where.store_id || '' })
      : api.product.list({ page: 1, pageSize: limit, storeId: where.storeId || where.store_id || '' });
    return source.then(rows => applyQueryState(rows.map(normalizeProduct), state));
  }

  if (name === 'inventory') {
    return api.inventory.list({
      storeId: where.storeId || where.store_id,
      keyword: keywordFromWhere(where),
      page: 1,
      pageSize: limit
    }).then(res => applyQueryState(getList(res).map(normalizeProduct), state));
  }

  if (name === 'orders') {
    return api.order.queryList({
      orderNo: where.orderNo || where.order_no,
      storeId: where.storeId || where.store_id,
      customerPhone: where.customerPhone || where.customer_phone,
      page: 1,
      pageSize: limit
    }).then(res => applyQueryState(getList(res).map(normalizeOrder), state));
  }

  if (name === 'stores') {
    return api.store.getStores(where.distributorId || where.distributor_id)
      .then(res => applyQueryState(getList(res).map(normalizeStore), state));
  }

  if (name === 'distributors') {
    return api.store.getDistributor(where.distributorId || where._id)
      .then(res => {
        const data = res && res.data ? [Object.assign({ _id: res.data.distributorId || res.data.id }, res.data)] : [];
        return applyQueryState(data, state);
      });
  }

  if (name === 'customerSources') {
    return api.dict.getCustomerSources().then(rows => applyQueryState(rows, state));
  }

  if (name === 'paymentMethods') {
    return api.dict.getPaymentMethods(where.storeId || where.store_id).then(rows => applyQueryState(rows, state));
  }

  if (name === 'supplementItems') {
    return api.dict.getSupplementItems().then(rows => applyQueryState(rows, state));
  }

  if (name === 'transferRequests' || name === 'inventoryTransfers' || name === 'transfers') {
    return api.inventory.transferList({
      status: where.status,
      fromStoreId: where.fromStoreId || where.from_store_id,
      toStoreId: where.toStoreId || where.to_store_id,
      page: 1,
      pageSize: limit
    }).then(res => applyQueryState(getList(res), state));
  }

  return Promise.reject(new Error('Collection has been migrated to MySQL and is not mapped: ' + name));
}

function addCollection(name, data) {
  if (name === 'goods' || name === 'products') return api.product.saveLegacyGoods(data);
  if (name === 'orders') return api.order.create(data);
  if (name === 'stores') return api.store.create(data);
  if (name === 'customerSources') return api.dict.saveCustomerSource(data);
  if (name === 'paymentMethods') return api.dict.savePaymentMethod(data);
  if (name === 'supplementItems') return api.dict.saveSupplementItem(data);
  if (name === 'transferRequests' || name === 'inventoryTransfers' || name === 'transfers') return api.inventory.transfer(data);
  return Promise.reject(new Error('Collection add has no MySQL mapping: ' + name));
}

function updateDocument(name, id, data) {
  if (name === 'goods' || name === 'products') return api.product.update(id, data);
  if (name === 'orders') return api.order.update(id, data).catch(() => api.order.updateByOrderNo(id, data));
  if (name === 'stores') return api.store.update(id, data);
  if (name === 'customerSources') return api.dict.saveCustomerSource(Object.assign({}, data, { id }));
  if (name === 'paymentMethods') return api.dict.savePaymentMethod(Object.assign({}, data, { id }));
  if (name === 'supplementItems') return api.dict.saveSupplementItem(Object.assign({}, data, { id }));
  return Promise.reject(new Error('Collection update has no MySQL mapping: ' + name));
}

function removeDocument(name, id) {
  if (name === 'stores') return api.store.delete(id);
  if (name === 'customerSources') return api.dict.deleteCustomerSource(id);
  if (name === 'paymentMethods') return api.dict.deletePaymentMethod(id);
  if (name === 'supplementItems') return api.dict.deleteSupplementItem(id);
  return Promise.reject(new Error('Collection remove has no MySQL mapping: ' + name));
}

function createQuery(name, state) {
  state = state || { where: {}, skip: 0, limit: 0, orderBy: null };
  return {
    where(condition) {
      return createQuery(name, Object.assign({}, state, {
        where: Object.assign({}, state.where || {}, condition || {})
      }));
    },
    orderBy(field, direction) {
      return createQuery(name, Object.assign({}, state, { orderBy: { field, direction } }));
    },
    skip(value) {
      return createQuery(name, Object.assign({}, state, { skip: Number(value || 0) }));
    },
    limit(value) {
      return createQuery(name, Object.assign({}, state, { limit: Number(value || 0) }));
    },
    field() {
      return createQuery(name, state);
    },
    get(options) {
      const promise = fetchCollection(name, state).then(rows => ({ data: rows }));
      return runWithCallbacks(promise, options);
    },
    count(options) {
      const promise = fetchCollection(name, state).then(rows => ({ total: rows.length }));
      return runWithCallbacks(promise, options);
    },
    add(options = {}) {
      const promise = addCollection(name, options.data || {}).then(res => ({
        _id: res._id || res.id || res.productId || res.orderId || res.storeId || res.transferId || ''
      }));
      return runWithCallbacks(promise, options);
    },
    doc(id) {
      return createDoc(name, id);
    }
  };
}

function createDoc(name, id) {
  return {
    get(options) {
      const promise = fetchCollection(name, {
        where: { _id: id },
        skip: 0,
        limit: 1,
        orderBy: null
      }).then(rows => ({ data: rows[0] || null }));
      return runWithCallbacks(promise, options);
    },
    update(options = {}) {
      const promise = updateDocument(name, id, options.data || {}).then(res => ({ stats: { updated: 1 }, data: res }));
      return runWithCallbacks(promise, options);
    },
    remove(options = {}) {
      const promise = removeDocument(name, id).then(res => ({ stats: { removed: 1 }, data: res }));
      return runWithCallbacks(promise, options);
    }
  };
}

function createCommand() {
  return {
    in(value) {
      return { __anyerpCommand: true, op: 'in', value };
    },
    neq(value) {
      return { __anyerpCommand: true, op: 'neq', value };
    },
    gte(value) {
      return { __anyerpCommand: true, op: 'gte', value };
    },
    lte(value) {
      return { __anyerpCommand: true, op: 'lte', value };
    },
    regex(options) {
      if (typeof options === 'string') return { __anyerpCommand: true, op: 'regex', value: options };
      return {
        __anyerpCommand: true,
        op: 'regex',
        value: options && options.regexp ? options.regexp : '',
        options: options && options.options ? options.options : ''
      };
    },
    and() {
      return { __anyerpCommand: true, op: 'and', value: Array.prototype.slice.call(arguments) };
    },
    or() {
      return { __anyerpCommand: true, op: 'or', value: Array.prototype.slice.call(arguments) };
    }
  };
}

function createDatabase() {
  return {
    command: createCommand(),
    RegExp(options) {
      if (typeof options === 'string') return new RegExp(options);
      return new RegExp(options && options.regexp ? options.regexp : '', options && options.options ? options.options : '');
    },
    serverDate() {
      return new Date();
    },
    collection(name) {
      return createQuery(name);
    }
  };
}

function install() {
  if (typeof wx === 'undefined' || !wx.cloud || wx.cloud.__anyerpAdapterInstalled) return;

  const originalCallFunction = wx.cloud.callFunction;

  wx.cloud.callFunction = function (options = {}) {
    const data = options.data || {};
    const name = options.name;
    const action = data.action;

    if (MYSQL_FUNCTIONS.indexOf(name) >= 0) {
      const promise = api.call(name, action, data.data || data || {});
      return runWithCallbacks(promise, options);
    }

    if (CLOUD_UTILITY_FUNCTIONS.indexOf(name) >= 0 && originalCallFunction) {
      return originalCallFunction.call(wx.cloud, options);
    }

    const promise = Promise.reject(new Error('Cloud function has been migrated to MySQL API or is not mapped: ' + name));
    return runWithCallbacks(promise, options);
  };

  wx.cloud.database = function () {
    return createDatabase();
  };

  wx.cloud.__anyerpAdapterInstalled = true;
}

module.exports = { install };
