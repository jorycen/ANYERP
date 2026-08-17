const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

/**
 * 根据PN码更新所有商品信息云函数
 */
exports.main = async (event, context) => {
  const { pnCode, updateData } = event;
  const pn = pnCode;
  
  // 参数验证
  if (!pn) {
    return { code: -1, message: 'PN码不能为空' };
  }
  
  if (!updateData || Object.keys(updateData).length === 0) {
    return { code: -1, message: '更新数据不能为空' };
  }
  
  // 验证商品名称
  if (updateData.NAME !== undefined) {
    if (!updateData.NAME || updateData.NAME.trim() === '') {
      return { code: -1, message: '商品名称不能为空' };
    }
    updateData.NAME = updateData.NAME.trim();
  }
  
  // 验证价格
  if (updateData.PRICE !== undefined) {
    const price = parseFloat(updateData.PRICE);
    if (isNaN(price) || price < 0) {
      return { code: -1, message: '商品价格不能为负数' };
    }
    updateData.PRICE = price;
  }
  
  // 添加更新时间
  updateData.updateTime = db.serverDate();
  
  try {
    // 查询所有相同PN的商品
    const queryResult = await db.collection('goods')
      .where({
        pnCode: pn
      })
      .get();
    
    const goodsList = queryResult.data || [];
    
    if (goodsList.length === 0) {
      return {
        code: -1,
        message: '未找到该PN码的商品'
      };
    }
    
    // 批量更新所有相同PN的商品
    const updatePromises = goodsList.map(goods => {
      return db.collection('goods').doc(goods._id).update({
        data: updateData
      });
    });
    
    const updateResults = await Promise.all(updatePromises);
    
    // 统计更新结果
    let successCount = 0;
    updateResults.forEach(result => {
      if (result.stats.updated > 0) {
        successCount++;
      }
    });
    
    return {
      code: 0,
      message: '更新成功',
      data: {
        total: goodsList.length,
        updated: successCount
      }
    };
  } catch (error) {
    console.error('批量更新商品失败:', error);
    return {
      code: -1,
      message: error.message || '更新失败'
    };
  }
};
