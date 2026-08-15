// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

/**
 * 更新订单信息云函数
 * @param {Object} event - 调用参数
 * @param {string} event.orderNo - 订单编号
 * @param {Object} event.orderData - 订单数据
 * @param {string} event.userRole - 用户角色
 * @param {string} event.userName - 当前用户名
 * @param {string} event.storeId - 门店ID
 */
exports.main = async (event, context) => {
  const { orderNo, orderData, userRole = 'staff', userName = '', storeId = '' } = event

  try {
    // 参数验证
    if (!orderNo) {
      return {
        code: -1,
        message: '订单编号不能为空',
        data: null
      }
    }

    if (!orderData) {
      return {
        code: -1,
        message: '订单数据不能为空',
        data: null
      }
    }

    console.log('更新订单:', orderNo)
    console.log('更新数据:', JSON.stringify(orderData))

    // 查询订单
    const orderResult = await db.collection('orders')
      .where({ orderNo: orderNo })
      .limit(1)
      .get()

    if (!orderResult.data || orderResult.data.length === 0) {
      return {
        code: -1,
        message: '订单不存在',
        data: null
      }
    }

    const order = orderResult.data[0]

    // 权限检查：普通员工只能更新自己的订单
    if (userRole === 'staff' && order.createUser !== userName) {
      return {
        code: -1,
        message: '无权操作他人的订单',
        data: null
      }
    }

    // 店长只能更新自己门店的订单
    if (userRole === 'store_admin' && order.storeId !== storeId) {
      return {
        code: -1,
        message: '无权操作其他门店的订单',
        data: null
      }
    }

    // 经销商可以更新所有订单

    // 检查订单是否已归档
    let updateData = {}
    if (order.status === '已归档') {
      // 已归档订单只允许修改特定字段：国补人信息、国补照片、开票信息
      const allowedFields = [
        'subsidyPerson', 'subsidyId', 'subsidyPhotos',
        'invoiceStatus', 'invoiceInfo', 'invoiceAmount'
      ]

      // 过滤只允许更新的字段
      allowedFields.forEach(field => {
        if (orderData.hasOwnProperty(field)) {
          updateData[field] = orderData[field]
        }
      })

      if (Object.keys(updateData).length === 0) {
        return {
          code: -1,
          message: '已归档订单只能修改国补人信息、国补照片和开票信息',
          data: null
        }
      }

      console.log('归档订单，仅更新允许的特殊字段:', Object.keys(updateData))
    } else {
      // 未归档订单可以更新所有字段
      updateData = { ...orderData }
    }

    // 验证订单数据
    const validationResult = validateOrderData(orderData)
    if (!validationResult.valid) {
      return {
        code: -1,
        message: validationResult.message,
        data: null
      }
    }

    // 构建更新数据
    updateData.updateTime = new Date()
    updateData.updateUser = userName

    // 更新订单
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: updateData
      })

    console.log('订单更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }

  } catch (error) {
    console.error('更新订单失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 验证订单数据
 * @param {Object} data - 订单数据
 */
function validateOrderData(data) {
  // 验证客户信息
  if (data.contactName !== undefined && !data.contactName.trim()) {
    return { valid: false, message: '会员称呼不能为空' }
  }

  // 验证商品列表
  if (data.goods && data.goods.length > 0) {
    for (let i = 0; i < data.goods.length; i++) {
      const item = data.goods[i]
      if (!item.pnCode || !item.pnCode.trim()) {
        return { valid: false, message: `第${i + 1}个商品的PN码不能为空` }
      }
    }
  }

  // 验证国补信息
  if (data.subsidyStatus === '国补') {
    if (!data.subsidyPerson || !data.subsidyPerson.trim()) {
      return { valid: false, message: '国补人姓名不能为空' }
    }
    if (!data.subsidyId || !/^\d{11}$/.test(data.subsidyId)) {
      return { valid: false, message: '国补人ID必须为11位纯数字' }
    }
  }

  // 验证开票信息
  if (data.invoiceStatus === '开票' && !data.invoiceInfo) {
    return { valid: false, message: '开票信息不能为空' }
  }

  return { valid: true, message: '' }
}
