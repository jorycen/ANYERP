// 云函数入口文件
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { orderNo, remark } = event;

  if (!orderNo) {
    return {
      success: false,
      error: '订单编号不能为空'
    };
  }

  try {
    console.log('更新订单备注:', orderNo, remark);

    // 查询订单
    const orderResult = await db.collection('orders').where({
      orderNo: orderNo
    }).get();

    if (!orderResult.data || orderResult.data.length === 0) {
      return {
        success: false,
        error: '订单不存在'
      };
    }

    const order = orderResult.data[0];

    // 直接更新订单的 remark 字段
    await db.collection('orders').doc(order._id).update({
      data: {
        remarks: remark,
        updateTime: new Date()
      }
    });

    console.log('订单备注更新成功:', order._id);

    return {
      success: true,
      message: '备注保存成功'
    };

  } catch (err) {
    console.error('更新订单备注失败:', err);
    return {
      success: false,
      error: err.message || '更新失败'
    };
  }
};
