const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');

/**
 * 员工视角：获取个人业绩清单
 */
exports.getMyPerformance = async (req, res) => {
  const userId = req.user.userId;
  try {
    const [performance] = await db.execute(
      `SELECT o.ORDER_ID, o.CREATE_TIME, o.FINAL_AMOUNT, s.SHARE_AMOUNT, s.SHARE_TYPE
       FROM T_ORDER o
       JOIN T_ORDER_SHARE s ON o.ORDER_ID = s.ORDER_ID
       WHERE s.USER_ID = ?
       ORDER BY o.CREATE_TIME DESC`,
      [userId]
    );

    // 计算总提成建议 (实时计算)
    const totalCommission = performance.reduce((sum, item) => sum + parseFloat(item.SHARE_AMOUNT), 0);

    return ApiResponse.success({
      list: performance,
      summary: { totalCommission }
    }).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching performance', error.message).send(res, 500);
  }
};

/**
 * 老板视角：营业报表看板
 */
exports.getBossDashboard = async (req, res) => {
  const storeId = req.user.storeId; // 如果老板看全店，可传 storeId
  const { startDate, endDate } = req.query;

  try {
    // 1. 核心指标 (营业额、毛利、订单数)
    const [indicators] = await db.execute(
      `SELECT 
        COUNT(ORDER_ID) as totalOrders,
        SUM(TOTAL_AMOUNT) as grossRevenue,
        SUM(SUBSIDY_AMOUNT) as totalSubsidy,
        SUM(FINAL_AMOUNT) as netRevenue,
        AVG(FINAL_AMOUNT) as avgOrderValue
       FROM T_ORDER 
       WHERE STORE_ID = ? AND STATUS = 2`, // 只统计已付订单
      [storeId]
    );

    // 2. 销售排行 (员工 Top)
    const [employeeRank] = await db.execute(
      `SELECT u.NICKNAME, SUM(o.FINAL_AMOUNT) as salesValue, COUNT(o.ORDER_ID) as orderCount
       FROM T_ORDER o
       JOIN T_USER u ON o.SALES_PERSON_ID = u.USER_ID
       WHERE o.STORE_ID = ? AND o.STATUS = 2
       GROUP BY u.USER_ID
       ORDER BY salesValue DESC LIMIT 10`,
      [storeId]
    );

    // 3. 热销类目占比
    const [categoryShare] = await db.execute(
      `SELECT c.CATEGORY_NAME, COUNT(oi.ID) as unitsSold
       FROM T_ORDER_ITEM oi
       JOIN T_PRODUCT p ON oi.PN_CODE = p.PN_CODE
       JOIN T_CATEGORY c ON p.CATEGORY_ID = c.CATEGORY_ID
       JOIN T_ORDER o ON oi.ORDER_ID = o.ORDER_ID
       WHERE o.STORE_ID = ? AND o.STATUS = 2
       GROUP BY c.CATEGORY_ID`,
      [storeId]
    );

    return ApiResponse.success({
      indicators: indicators[0],
      employeeRank,
      categoryShare
    }).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching dashboard data', error.message).send(res, 500);
  }
};
