// 云函数：获取订单汇总数据（支持日期范围，从goods表查询类别）
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

/**
 * 获取订单汇总数据
 * @param {string} startDate - 开始日期 '2026-03-23'
 * @param {string} endDate - 结束日期 '2026-03-23'
 * @param {string} userRole - 用户角色
 * @param {string} storeId - 门店ID
 * @param {string} userName - 用户名
 */
exports.main = async (event, context) => {
  const { startDate, endDate, userRole = 'staff', storeId = '', userName = '' } = event;

  if (!startDate || !endDate) {
    return {
      code: -1,
      message: '开始日期和结束日期不能为空'
    };
  }

  try {
    // 查询日期范围内的订单
    const orders = await queryOrdersByDateRange(startDate, endDate, userRole, storeId, userName);
    console.log('查询到订单数量:', orders.length);

    // 获取所有PN码
    const pnCodes = extractPNCodes(orders);
    console.log('PN码列表:', pnCodes);

    // 从goods表查询商品类别
    const goodsCategoryMap = await queryGoodsCategories(pnCodes);
    console.log('商品类别映射:', goodsCategoryMap);

    // 汇总统计
    const summary = calculateSummary(orders, goodsCategoryMap);
    console.log('汇总结果:', summary);

    return {
      code: 0,
      message: '查询成功',
      data: summary
    };

  } catch (error) {
    console.error('获取汇总数据失败:', error);
    return {
      code: -1,
      message: error.message || '查询失败'
    };
  }
};

/**
 * 查询日期范围内的订单
 */
async function queryOrdersByDateRange(startDate, endDate, userRole, storeId, userName) {
  // 解析日期
  const startParts = startDate.split('-');
  const endParts = endDate.split('-');
  const start = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
  const end = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]));

  // 生成日期字符串数组
  const datePatterns = [];
  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toDateString();
    datePatterns.push(dateStr);
    datePatterns.push(dateStr.replace(/ 0/g, ' '));
    current.setDate(current.getDate() + 1);
  }

  console.log('日期范围:', startDate, '到', endDate, '共', datePatterns.length / 2, '天');

  // 构建查询条件
  let whereCondition = {
    createTime: _.in(datePatterns),
    status: '已归档'
  };

  // 权限过滤
  if (userRole === 'staff' && userName) {
    whereCondition.createUser = userName;
  } else if (userRole === 'store_admin' && storeId) {
    whereCondition.storeId = storeId;
  }

  // 分批查询所有订单
    let allOrders = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const result = await db.collection('orders')
        .where(whereCondition)
        .field({
          orderNo: true,
          storeId: true,
          storeName: true,
          createUser: true,
          totalAmount: true,
          actualPayment: true,
          goods: true,
          items: true,
          createTime: true
        })
      .skip(offset)
      .limit(limit)
      .get();

    const orders = result.data || [];
    allOrders = allOrders.concat(orders);

    if (orders.length < limit) break;
    offset += limit;
  }

  return allOrders;
}

/**
 * 提取所有PN码
 */
function extractPNCodes(orders) {
  const pnSet = new Set();
  orders.forEach(order => {
    const goods = order.goods || order.items || [];
    goods.forEach(item => {
      const pn = item.pnCode || '';
      if (pn) pnSet.add(pn);
    });
  });
  return Array.from(pnSet);
}

/**
 * 从goods表查询商品CATEGORY
 */
async function queryGoodsCategories(pnCodes) {
  const categoryMap = new Map();

  if (pnCodes.length === 0) return categoryMap;

  // 分批查询（每次最多100个）
  const batchSize = 100;
  for (let i = 0; i < pnCodes.length; i += batchSize) {
    const batch = pnCodes.slice(i, i + batchSize);
    const result = await db.collection('goods')
      .where({
        pnCode: _.in(batch)
      })
      .field({
        pnCode: true,
        CATEGORY: true
      })
      .get();

    const goods = result.data || [];
    goods.forEach(g => {
      const pn = g.pnCode || '';
      const category = g.CATEGORY || g.category || 'OTHER';
      if (pn) categoryMap.set(pn, category);
    });
  }

  return categoryMap;
}

/**
 * 计算汇总数据
 */
function calculateSummary(orders, goodsCategoryMap) {
  const storeMap = new Map();
  let totalAmount = 0;

  // CATEGORY原始值列表（与数据库实际值一致）
  const categoryList = ['笔记本', '手机', 'Pad平板', '台式机', '显示器', '一体机（AIO）', '配件', '售后备件', '二手产品', '官方延保'];

  // 初始化类别统计（直接使用CATEGORY原始值，包含orderCount和quantity）
  const categorySummary = {};
  categoryList.forEach(cat => {
    categorySummary[cat] = { name: cat, orderCount: 0, quantity: 0 };
  });

  orders.forEach(order => {
    const storeId = order.storeId || 'unknown';
    const storeName = order.storeName || '未知门店';
    const employee = order.createUser || '未知员工';
    const amount = parseFloat(order.totalAmount) || 0;

    totalAmount += amount;

    // 门店统计
    if (!storeMap.has(storeId)) {
      storeMap.set(storeId, {
        storeId,
        storeName,
        orderCount: 0,
        amount: 0,
        employees: new Map(),
        categories: {}
      });
      categoryList.forEach(cat => {
        storeMap.get(storeId).categories[cat] = { name: cat, orderCount: 0, quantity: 0 };
      });
    }
    const storeStat = storeMap.get(storeId);
    storeStat.orderCount++;
    storeStat.amount += amount;

    // 员工统计
    if (!storeStat.employees.has(employee)) {
      storeStat.employees.set(employee, {
        name: employee,
        orderCount: 0,
        amount: 0
      });
    }
    const empStat = storeStat.employees.get(employee);
    empStat.orderCount++;
    empStat.amount += amount;

    // 产品类别统计（从goods表查询CATEGORY）
    const goods = order.goods || order.items || [];
    const orderCategories = new Set();

    goods.forEach(item => {
      const pn = item.pnCode || '';
      const quantity = parseInt(item.quantity) || 1;

      // 从goods表获取CATEGORY原始值
      let category = goodsCategoryMap.get(pn) || '';

      // 如果没有类别，则不统计
      if (!category) return;

      orderCategories.add(category);

      // 统计
      if (categorySummary[category]) {
        categorySummary[category].quantity += quantity;
      }
      if (storeStat.categories[category]) {
        storeStat.categories[category].quantity += quantity;
      }
    });

    // 统计该订单涉及的类别单数
    orderCategories.forEach(cat => {
      if (categorySummary[cat]) {
        categorySummary[cat].orderCount++;
      }
      if (storeStat.categories[cat]) {
        storeStat.categories[cat].orderCount++;
      }
    });
  });

  // 转换数据结构
  const storeStats = Array.from(storeMap.values()).map(store => ({
    ...store,
    employees: Array.from(store.employees.values()).sort((a, b) => b.amount - a.amount)
  })).sort((a, b) => b.amount - a.amount);

  return {
    totalOrders: orders.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    storeCount: storeStats.length,
    storeStats,
    categorySummary
  };
}
