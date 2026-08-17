// 云函数入口文件
const cloud = require('wx-server-sdk')
const axios = require('axios')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// ==================== 光环API配置 ====================
const GUANGHUAN_CONFIG = {
  // 门店配置（重庆光环购物公园店）
  STORE_ID: 'STORE_1770530067196',
  STORE_NAME: '联想',
  MALL_CODE: 'GHL419',
  STORE_CODE: 'GHL419',
  TILL_ID: '01',
  CHECK_CODE: 'P88888888',
  
  // API配置
  App_Sub_ID: '100001KKM',
  App_Token: 'c7dnmd0sk3d579c30f94',
  Api_ID: 'kukumao.orderCollect',
  Api_Version: '1.0.0',
  Sign_Method: 'md5',
  Format: 'json',
  Partner_ID: '100001',
  Sys_ID: '69b911cfb1816aaa6c8d8ab4',
  App_Pub_ID: '10001',
  Sign_Key: '69b911cfb1816aaa6c8d8ab4',
  Base_URL: 'https://cdghkkm.hklring.com:10001/posbox/crland'
}

function isArchivedStatus(value) {
  const status = String(value || '').trim()
  if (status === '未归档' || status === 'unarchived' || status === 'UNARCHIVED' || status.indexOf('未归档') >= 0 || status.indexOf('鏈綊') >= 0) return false
  return status === '已归档' || status === 'archived' || status === 'ARCHIVED' || status.indexOf('已归档') >= 0 || status.indexOf('宸插綊') >= 0
}

function isVoidedStatus(value) {
  const status = String(value || '').trim()
  return status === '已作废' || status === 'voided' || status === 'cancelled' || status === 'canceled' || status.indexOf('作废') >= 0 || status.indexOf('浣滃簾') >= 0
}

function parseResourceTypes(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parseResourceTypes(parsed)
  } catch (_) {}
  return String(value).split(/[,，\s]+/).map(item => item.trim()).filter(Boolean)
}

function itemHasResourceType(item, resourceType) {
  const type = String(resourceType || '').trim().toUpperCase()
  if (!type) return true
  const selected = parseResourceTypes(item.selectedResourceTypes || item.selected_resource_types || item.resourceTypes || item.resource_types)
    .map(value => value.toUpperCase())
  if (selected.includes(type)) return true
  const aliases = {
    GOV_SUBSIDY: ['useGovSubsidy', 'use_gov_subsidy'],
    EDU_SUBSIDY: ['useEduSubsidy', 'use_edu_subsidy'],
    SALES_REPORT: ['useSalesReport', 'use_sales_report']
  }
  if ((aliases[type] || []).some(key => item[key] === true || item[key] === 1 || String(item[key]) === '1')) return true
  const summary = item.resourceSummary || item.resource_summary || {}
  const rights = summary.rights || item.resourceRights || item.resource_rights || []
  return Array.isArray(rights) && rights.some(right => String(right.resource_type || right.resourceType || '').toUpperCase() === type)
}

function orderHasResourceType(order, resourceType) {
  const goods = order.goods || order.items || []
  return goods.some(item => itemHasResourceType(item, resourceType))
}

// ==================== 支付方式映射 ====================
const PAYMENT_METHOD_MAP = {
  '现金': 'CH',
  '支付宝': 'AP',
  '微信': 'WP',
  '银行卡': 'CI',
  '国补POS': 'OT',
  '国补POS（手机平板）': 'OT',
  '国补POS（电脑）': 'OT',
  '智店通POS': 'OT',
  '二维码': 'OT',
  '对公转账': 'OT',
  'OMO支付': 'OT'
}

// ==================== 工具函数 ====================

/**
 * 生成MD5签名（按照光环API规范）
 * 规则：对所有公共请求参数（除去sign参数）和REQUEST_DATA，根据参数名称ASCII码表顺序排序，
 * 将排序好的参数名和参数值组合成"参数=参数值"的格式，用&字符连接，最后加上&秘钥
 */
function generateSign(params, signKey) {
  // 按key排序
  const sortedKeys = Object.keys(params).sort()
  let signString = ''
  
  for (const key of sortedKeys) {
    if (key !== 'Sign' && params[key] !== undefined && params[key] !== null && params[key] !== '') {
      signString += `${key}=${params[key]}&`
    }
  }
  
  // 移除最后一个&，添加秘钥
  signString = signString.slice(0, -1) + signKey
  
  console.log('待签名字符串:', signString)
  
  // 生成MD5签名（32位大写）
  return crypto.createHash('md5').update(signString).digest('hex').toUpperCase()
}

