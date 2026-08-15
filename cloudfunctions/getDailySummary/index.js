// 云函数：获取指定日期的订单汇总数据
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

/**
 * 获取订单汇总数据
 * @param {string} date - 日期格式 '2026-03-23'（兼容旧版本）
 * @param {string} startDate - 开始日期 '2026-03-23'
 * @param {string} endDate - 结束日期 '2026-03-24'
 * @param {string} userRole - 用户角色 distributor/store_admin/staff
 * @param {string} storeId - 门店ID（店长使用）
 * @param {string} userName - 用户名（员工使用）
 */
exports.main = async (event, context) => {
  const { date, startDate, endDate, userRole = 'staff', storeId = '', userName = '' } = event;

  // 确定查询的日期范围
  let queryStartDate = startDate || date;
  let queryEndDate = endDate || date;

  if (!queryStartDate || !queryEndDate) {
    return {
      code: -1,
      message: '日期参数不能为空'
    };
  }

  try {
    console.log('查询日期范围:', queryStartDate, '到', queryEndDate);

    console.log('查询日期范围:', queryStartDate, '到', queryEndDate);

    // 构建查询条件 - 查询日期范围内的订单
    // 使用 gte 和 lte 进行日期范围查询，比 _.in 更可靠
    let whereCondition = {
      status: '已归档',
      createDate: _.gte(queryStartDate).and(_.lte(queryEndDate))
    };

    // 根据用户角色过滤
    if (userRole === 'staff' && userName) {
      whereCondition.createUser = userName;
    } else if (userRole === 'store_admin' && storeId) {
      whereCondition.storeId = storeId;
    }
    // 经销商不添加过滤条件，查看所有订单

    console.log('查询条件:', JSON.stringify(whereCondition));

    // 查询订单（使用分页获取所有数据）
    const orders = await queryAllOrders(whereCondition);
    console.log('查询到订单数量:', orders.length);
    console.log('【关键日志】日期范围:', queryStartDate, '到', queryEndDate, '订单数:', orders.length);
    
    // 计算总销售额（使用 totalAmount 字段）
    const totalAmount = orders.reduce((sum, order) => sum + (parseFloat(order.totalAmount) || 0), 0);
    console.log('【关键日志】总销售额:', totalAmount);
    
    // 输出前5条订单的日期和金额
    orders.slice(0, 5).forEach((order, idx) => {
      console.log(`订单${idx + 1}:`, order.createDate, '金额:', order.actualPayment);
    });
    
    // 如果没有查询到订单，尝试查询一条记录查看数据结构
    if (orders.length === 0) {
      console.log('未查询到订单，尝试查询任意一条已归档订单...');
      const sampleResult = await db.collection('orders')
        .where({ status: '已归档' })
        .limit(1)
        .get();
      
      if (sampleResult.data && sampleResult.data.length > 0) {
        const sample = sampleResult.data[0];
        console.log('样本订单:', {
          orderNo: sample.orderNo,
          createDate: sample.createDate,
          createDateType: typeof sample.createDate,
          status: sample.status
        });
      } else {
        console.log('数据库中没有任何已归档订单');
      }
    } else {
      console.log('第一条订单:', orders[0].orderNo, orders[0].createDate, orders[0].createTime);
    }

    // 获取所有PN码
    const pnCodes = extractPNCodes(orders);
    console.log('PN码列表:', pnCodes);

    // 从goods表查询产品类别、系列和价格
    const { categoryMap: productCategoryMap, seriesMap: productSeriesMap, priceMap: productPriceMap, typeMap: productTypeMap } = await queryProductCategories(pnCodes);
    console.log('产品类别映射:', productCategoryMap);
    console.log('产品系列映射:', productSeriesMap);
    console.log('产品TYPE映射:', productTypeMap);

    // 汇总统计
    const summary = calculateSummary(orders, productCategoryMap, productSeriesMap, productPriceMap, productTypeMap);
    summary.date = date;
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
 * 分页查询所有订单
 */
async function queryAllOrders(whereCondition) {
  const allOrders = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;
  let pageCount = 0;
  
  console.log('开始分页查询...');
  
  while (hasMore) {
    pageCount++;
    console.log(`查询第${pageCount}页，offset:`, offset);
    
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
        status: true,
        createDate: true,
        createTime: true
      })
      .skip(offset)
      .limit(limit)
      .get();
    
    const orders = result.data || [];
    console.log(`第${pageCount}页返回:`, orders.length, '条');
    
    allOrders.push(...orders);
    
    if (orders.length < limit) {
      hasMore = false;
      console.log('最后一页，结束查询');
    } else {
      offset += limit;
    }
  }
  
  console.log('分页查询完成，总页数:', pageCount, '总订单数:', allOrders.length);
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
 * 从goods表查询产品类别、系列和价格
 * 使用批量查询，但限制每批数量避免 _.in() 的返回限制
 */
async function queryProductCategories(pnCodes) {
  const categoryMap = new Map();
  const seriesMap = new Map();
  const priceMap = new Map();
  const typeMap = new Map(); // 新增：存储TYPE字段

  if (pnCodes.length === 0) return { categoryMap, seriesMap, priceMap, typeMap };

  console.log('需要查询的PN码数量:', pnCodes.length);

  // 分批查询，每批最多50个（避免 _.in() 返回限制）
  const batchSize = 50;
  for (let i = 0; i < pnCodes.length; i += batchSize) {
    const batch = pnCodes.slice(i, i + batchSize);
    console.log(`第${Math.floor(i/batchSize) + 1}批查询PN码:`, batch.length, '个');

    try {
      const result = await db.collection('goods')
        .where({
          pnCode: _.in(batch)
        })
        .field({
          pnCode: true,
          CATEGORY: true,
          category: true,
          TYPE: true,
          type: true,
          X: true,
          PRICE: true,
          price: true
        })
        .get();

      const goods = result.data || [];
      console.log(`第${Math.floor(i/batchSize) + 1}批查询结果:`, goods.length, '条');

      goods.forEach(g => {
        const pn = g.pnCode || '';
        const categoryValue = g.CATEGORY || g.category || '';
        const typeValue = g.TYPE || g.type || '';
        const series = (g.TYPE || g.type || '').toUpperCase();
        const xValue = g.X || '';
        const price = parseFloat(g.PRICE || g.price || 0);

        if (pn) {
          categoryMap.set(pn, categoryValue);
          typeMap.set(pn, typeValue); // 存储TYPE字段
          seriesMap.set(pn, { series, xValue });
          priceMap.set(pn, price);
        }
      });
    } catch (err) {
      console.error(`第${Math.floor(i/batchSize) + 1}批查询失败:`, err);
    }
  }

  console.log('查询完成，匹配到的PN码数量:', categoryMap.size);
  console.log('未匹配到的PN码:', pnCodes.filter(pn => !categoryMap.has(pn)));

  return { categoryMap, seriesMap, priceMap, typeMap };
}

/**
 * 计算汇总数据
 */
function calculateSummary(orders, productCategoryMap, productSeriesMap, productPriceMap, productTypeMap) {
  // 初始化汇总对象
  const storeMap = new Map();
  const categoryMap = new Map();
  let totalAmount = 0;

  // CATEGORY原始值到显示名称的映射（用于产品类别统计和门店商品汇总）
  const categoryNameMap = {
    '笔记本': '笔记本',
    '手机': '手机',
    'Pad平板': 'Pad平板',
    '台式机': '台式机',
    '显示器': '显示器',
    '一体机（AIO）': '一体机（AIO）',
    '配件': '配件',
    '售后备件': '售后备件',
    '二手产品': '二手产品',
    '官方延保': '官方延保'
  };

  // 初始化类别统计（直接使用CATEGORY原始值，包含单数和数量）
  const categorySummary = {
    '笔记本': { name: '笔记本', orderCount: 0, quantity: 0 },
    '手机': { name: '手机', orderCount: 0, quantity: 0 },
    'Pad平板': { name: 'Pad平板', orderCount: 0, quantity: 0 },
    '台式机': { name: '台式机', orderCount: 0, quantity: 0 },
    '显示器': { name: '显示器', orderCount: 0, quantity: 0 },
    '一体机（AIO）': { name: '一体机（AIO）', orderCount: 0, quantity: 0 },
    '配件': { name: '配件', orderCount: 0, quantity: 0 },
    '售后备件': { name: '售后备件', orderCount: 0, quantity: 0 },
    '二手产品': { name: '二手产品', orderCount: 0, quantity: 0 },
    '官方延保': { name: '官方延保', orderCount: 0, quantity: 0 }
  };

  // 全局产品系列统计（使用TYPE字段，动态生成）
  const globalSeriesMap = new Map();

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
        categories: {},  // 动态存储TYPE类别（用于门店商品汇总）
        seriesMap: new Map(),  // 动态存储TYPE系列（用于门店产品分布）
        // 产品类别统计（使用CATEGORY字段）
        categorySummary: {
          '笔记本': { name: '笔记本', orderCount: 0, quantity: 0 },
          '手机': { name: '手机', orderCount: 0, quantity: 0 },
          'Pad平板': { name: 'Pad平板', orderCount: 0, quantity: 0 },
          '台式机': { name: '台式机', orderCount: 0, quantity: 0 },
          '显示器': { name: '显示器', orderCount: 0, quantity: 0 },
          '一体机（AIO）': { name: '一体机（AIO）', orderCount: 0, quantity: 0 },
          '配件': { name: '配件', orderCount: 0, quantity: 0 },
          '售后备件': { name: '售后备件', orderCount: 0, quantity: 0 },
          '二手产品': { name: '二手产品', orderCount: 0, quantity: 0 },
          '官方延保': { name: '官方延保', orderCount: 0, quantity: 0 }
        }
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

    // 产品类别统计（按订单统计单数，按商品统计数量）
    const goods = order.goods || order.items || [];
    const orderCategories = new Set(); // 记录该订单包含的CATEGORY类别
    
    goods.forEach(item => {
      const quantity = parseInt(item.quantity) || 1;
      const pn = item.pnCode || '';
      
      // 1. 获取CATEGORY值（用于产品类别汇总）
      let categoryValue = productCategoryMap.get(pn) || '';
      let category = categoryValue || '其他';
      
      // 2. 获取TYPE值（用于门店商品类别汇总）
      let typeValue = productTypeMap.get(pn) || '';
      let typeCategory = typeValue || '其他';

      // 更新全局类别统计（使用CATEGORY）
      if (!categoryMap.has(category)) {
        categoryMap.set(category, {
          category,
          name: categoryNameMap[category] || category,
          count: 0,
          orderCount: 0
        });
      }
      const catStat = categoryMap.get(category);
      catStat.count += quantity;
      orderCategories.add(category);

      // 更新产品类别汇总（使用CATEGORY）
      if (storeStat.categorySummary[category]) {
        storeStat.categorySummary[category].quantity += quantity;
      }
      if (categorySummary[category]) {
        categorySummary[category].quantity += quantity;
      }

      // 3. 更新门店商品类别统计（使用TYPE - 动态添加，并记录对应的CATEGORY）
      if (!storeStat.categories[typeCategory]) {
        storeStat.categories[typeCategory] = { name: typeCategory, orderCount: 0, quantity: 0, categoryType: category };
      }
      storeStat.categories[typeCategory].quantity += quantity;

      // 4. 产品系列统计（使用TYPE字段，动态添加）
      if (typeValue) {
        // 更新全局产品系列统计
        if (!globalSeriesMap.has(typeValue)) {
          globalSeriesMap.set(typeValue, { name: typeValue, quantity: 0, categoryType: category });
        }
        globalSeriesMap.get(typeValue).quantity += quantity;

        // 更新门店产品系列统计
        if (!storeStat.seriesMap.has(typeValue)) {
          storeStat.seriesMap.set(typeValue, { name: typeValue, quantity: 0, categoryType: category });
        }
        storeStat.seriesMap.get(typeValue).quantity += quantity;
      }
    });

    // 统计该订单涉及的类别单数
    orderCategories.forEach(cat => {
      if (categorySummary[cat]) {
        categorySummary[cat].orderCount++;
      }
      if (categoryMap.has(cat)) {
        categoryMap.get(cat).orderCount++;
      }
      // 更新门店CATEGORY单数统计
      if (storeStat.categorySummary && storeStat.categorySummary[cat]) {
        storeStat.categorySummary[cat].orderCount++;
      }
    });
  });

  // 调试：检查第一个门店的seriesStats
  const firstStore = Array.from(storeMap.values())[0];
  if (firstStore) {
    console.log('第一个门店seriesStats:', firstStore.seriesStats);
    console.log('门店数量:', storeMap.size);
  }

  // 转换数据结构
  const storeMapValues = Array.from(storeMap.values());
  console.log('开始转换storeStats，门店数:', storeMapValues.length);
  
  const storeStats = storeMapValues.map((store, index) => {
    // 门店产品系列（使用TYPE字段，动态生成）
    const seriesArray = Array.from(store.seriesMap?.values() || [])
      .filter(s => s.quantity > 0)
      .sort((a, b) => b.quantity - a.quantity);
    
    return {
      storeId: store.storeId,
      storeName: store.storeName,
      orderCount: store.orderCount,
      amount: Math.round(store.amount),
      employees: Array.from(store.employees.values()).map(emp => ({
        name: emp.name,
        orderCount: emp.orderCount,
        amount: Math.round(emp.amount)
      })).sort((a, b) => b.amount - a.amount),
      // 门店商品类别（使用TYPE字段，动态生成）
      categories: Object.values(store.categories || {})
        .filter(c => c.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity),
      // 产品类别汇总（使用CATEGORY字段）
      categorySummary: store.categorySummary,
      // 门店产品系列（使用TYPE字段）
      seriesArray: seriesArray
    };
  }).sort((a, b) => b.amount - a.amount);
  
  console.log('storeStats转换完成');

  const categoryStats = Array.from(categoryMap.values()).sort((a, b) => b.count - a.count);

  // 全局产品系列数组（使用TYPE字段，动态生成）
  const productSeriesArray = Array.from(globalSeriesMap.values())
    .filter(s => s.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity);

  console.log('全局产品系列统计:', productSeriesArray);

  return {
    date: orders[0]?.createDate || '',
    totalOrders: orders.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    storeCount: storeStats.length,
    storeStats,
    categoryStats,
    categorySummary: {
      '笔记本': categorySummary['笔记本'],
      '手机': categorySummary['手机'],
      'Pad平板': categorySummary['Pad平板'],
      '台式机': categorySummary['台式机'],
      '显示器': categorySummary['显示器'],
      '一体机（AIO）': categorySummary['一体机（AIO）'],
      '配件': categorySummary['配件'],
      '售后备件': categorySummary['售后备件'],
      '二手产品': categorySummary['二手产品'],
      '官方延保': categorySummary['官方延保']
    },
    productSeriesArray
  };
}
