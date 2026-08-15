const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

/**
 * 商品查询云函数 (使用微信云数据库 goods 集合)
 */
exports.main = async (event, context) => {
  const { action, data } = event;

  try {
    switch (action) {
      case 'getGoodsByPN':
        return await getGoodsByPN(data);
      case 'getGoodsBySN':
        return await getGoodsBySN(data);
      case 'searchGoodsByName':
        return await searchGoodsByName(data);
      case 'getInventoryByStore':
        return await getInventoryByStore(data);
      default:
        return { code: -1, message: '未知的操作类型' };
    }
  } catch (error) {
    console.error('云函数执行错误:', error);
    return { code: -1, message: error.message || '执行失败' };
  }
};

/**
 * 根据PN码查询商品
 */
async function getGoodsByPN(data) {
  const { pnCode } = data;
  const pn = pnCode;
  if (!pn) return { code: -1, message: 'PN码不能为空' };

  const result = await db.collection('goods')
    .where({
      pnCode: pnCode.trim().toUpperCase()
    })
    .limit(1)
    .get();

  if (result.data && result.data.length > 0) {
    const goods = result.data[0];
    return {
      code: 0,
      data: formatGoodsData(goods)
    };
  }
  return { code: 0, message: '未找到该型号产品', data: null };
}

/**
 * 根据SN码查询商品
 */
async function getGoodsBySN(data) {
  const snCode = String(data.snCode || data.sn || '').trim().toUpperCase();
  const sn = snCode;
  if (!sn) return { code: -1, message: 'SN码不能为空' };

  // 直接从 goods 集合查询 SN
  const result = await db.collection('goods')
    .where({
      snCode
    })
    .limit(1)
    .get();

  if (result.data && result.data.length > 0) {
    const goods = result.data[0];
    return {
      code: 0,
      data: {
        ...formatGoodsData(goods)
      }
    };
  }

  return { code: 0, message: '未找到该串码库存', data: null };
}

/**
 * 模糊搜索商品（按名称）
 * 支持多关键字查询，关键字之间用空格分隔
 */
async function searchGoodsByName(data) {
  const { keywords, limit = 20, page = 1, pageSize } = data;
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize || limit || 10) || 10));
  const offset = (safePage - 1) * safePageSize;
  if (!keywords) return { code: 0, data: [] };

  // 分割多关键字
  const keywordList = keywords.trim().split(/\s+/).filter(k => k.length > 0);
  
  if (keywordList.length === 0) return { code: 0, data: [] };
  
  // 单关键字查询
  if (keywordList.length === 1) {
    const result = await db.collection('goods')
      .where({
        productName: db.RegExp({
          regexp: keywordList[0],
          options: 'i' // 不区分大小写
        })
      })
      .skip(offset)
      .limit(safePageSize)
      .get();
    
    const formattedRows = result.data.map(item => formatGoodsData(item));
    return { code: 0, data: formattedRows, pagination: { page: safePage, pageSize: safePageSize, hasMore: formattedRows.length >= safePageSize } };
  }
  
  // 多关键字查询：使用AND条件
  const andConditions = keywordList.map(keyword => ({
    productName: db.RegExp({
      regexp: keyword,
      options: 'i'
    })
  }));
  
  const result = await db.collection('goods')
    .where(_.and(andConditions))
    .skip(offset)
    .limit(safePageSize)
    .get();

  const formattedRows = result.data.map(item => formatGoodsData(item));

  return { code: 0, data: formattedRows, pagination: { page: safePage, pageSize: safePageSize, hasMore: formattedRows.length >= safePageSize } };
}

/**
 * 获取指定门店的库存概览
 */
async function getInventoryByStore(data) {
  const { storeId } = data;
  if (!storeId) return { code: -1, message: '门店ID不能为空' };

  // 从 goods 集合查询所有商品作为库存
  const result = await db.collection('goods')
    .limit(100)
    .get();

  const rows = result.data.map(item => ({
    productId: item.productId || item._id,
    name: item.productName || item.name || '',
    pnCode: item.pnCode || '',
    stock_count: 1 // 默认每个商品库存为1
  }));

  return { code: 0, data: rows };
}

/**
 * 格式化商品数据
 */
function formatGoodsData(goods) {
  const price = Number(goods.price || 0);
  const standardPrice = Number(goods.standardPrice || goods.standard_price || goods.productStandardPrice || goods.product_standard_price || price || 0);
  const minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price ||
    goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price ||
    goods.floorPrice || goods.floor_price || 0);
  const settlementPrice = Number(goods.settlementPrice || price);
  const costPrice = Number(goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || settlementPrice || 0);
  const currentStoreStockQty = Number(goods.currentStoreStockQty || 0);
  const otherStoreStockQty = Number(goods.otherStoreStockQty || 0);
  const totalStockQty = Number(goods.totalStockQty || goods.stock || currentStoreStockQty + otherStoreStockQty || 0);
  return {
    productId: goods.productId || goods._id,
    name: goods.productName || goods.name || '',
    pnCode: goods.pnCode || '',
    price,
    standardPrice,
    standard_price: standardPrice,
    minSalePrice,
    min_sale_price: minSalePrice,
    settlementPrice,
    costPrice,
    currentStoreStockQty,
    otherStoreStockQty,
    totalStockQty,
    category: goods.category || '',
    snCode: goods.snCode || ''
  };
}
