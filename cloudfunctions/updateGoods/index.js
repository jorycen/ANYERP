const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();

/**
 * 更新商品信息云函数
 */
exports.main = async (event, context) => {
  const { goodsId, updateData } = event;
  
  // 参数验证
  if (!goodsId) {
    return { code: -1, message: '商品ID不能为空' };
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
    // 更新商品信息
    const result = await db.collection('goods').doc(goodsId).update({
      data: updateData
    });
    
    if (result.stats.updated > 0) {
      return {
        code: 0,
        message: '更新成功',
        data: {
          updated: result.stats.updated
        }
      };
    } else {
      return {
        code: -1,
        message: '未找到该商品或无需更新'
      };
    }
  } catch (error) {
    console.error('更新商品失败:', error);
    return {
      code: -1,
      message: error.message || '更新失败'
    };
  }
};