/**
 * 格式化时间为 yyyyMMddhhmmss (北京时间 UTC+8)
 */
function formatTimeToApi(time) {
  let date = time ? new Date(time) : new Date()
  
  // 转换为北京时间 (UTC+8)
  const beijingTime = date.getTime() + 8 * 60 * 60 * 1000
  date = new Date(beijingTime)
  
  // 使用 UTC 方法获取，避免时区问题
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  
  return `${year}${month}${day}${hour}${minute}${second}`
}

/**
 * 格式化时间为 yyyy-mm-dd HH:mm:ss:SSS
 */
function formatTimestamp(time) {
  const date = time ? new Date(time) : new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}:${ms}`
}

/**
 * 映射支付方式
 */
function mapPaymentMethod(method) {
  return PAYMENT_METHOD_MAP[method] || 'OT'
}

/**
 * 构建光环API请求数据
 */
function buildGuanghuanRequest(order) {
  // 商品列表
  const goods = order.goods || order.items || []
  const itemList = goods.map(item => ({
    itemCode: item.pnCode || '',
    price: parseFloat(item.price) || 0,
    quantity: parseInt(item.quantity) || 1
  }))
  
  // 支付列表
  const payments = order.paymentMethods || order.payments || []
  const orderTime = formatTimeToApi(order.createTime)
  const payList = payments.map(payment => ({
    paymentMethod: mapPaymentMethod(payment.type || payment.method),
    payAmt: parseFloat(payment.amount) || 0,
    value: parseFloat(payment.amount) || 0,
    discountAmt: 0,
    time: orderTime,
    cardBank: '',
    cardNumber: ''
  }))
  
  // 业务数据
  const requestData = {
    orderId: order.orderNo,
    mall: GUANGHUAN_CONFIG.MALL_CODE,
    store: GUANGHUAN_CONFIG.STORE_CODE,
    tillId: GUANGHUAN_CONFIG.TILL_ID,
    cashierId: order.createUser || 'unknown',
    checkCode: GUANGHUAN_CONFIG.CHECK_CODE,
    type: 'SALE',
    source: '01',
    time: orderTime,
    totalAmt: parseFloat(order.totalAmount) || 0,
    mobile: order.contactMethod || '',
    comments: order.orderNo,
    itemList: itemList,
    payList: payList,
    refOrderId: ''
  }
  
  return requestData
}

/**
 * 调用光环API上传订单
 */
async function uploadOrderToGuanghuan(order) {
  try {
    const requestData = buildGuanghuanRequest(order)
    const requestDataJson = JSON.stringify(requestData)
    
    // 构建公共参数
    const timestamp = formatTimestamp()
    const publicParams = {
      App_Sub_ID: GUANGHUAN_CONFIG.App_Sub_ID,
      App_Token: GUANGHUAN_CONFIG.App_Token,
      Api_ID: GUANGHUAN_CONFIG.Api_ID,
      Api_Version: GUANGHUAN_CONFIG.Api_Version,
      Time_Stamp: timestamp,
      Sign_Method: GUANGHUAN_CONFIG.Sign_Method,
      Format: GUANGHUAN_CONFIG.Format,
      Partner_ID: GUANGHUAN_CONFIG.Partner_ID,
      Sys_ID: GUANGHUAN_CONFIG.Sys_ID,
      App_Pub_ID: GUANGHUAN_CONFIG.App_Pub_ID,
      REQUEST_DATA: requestDataJson
    }
    
    // 生成签名
    const sign = generateSign(publicParams, GUANGHUAN_CONFIG.Sign_Key)
    publicParams.Sign = sign
    
    // 构建完整请求体
    const requestBody = {
      REQUEST: {
        HRT_ATTRS: publicParams,
        REQUEST_DATA: requestData
      }
    }
    
    console.log('光环API请求地址:', GUANGHUAN_CONFIG.Base_URL)
    console.log('光环API请求数据:', JSON.stringify(requestBody, null, 2))
    
    // 发送请求
    const response = await axios({
      method: 'POST',
      url: GUANGHUAN_CONFIG.Base_URL,
      data: requestBody,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      },
      timeout: 30000,
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    })
    
    console.log('光环API响应:', JSON.stringify(response.data, null, 2))

    // 解析响应
    const responseData = response.data
    let result = {
      success: false,
      code: '',
      message: ''
    }

    // 兼容两种响应格式：有 RESPONSE 层级的和没有的
    let resp = responseData
    if (responseData && responseData.RESPONSE) {
      resp = responseData.RESPONSE
    }

    if (resp) {
      result.code = resp.RETURN_CODE || ''
      result.message = resp.RETURN_DESC || ''

      // 优先检查 RETURN_CODE
      if (resp.RETURN_CODE === '100' || resp.RETURN_CODE === '0000') {
        result.success = true
      }
      // 同时检查 errcode（光环实际返回的格式）
      if (resp.RETURN_DATA && resp.RETURN_DATA.header && resp.RETURN_DATA.header.errcode === '0000') {
        result.success = true
        result.code = '0000'
        result.message = resp.RETURN_DATA.header.errmsg || '成功'
      }
    }

    return result
    
  } catch (error) {
    console.error('调用光环API失败:', error)
    return {
      success: false,
      code: error.code || 'ERROR',
      message: error.message || '调用光环API失败'
    }
  }
}

/**
 * 查询订单列表（支持分页和筛选）
 * @param {Object} event - 调用参数
 * @param {string} event.action - 操作类型
 * @param {Object} event.data - 查询参数
 */
exports.main = async (event, context) => {
  const { action, data } = event

  try {
    switch (action) {
      case 'getOrders':
        return await getOrders(data)
      case 'getOrderByNo':
        return await getOrderByNo(data)
      case 'updateOrderStatus':
        return await updateOrderStatus(data)
      case 'updateInvoiceInfo':
        return await updateInvoiceInfo(data)
      case 'deleteSupplement':
        return await deleteSupplement(data)
      case 'deleteSupplementItem':
        return await deleteSupplementItem(data)
      case 'updateSubsidyPhotos':
        return await updateSubsidyPhotos(data)
      case 'updateProductPhotos':
        return await updateProductPhotos(data)
      case 'updateSubsidyPerson':
        return await updateSubsidyPerson(data)
      case 'reportOrderToMall':
        return await reportOrderToMall(data)
      case 'getGuanghuanStats':
        return await getGuanghuanStats(data)
      default:
        return {
          code: -1,
          message: '未知的操作类型',
          data: null
        }
    }
  } catch (error) {
    console.error('云函数执行错误:', error)
    return {
      code: -1,
      message: error.message || '查询失败',
      data: null
    }
  }
}

/**
 * 获取订单列表（支持分页和筛选）
 * @param {Object} data - 查询参数
 * @param {number} data.page - 页码（从1开始）
 * @param {number} data.pageSize - 每页数量
 * @param {string} data.storeId - 门店ID（可选，店长使用）
 * @param {string} data.createUser - 创建人（可选）
 * @param {string} data.orderNo - 订单编号（可选，模糊查询）
 * @param {string} data.status - 订单状态（可选）
 * @param {string} data.snCode - SN码（可选，模糊查询）
 * @param {string} data.pnCode - PN码（可选，模糊查询）
 * @param {string} data.startDate - 开始日期（可选）
 * @param {string} data.endDate - 结束日期（可选）
 * @param {string} data.userRole - 用户角色（distributor/store_admin/staff）
 * @param {string} data.userName - 当前用户名（用于写操作权限校验）
 */
async function getOrders(data) {
  let {
    page = 1,
    pageSize = 20,
    storeId = '',
    createUser = '',
    orderNo = '',
    status = '',
    snCode = '',
    pnCode = '',
    invoiceInfo = '',
    startDate = '',
    endDate = '',
    userRole = 'staff',
    userName = '',
    searchAll = false,
    onlyReportedToMall = false,
    resourceType = ''
  } = data

  console.log('查询参数:', { startDate, endDate, snCode, pnCode, invoiceInfo, resourceType, userRole, userName, storeId, createUser, searchAll })

  // 构建基本查询条件
  let whereCondition = {}

  // 订单查询允许店员查看订单列表中的其他订单；是否能编辑、作废等操作
  // 仍由前端 canOperateOrder 和各个写接口分别校验。
  if (userRole === 'store_admin' && storeId) {
    whereCondition.storeId = storeId
  }

  if (onlyReportedToMall) {
    whereCondition['reportToMall.status'] = 'reported'
  }

  if (createUser && createUser !== '全部') {
    whereCondition.createUser = createUser
  }

  if (orderNo) {
    whereCondition.orderNo = db.RegExp({ regexp: orderNo, options: 'i' })
  }

  if (status && status !== '全部') {
    whereCondition.status = status
  }

  // 生成日期范围数组
  const buildDateRangeArray = (start, end) => {
    const arr = []
    const cur = new Date(start)
    const endDate = new Date(end)
    while (cur <= endDate) {
      const y = cur.getFullYear()
      const m = String(cur.getMonth() + 1).padStart(2, '0')
      const d = String(cur.getDate()).padStart(2, '0')
      arr.push(`${y}-${m}-${d}`)
      cur.setDate(cur.getDate() + 1)
    }
    return arr
  }

  // 如果有日期范围，直接在数据库层面过滤
  if (startDate && endDate) {
    const dateRangeArray = buildDateRangeArray(startDate, endDate)
    whereCondition.createDate = db.command.in(dateRangeArray)
    console.log('使用日期范围:', dateRangeArray.length, '天')
  }

  try {
    // 【关键优化】：不管什么情况，直接拉取最近1000条订单，然后在内存中过滤
    console.log('开始查询，拉取最近1000条订单...')
    
    const allResult = await db.collection('orders')
      .where(whereCondition)
      .field({
        orderNo: true, createTime: true, createDate: true, createUser: true,
        storeId: true, storeName: true, customerSource: true, contactName: true,
        contactMethod: true, totalAmount: true, discountAmount: true,
        nationalSubsidy: true, computerAmount: true, mobileAmount: true, educationSubsidy: true, actualPayment: true,
        paymentTotal: true, status: true, subsidyStatus: true, subsidyPerson: true,
        subsidyId: true, invoiceStatus: true, invoiceInfo: true, invoiceAmount: true,
        freightAmount: true, goods: true, items: true, payments: true,
        subsidyPhotos: true, subsidyPhotoUrls: true, productPhotoUrls: true,
        educationSubsidyPhotoUrl: true, personalInfoPhoto: true,
        subsidy_photos: true, subsidy_photo_urls: true, product_photo_urls: true,
        education_subsidy_photo_url: true, personal_info_photo: true,
        supplementTotal: true, imei1: true, imei2: true, reportToMall: true
      })
      .orderBy('createTime', 'desc')
      .limit(1000)
      .get()

    let orders = allResult.data
    console.log(`拉取到 ${orders.length} 条订单`)

    // 【内存过滤】：快速过滤 SN/PN/开票信息
    if (snCode || pnCode || invoiceInfo) {
      const snLower = (snCode || '').toLowerCase()
      const pnLower = (pnCode || '').toLowerCase()
      const invoiceLower = (invoiceInfo || '').toLowerCase()

      orders = orders.filter(order => {
        // 匹配 SN/PN 或 开票信息
        let match = true

        if (snCode) {
          const goods = order.goods || order.items || []
          match = goods.some(item => {
            const itemSn = String(item.snCode || item.sn || '').toLowerCase()
            const itemImei1 = String(item.imei1 || '').toLowerCase()
            const itemImei2 = String(item.imei2 || '').toLowerCase()
            const orderImei1 = String(order.imei1 || '').toLowerCase()
            const orderImei2 = String(order.imei2 || '').toLowerCase()
            return itemSn.includes(snLower) || itemImei1.includes(snLower) || 
                   itemImei2.includes(snLower) || orderImei1.includes(snLower) || 
                   orderImei2.includes(snLower)
          })
          if (!match) return false
        }

        if (pnCode) {
          const goods = order.goods || order.items || []
          match = goods.some(item => {
            const itemPn = String(item.pnCode || '').toLowerCase()
            return itemPn.includes(pnLower)
          })
          if (!match) return false
        }

        if (invoiceInfo) {
          const orderInvoiceInfo = String(order.invoiceInfo || '').toLowerCase()
          const orderSubsidyPerson = String(order.subsidyPerson || '').toLowerCase()
          match = orderInvoiceInfo.includes(invoiceLower) || orderSubsidyPerson.includes(invoiceLower)
          if (!match) return false
        }

        return true
      })
      console.log(`过滤后剩余 ${orders.length} 条订单`)
    }

    if (resourceType) {
      orders = orders.filter(order => orderHasResourceType(order, resourceType))
      console.log(`资源类型 ${resourceType} 过滤后剩余 ${orders.length} 条订单`)
    }

    // 计算总数
    const total = orders.length

    // 分页处理
    const startIndex = (page - 1) * pageSize
    const endIndex = searchAll ? orders.length : startIndex + pageSize
    const finalOrders = orders.slice(startIndex, endIndex)

    console.log('查询完成，返回', finalOrders.length, '条，总计', total, '条')

    return {
      code: 0,
      message: '查询成功',
      data: {
        list: finalOrders,
        total: total,
        page: page,
        pageSize: searchAll ? total : pageSize,
        hasMore: !searchAll && total > page * pageSize
      }
    }
  } catch (error) {
    console.error('查询订单失败:', error)
    return {
      code: -1,
      message: '查询失败: ' + error.message,
      data: { list: [], total: 0, page: page, pageSize: pageSize, hasMore: false }
    }
  }
}

/**
 * 根据订单编号查询单个订单
 * @param {Object} data - 查询参数
 * @param {string} data.orderNo - 订单编号
 */
async function getOrderByNo(data) {
  const { orderNo } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  try {
    const result = await db.collection('orders')
      .where({ orderNo: orderNo })
      .limit(1)
      .get()

    if (result.data && result.data.length > 0) {
      return {
        code: 0,
        message: '查询成功',
        data: result.data[0]
      }
    }

    return {
      code: 0,
      message: '未找到订单',
      data: null
    }
  } catch (error) {
    console.error('查询订单失败:', error)
    throw error
  }
}

/**
 * 更新订单状态
 * @param {Object} data - 更新参数
 * @param {string} data.orderNo - 订单编号
 * @param {string} data.status - 新状态
 * @param {string} data.userRole - 用户角色
 * @param {string} data.userName - 当前用户名
 */
async function updateOrderStatus(data) {
  const { orderNo, status, userRole = 'staff', userName = '' } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  if (!status) {
    return {
      code: -1,
      message: '状态不能为空',
      data: null
    }
  }

  try {
    // 先查询订单
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

    // 已归档订单必须走退单审批，不允许通过状态接口直接作废。
    if (isVoidedStatus(status) && isArchivedStatus(order.status)) {
      return {
        code: -1,
        message: '已归档订单不能直接作废，请发起退单申请',
        data: null
      }
    }

    // 权限检查：普通员工只能更新自己的订单
    if (userRole === 'staff' && order.createUser !== userName) {
      return {
        code: -1,
        message: '无权操作他人的订单',
        data: null
      }
    }

    // 店长只能更新自己门店的订单
    if (userRole === 'store_admin' && order.storeId !== data.storeId) {
      return {
        code: -1,
        message: '无权操作其他门店的订单',
        data: null
      }
    }

    // 经销商可以更新所有订单

    // 权限检查：已归档订单作废规则
    // 1. 经销商可以作废任何已归档订单
    // 2. 店长和员工只能作废当日创建的已归档订单
    if (order.status === '已归档' && status === '已作废') {
      if (userRole === 'distributor') {
        // 经销商可以作废任何已归档订单，不做额外限制
      } else if (userRole === 'staff' || userRole === 'store_admin') {
        // 店长和员工：只能作废当日创建的已归档订单
        const orderDate = order.createDate || ''
        const now = new Date()
        const year = now.getFullYear()
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        const today = `${year}-${month}-${day}`

        if (orderDate !== today) {
          return {
            code: -1,
            message: '不允许作废今日以前已归档订单，如有特殊情况，请在企业微信发起退单申请',
            data: null
          }
        }

        // 员工只能作废自己创建的订单
        if (userRole === 'staff' && order.createUser !== userName) {
          return {
            code: -1,
            message: '您只能作废自己创建的订单',
            data: null
          }
        }

        // 店长可以作废同门店下的订单
        if (userRole === 'store_admin' && order.storeId !== data.storeId) {
          return {
            code: -1,
            message: '您只能作废同门店下的订单',
            data: null
          }
        }
      } else {
        // 其他角色不允许作废已归档订单
        return {
          code: -1,
          message: '只有经销商才能作废已归档的订单',
          data: null
        }
      }
    }

    const updateData = {
      status: status,
      updateTime: new Date(),
      updateUser: userName
    }

    ;[
      'snStatusAction',
      'targetSnStatus',
      'previousSnStatus',
      'restorePreviousSnStatus',
      'inventoryStatusAction',
      'targetInventoryStatus',
      'previousInventoryStatus',
      'sn_status_action',
      'target_sn_status',
      'previous_sn_status',
      'restore_previous_sn_status',
      'inventory_status_action',
      'target_inventory_status',
      'previous_inventory_status'
    ].forEach(field => {
      if (data[field] !== undefined) {
        updateData[field] = data[field]
      }
    })

    if (data.restoreOriginalInventory !== undefined) updateData.restoreOriginalInventory = data.restoreOriginalInventory
    if (data.voidReason !== undefined) updateData.voidReason = data.voidReason

    if ((data.items && data.items.length) || (data.goods && data.goods.length)) {
      updateData.items = data.items || data.goods
      updateData.goods = data.goods || data.items
    }

    // 更新订单状态
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: updateData
      })

    console.log('订单状态更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }
  } catch (error) {
    console.error('更新订单状态失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 更新订单开票信息
 * @param {Object} data - 更新参数
 * @param {string} data.orderNo - 订单编号
 * @param {string} data.invoiceStatus - 开票状态
 * @param {string} data.invoiceInfo - 开票信息
 * @param {string|number} data.invoiceAmount - 开票金额
 * @param {string} data.userRole - 用户角色
 * @param {string} data.userName - 当前用户名
 * @param {string} data.storeId - 门店ID
 */
async function updateInvoiceInfo(data) {
  const { orderNo, invoiceStatus, invoiceInfo, invoiceAmount, userRole = 'staff', userName = '', storeId = '' } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  if (!invoiceStatus) {
    return {
      code: -1,
      message: '开票状态不能为空',
      data: null
    }
  }

  try {
    // 先查询订单
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

    // 检查订单是否已归档
    if (order.status === '已归档') {
      return {
        code: -1,
        message: '已归档订单不能修改开票信息',
        data: null
      }
    }

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

    // 构建更新数据
    const updateData = {
      invoiceStatus: invoiceStatus,
      updateTime: new Date()
    }

    // 如果需要开票，则保存开票信息和开票金额；否则清空
    if (invoiceStatus !== '不开票') {
      updateData.invoiceInfo = invoiceInfo || ''
      updateData.invoiceAmount = invoiceAmount || ''
    } else {
      updateData.invoiceInfo = ''
      updateData.invoiceAmount = ''
    }

    // 更新订单开票信息
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: updateData
      })

    console.log('订单开票信息更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }
  } catch (error) {
    console.error('更新订单开票信息失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 删除补录记录
 * @param {Object} data - 删除参数
 * @param {string} data.orderNo - 订单编号
 * @param {Array} data.supplements - 更新后的补录记录数组
 * @param {number} data.supplementTotal - 更新后的补录总金额
 */
async function deleteSupplement(data) {
  const { orderNo, supplements, supplementTotal } = data

  try {
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

    // 检查订单是否已归档
    if (order.status === '已归档') {
      return {
        code: -1,
        message: '已归档订单不能删除补录记录',
        data: null
      }
    }

    // 更新订单补录记录
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: {
          supplements: supplements,
          supplementTotal: supplementTotal,
          updateTime: new Date()
        }
      })

    console.log('补录记录删除成功:', updateResult)

    return {
      code: 0,
      message: '删除成功',
      data: updateResult
    }
  } catch (error) {
    console.error('删除补录记录失败:', error)
    return {
      code: -1,
      message: error.message || '删除失败',
      data: null
    }
  }
}

/**
 * 更新国补照片
 * @param {Object} data - 更新参数
 * @param {string} data.orderNo - 订单编号
 * @param {Array} data.subsidyPhotos - 国补照片数组
 */
async function updateSubsidyPhotos(data) {
  const { orderNo, subsidyPhotos } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  try {
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

    // 检查订单是否已归档
    if (order.status === '已归档') {
      return {
        code: -1,
        message: '已归档订单不能修改照片',
        data: null
      }
    }

    // 更新国补照片
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: {
          subsidyPhotos: subsidyPhotos,
          updateTime: new Date()
        }
      })

    console.log('国补照片更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }
  } catch (error) {
    console.error('更新国补照片失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 更新商品图片
 * @param {Object} data - 更新参数
 * @param {string} data.orderNo - 订单编号
 * @param {Array} data.productPhotoUrls - 商品图片数组
 */
async function updateProductPhotos(data) {
  const { orderNo, productPhotoUrls } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  try {
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

    // 检查订单是否已归档
    if (order.status === '已归档') {
      return {
        code: -1,
        message: '已归档订单不能修改照片',
        data: null
      }
    }

    // 更新商品图片
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: {
          productPhotoUrls: productPhotoUrls,
          updateTime: new Date()
        }
      })

    console.log('商品图片更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }
  } catch (error) {
    console.error('更新商品图片失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 删除补录项目
 * @param {Object} data - 删除参数
 * @param {string} data.id - 补录项目ID
 */
async function deleteSupplementItem(data) {
  const { id } = data

  if (!id) {
    return {
      code: -1,
      message: '项目ID不能为空',
      data: null
    }
  }

  try {
    console.log('删除补录项目, ID:', id)

    // 查询项目是否存在
    const itemResult = await db.collection('supplementItems')
      .doc(id)
      .get()

    if (!itemResult.data) {
      return {
        code: -1,
        message: '项目不存在',
        data: null
      }
    }

    // 删除项目
    const deleteResult = await db.collection('supplementItems')
      .doc(id)
      .remove()

    console.log('补录项目删除成功:', deleteResult)

    return {
      code: 0,
      message: '删除成功',
      data: deleteResult
    }
  } catch (error) {
    console.error('删除补录项目失败:', error)
    return {
      code: -1,
      message: error.message || '删除失败',
      data: null
    }
  }
}

/**
 * 更新国补人信息
 * @param {Object} data - 更新参数
 * @param {string} data.orderNo - 订单编号
 * @param {string} data.subsidyPerson - 国补人姓名
 * @param {string} data.subsidyId - 国补人ID
 * @param {string} data.userRole - 用户角色
 * @param {string} data.userName - 当前用户名
 * @param {string} data.storeId - 门店ID
 */
async function updateSubsidyPerson(data) {
  const { orderNo, subsidyPerson, subsidyId, userRole, userName, storeId } = data

  try {
    console.log('更新国补人信息:', { orderNo, subsidyPerson, subsidyId, userRole, userName, storeId })

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

    // 检查订单是否已归档
    if (order.status === '已归档') {
      return {
        code: -1,
        message: '已归档订单不能修改国补人信息',
        data: null
      }
    }

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

    // 验证国补人ID必须为11位纯数字
    if (!/^\d{11}$/.test(subsidyId)) {
      return {
        code: -1,
        message: '国补人ID必须为11位纯数字',
        data: null
      }
    }

    // 构建更新数据
    const updateData = {
      subsidyPerson: subsidyPerson || '',
      subsidyId: subsidyId || '',
      updateTime: new Date()
    }

    // 更新订单国补人信息
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: updateData
      })

    console.log('订单国补人信息更新成功:', updateResult)

    return {
      code: 0,
      message: '更新成功',
      data: updateResult
    }
  } catch (error) {
    console.error('更新订单国补人信息失败:', error)
    return {
      code: -1,
      message: error.message || '更新失败',
      data: null
    }
  }
}

/**
 * 上报订单到商场
 * @param {Object} data - 上报参数
 * @param {string} data.orderNo - 订单编号
 * @param {string} data.userRole - 用户角色
 * @param {string} data.userName - 当前用户名
 * @param {string} data.storeId - 门店ID
 */
async function reportOrderToMall(data) {
  const { orderNo, userRole = 'staff', userName = '', storeId = '' } = data

  if (!orderNo) {
    return {
      code: -1,
      message: '订单编号不能为空',
      data: null
    }
  }

  // 权限检查：只有店长才能上报商场
  if (userRole !== 'store_admin') {
    return {
      code: -1,
      message: '只有店长权限才能上报商场',
      data: null
    }
  }

  try {
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

    // 检查订单是否已归档
    if (order.status !== '已归档') {
      return {
        code: -1,
        message: '只有已归档订单才能上报商场',
        data: null
      }
    }

    // 店长只能上报自己门店的订单
    if (order.storeId !== storeId) {
      return {
        code: -1,
        message: '无权上报其他门店的订单',
        data: null
      }
    }

    // 检查订单是否已经上报过
    if (order.reportToMall && order.reportToMall.status === 'reported') {
      return {
        code: -1,
        message: '该订单已经上报过商场，不能重复上报',
        data: null
      }
    }

    // 判断是否为重庆光环购物公园店，如果是则同步上传到光环API
    let guanghuanResult = null
    if (order.storeId === GUANGHUAN_CONFIG.STORE_ID) {
      console.log('检测到重庆光环购物公园店订单，开始同步上传到光环API...')
      guanghuanResult = await uploadOrderToGuanghuan(order)
      console.log('光环API上传结果:', guanghuanResult)
      
      // 如果上传失败，返回错误提示
      if (!guanghuanResult.success) {
        return {
          code: -1,
          message: `上传失败：${guanghuanResult.message || '光环API调用失败'}`,
          data: null
        }
      }
    }

    // 构建上报数据
    const reportData = {
      reportToMall: {
        status: 'reported',
        reportTime: new Date(),
        reportUser: userName,
        guanghuanApi: guanghuanResult ? {
          uploaded: guanghuanResult.success,
          uploadTime: new Date(),
          responseCode: guanghuanResult.code,
          responseMsg: guanghuanResult.message
        } : null
      },
      updateTime: new Date()
    }

    // 更新订单上报状态
    const updateResult = await db.collection('orders')
      .doc(order._id)
      .update({
        data: reportData
      })

    console.log('订单上报商场成功:', updateResult)

    return {
      code: 0,
      message: '订单上报商场成功',
      data: {
        orderNo: orderNo,
        reportToMall: reportData.reportToMall
      }
    }
  } catch (error) {
    console.error('订单上报商场失败:', error)
    return {
      code: -1,
      message: error.message || '上报失败',
      data: null
    }
  }
}

/**
 * 获取光环上传统计
 * @param {Object} data - 查询参数
 * @param {string} data.startDate - 开始日期（yyyy-MM-dd）
 * @param {string} data.endDate - 结束日期（yyyy-MM-dd）
 * @param {string} data.storeId - 门店ID（可选）
 */
async function getGuanghuanStats(data) {
  try {
    const { startDate, endDate, storeId } = data

    console.log('=== getGuanghuanStats 开始 ===')
    console.log('输入参数:', JSON.stringify(data))

    if (!startDate || !endDate) {
      return {
        code: -1,
        message: '请指定开始日期和结束日期',
        data: null
      }
    }

    // 生成日期范围内的所有日期字符串
    const dateRangeArray = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const year = d.getFullYear()
      const month = (d.getMonth() + 1).toString().padStart(2, '0')
      const day = d.getDate().toString().padStart(2, '0')
      dateRangeArray.push(`${year}-${month}-${day}`)
    }
    
    console.log('查询日期范围:', dateRangeArray)

    // 构建查询条件
    let whereCondition = {
      createDate: db.command.in(dateRangeArray)
    }

    // 如果有 storeId，增加门店过滤
    if (storeId) {
      whereCondition.storeId = storeId
    }

    console.log('查询条件:', JSON.stringify(whereCondition))

    // 查询订单
    const orderResult = await db.collection('orders')
      .where(whereCondition)
      .limit(500)
      .get()

    console.log('数据库查询完成，订单数量:', orderResult.data ? orderResult.data.length : 0)

    if (!orderResult.data || orderResult.data.length === 0) {
      return {
        code: 0,
        message: '查询成功',
        data: {
          stats: { orderCount: 0, totalAmount: '0.00', successCount: 0, failCount: 0 },
          orders: []
        }
      }
    }

    // 统计
    let orderCount = orderResult.data.length
    let reportedCount = 0
    let unreportedCount = 0
    let totalAmount = 0

    const orderList = orderResult.data.map(order => {
      const hasReported = order.reportToMall && order.reportToMall.status === 'reported'
      let uploadMsg = ''
      
      if (hasReported) {
        if (order.reportToMall.guanguanApi) {
          uploadMsg = order.reportToMall.guanguanApi.responseMsg || ''
        }
        reportedCount++
      } else {
        unreportedCount++
      }

      const amount = parseFloat(order.totalAmount || order.actualAmount || 0)
      totalAmount += amount

      let archiveTime = ''
      if (order.updateTime) {
        const date = new Date(order.updateTime)
        archiveTime = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }

      return {
        orderNo: order.orderNo,
        totalAmount: amount.toFixed(2),
        archiveTime: archiveTime,
        guanguanUploadStatus: hasReported ? 'reported' : 'none',
        guanguanUploadMsg: uploadMsg
      }
    })

    console.log('统计完成: orderCount=', orderCount, 'totalAmount=', totalAmount)

    return {
      code: 0,
      message: '查询成功',
      data: {
        stats: {
          orderCount,
          totalAmount: totalAmount.toFixed(2),
          reportedCount,
          unreportedCount
        },
        orders: orderList
      }
    }
  } catch (error) {
    console.error('获取光环上传统计失败:', error)
    return {
      code: -1,
      message: error.message || '查询失败',
      data: null
    }
  }
}
