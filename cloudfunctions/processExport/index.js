// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

function parseResourceTypes(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parseResourceTypes(parsed)
  } catch (_) {}
  return String(value).split(/[,，\s]+/).map(item => item.trim()).filter(Boolean)
}

function orderHasResourceType(order, resourceType) {
  const type = String(resourceType || '').trim().toUpperCase()
  if (!type) return true
  const goods = order.goods || order.items || []
  return goods.some(item => {
    const selected = parseResourceTypes(item.selectedResourceTypes || item.selected_resource_types || item.resourceTypes || item.resource_types).map(value => value.toUpperCase())
    if (selected.includes(type)) return true
    const aliases = { GOV_SUBSIDY: ['useGovSubsidy', 'use_gov_subsidy'], EDU_SUBSIDY: ['useEduSubsidy', 'use_edu_subsidy'], SALES_REPORT: ['useSalesReport', 'use_sales_report'] }
    if ((aliases[type] || []).some(key => item[key] === true || item[key] === 1 || String(item[key]) === '1')) return true
    const summary = item.resourceSummary || item.resource_summary || {}
    const rights = summary.rights || item.resourceRights || item.resource_rights || []
    return Array.isArray(rights) && rights.some(right => String(right.resource_type || right.resourceType || '').toUpperCase() === type)
  })
}

async function queryOrdersWithResourceType(whereCondition, resourceType, offset, limit) {
  const targetEnd = offset + limit
  let scanOffset = 0
  const matched = []
  while (matched.length < targetEnd) {
    const result = await db.collection('orders').where(whereCondition).orderBy('createTime', 'desc').skip(scanOffset).limit(1000).get()
    const rows = result.data || []
    matched.push(...rows.filter(order => orderHasResourceType(order, resourceType)))
    scanOffset += rows.length
    if (rows.length < 1000) break
  }
  return matched.slice(offset, targetEnd)
}

async function countOrdersWithResourceType(whereCondition, resourceType) {
  let scanOffset = 0
  let count = 0
  while (true) {
    const result = await db.collection('orders').where(whereCondition).skip(scanOffset).limit(1000).get()
    const rows = result.data || []
    count += rows.filter(order => orderHasResourceType(order, resourceType)).length
    scanOffset += rows.length
    if (rows.length < 1000) return count
  }
}

// 批处理大小
const BATCH_SIZE = 100

/**
 * 处理导出任务云函数
 * @param {Object} event - 调用参数
 * @param {string} event.action - 操作类型
 * @param {Object} event.data - 参数
 */
exports.main = async (event, context) => {
  const { action, data } = event

  try {
    switch (action) {
      case 'processTask':
        return await processTask(data)
      case 'processPendingTasks':
        return await processPendingTasks()
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
      message: error.message || '处理失败',
      data: null
    }
  }
}

/**
 * 处理指定的导出任务
 * @param {Object} data - 参数
 * @param {string} data.taskId - 任务ID
 */
async function processTask(data) {
  const { taskId } = data

  if (!taskId) {
    return {
      code: -1,
      message: '任务ID不能为空',
      data: null
    }
  }

  try {
    // 获取任务信息
    const taskResult = await db.collection('export_tasks').doc(taskId).get()

    if (!taskResult.data) {
      return {
        code: -1,
        message: '任务不存在',
        data: null
      }
    }

    const task = taskResult.data

    // 检查任务状态
    if (task.status !== 'pending') {
      return {
        code: -1,
        message: `任务状态不正确: ${task.status}`,
        data: null
      }
    }

    // 更新任务状态为处理中
    await db.collection('export_tasks').doc(taskId).update({
      data: {
        status: 'processing',
        updateTime: new Date()
      }
    })

    // 开始处理导出
    await executeExport(taskId, task.params)

    return {
      code: 0,
      message: '任务处理完成',
      data: null
    }

  } catch (error) {
    console.error('处理任务失败:', error)

    // 更新任务状态为失败
    await db.collection('export_tasks').doc(taskId).update({
      data: {
        status: 'failed',
        errorMessage: error.message || '处理失败',
        updateTime: new Date()
      }
    })

    return {
      code: -1,
      message: error.message || '处理失败',
      data: null
    }
  }
}

/**
 * 处理所有待处理的导出任务（用于定时触发器）
 */
async function processPendingTasks() {
  try {
    // 查询所有待处理的任务
    const pendingTasks = await db.collection('export_tasks')
      .where({
        status: 'pending'
      })
      .limit(10)
      .get()

    console.log(`找到 ${pendingTasks.data.length} 个待处理任务`)

    // 依次处理每个任务
    for (const task of pendingTasks.data) {
      try {
        await processTask({ taskId: task._id })
      } catch (taskError) {
        console.error(`处理任务 ${task._id} 失败:`, taskError)
        // 继续处理下一个任务
      }
    }

    return {
      code: 0,
      message: `处理了 ${pendingTasks.data.length} 个任务`,
      data: null
    }

  } catch (error) {
    console.error('处理待处理任务失败:', error)
    return {
      code: -1,
      message: error.message || '处理失败',
      data: null
    }
  }
}

/**
 * 执行导出操作
 * @param {string} taskId - 任务ID
 * @param {Object} params - 导出参数
 */
async function executeExport(taskId, params) {
  const {
    userRole,
    userName,
    storeId,
    createUser,
    orderNo,
    status,
    snCode,
    startDate,
    endDate,
    onlyReportedToMall = false,
    resourceType = ''
  } = params

  // 构建查询条件
  let whereCondition = {}

  if (userRole === 'staff') {
    whereCondition.createUser = userName
  } else if (userRole === 'store_admin') {
    if (storeId) {
      whereCondition.storeId = storeId
    }
  }

  // 如果只查询已上报商场的订单
  if (onlyReportedToMall) {
    whereCondition['reportToMall.status'] = 'reported'
  }

  if (createUser && createUser !== '全部') {
    whereCondition.createUser = createUser
  }

  if (orderNo) {
    whereCondition.orderNo = db.RegExp({
      regexp: orderNo,
      options: 'i'
    })
  }

  if (status && status !== '全部') {
    whereCondition.status = status
  }

  if (startDate || endDate) {
    const dateRangeCondition = buildDateRangeCondition(startDate, endDate)
    if (dateRangeCondition) {
      whereCondition.createDate = dateRangeCondition
    }
  }

  // 获取符合条件的订单总数
  let totalOrders
  if (resourceType) {
    totalOrders = await countOrdersWithResourceType(whereCondition, resourceType)
  } else {
    const countResult = await db.collection('orders').where(whereCondition).count()
    totalOrders = countResult.total
  }

  console.log(`任务 ${taskId}: 共 ${totalOrders} 条订单需要导出`)

  // 生成CSV表头
  const headers = [
    '订单编号', '下单时间', '提交人', '门店名称', '门店ID', '一级来源', '二级来源', '会员称呼', '会员联系方式',
    '订单总计', '优惠金额', '国补', '教育补贴', '应收金额', '收款金额汇总',
    '门店二维码', '现金', '国补POS（电脑）', '国补POS（手机平板）', '定金抵扣', '旧机回收抵扣', '商场优惠券', '智店通POS', '线上OMO平台', '对公转账', '对私转账', '龙湖POS（北城专用）', '其他收款方式2',
    '归档状态', '开票状态', '开票信息', '开票金额', '国补状态', '国补人', '国补人ID',
    '商品名称', '商品编码', 'SN码', 'IMEI1', 'IMEI2', '数量', '单价', '小计',
    '商品应收金额', '商品收款金额',
    '辅助销售人比例分配', '辅助销售人金额分配',
    '补录教育优惠', '商品提货运费', '追加商品', '退货商品', '预留字段1', '预留字段2',
    '备注', '创建日期', '订单状态', '归档/作废时间', '操作人', '商品资源类型', '可用资源'
  ]

  let csvContent = headers.join(',') + '\n'
  let processedCount = 0

  // 分批查询订单
  let hasMore = true
  let offset = 0

  while (hasMore) {
    // 查询一批订单
    let ordersBatch = []

    if (resourceType) {
      ordersBatch = await queryOrdersWithResourceType(whereCondition, resourceType, offset, BATCH_SIZE)
    } else if (snCode) {
      // SN码查询需要特殊处理
      ordersBatch = await queryOrdersWithSN(whereCondition, snCode, offset, BATCH_SIZE)
    } else {
      const result = await db.collection('orders')
        .where(whereCondition)
        .orderBy('createTime', 'desc')
        .skip(offset)
        .limit(BATCH_SIZE)
        .get()
      ordersBatch = result.data
    }

    if (ordersBatch.length === 0) {
      hasMore = false
      break
    }

    // 处理这批订单，生成CSV行
    for (const order of ordersBatch) {
      const orderRows = formatOrderToRows(order)
      for (const row of orderRows) {
        csvContent += row.join(',') + '\n'
      }
    }

    processedCount += ordersBatch.length
    offset += ordersBatch.length

    // 更新任务进度
    await db.collection('export_tasks').doc(taskId).update({
      data: {
        processedOrders: processedCount,
        updateTime: new Date()
      }
    })

    console.log(`任务 ${taskId}: 已处理 ${processedCount}/${totalOrders}`)

    // 检查是否处理完成
    if (ordersBatch.length < BATCH_SIZE) {
      hasMore = false
    }
  }

  // 上传CSV文件到云存储
  const fileName = '订单数据_' + new Date().toISOString().split('T')[0] + '_' + Date.now() + '.csv'
  const cloudPath = 'exports/' + fileName

  const buffer = Buffer.from(csvContent, 'utf-8')

  const uploadResult = await cloud.uploadFile({
    cloudPath: cloudPath,
    fileContent: buffer
  })

  // 获取临时下载链接
  const tempUrlResult = await cloud.getTempFileURL({
    fileList: [uploadResult.fileID]
  })

  const tempFileURL = tempUrlResult.fileList[0].tempFileURL

  // 更新任务状态为完成
  await db.collection('export_tasks').doc(taskId).update({
    data: {
      status: 'completed',
      fileID: uploadResult.fileID,
      fileName: fileName,
      downloadUrl: tempFileURL,
      processedOrders: processedCount,
      updateTime: new Date()
    }
  })

  console.log(`任务 ${taskId}: 导出完成，文件: ${fileName}`)
}

/**
 * 查询包含指定SN码的订单
 */
async function queryOrdersWithSN(whereCondition, snCode, offset, limit) {
  // 先查询所有符合条件的订单（不限制数量，因为需要在内存中过滤）
  const result = await db.collection('orders')
    .where(whereCondition)
    .orderBy('createTime', 'desc')
    .skip(offset)
    .limit(limit * 2) // 多查询一些，因为会过滤
    .get()

  // 过滤包含指定SN码的订单
  const filteredOrders = result.data.filter(order => {
    const goods = order.goods || order.items || []
    const foundInItems = goods.some(item => {
      const itemSn = item.snCode || item.sn || ''
      return itemSn.toLowerCase().includes(snCode.toLowerCase())
    })
    const orderSn = order.snCode || order.sn || ''
    const foundInOrder = orderSn.toLowerCase().includes(snCode.toLowerCase())
    return foundInItems || foundInOrder
  })

  return filteredOrders.slice(0, limit)
}

/**
 * 构建日期范围查询条件
 */
function buildDateRangeCondition(startDate, endDate) {
  const effectiveStartDate = startDate || endDate
  const effectiveEndDate = endDate || startDate

  if (!effectiveStartDate) return null

  const dateRangeArray = []
  const start = new Date(effectiveStartDate)
  const end = new Date(effectiveEndDate)

  const currentDate = new Date(start)
  while (currentDate <= end) {
    const year = currentDate.getFullYear()
    const month = String(currentDate.getMonth() + 1).padStart(2, '0')
    const day = String(currentDate.getDate()).padStart(2, '0')
    dateRangeArray.push(`${year}-${month}-${day}`)
    currentDate.setDate(currentDate.getDate() + 1)
  }

  return _.in(dateRangeArray)
}

/**
 * 将订单格式化为多行（每个商品一行）
 */
function formatOrderToRows(order) {
  const rows = []
  const goods = order.goods || order.items || []
  const orderImei1 = order.imei1 || order.IMEI1 || ''
  const orderImei2 = order.imei2 || order.IMEI2 || ''

  // 计算所有商品小计总和
  let totalSubtotal = 0
  const itemSubtotals = goods.map(item => {
    const price = parseFloat(item.price || item.unitPrice || 0)
    const quantity = parseInt(item.quantity || 1)
    return parseFloat(item.subtotal || (price * quantity) || 0)
  })
  totalSubtotal = itemSubtotals.reduce((sum, subtotal) => sum + subtotal, 0)

  if (goods.length === 0) {
    const orderBaseInfo = getOrderBaseInfo(order, 1)
    const paymentMethods = getPaymentMethods(order, 1)
    const row = [
      ...orderBaseInfo,
      ...paymentMethods.values,
      ...getOrderStatusInfo(order),
      '', '', '', '', '', '', '', '', '', '',
      ...getAuxiliarySalesInfo(order),
      ...getSupplementInfo(order),
      '', ''
    ]
    rows.push(row)
  } else {
    goods.forEach((item, index) => {
      const itemName = item.name || item.productName || ''
      const itemPrice = parseFloat(item.price || item.unitPrice || 0)
      const itemQuantity = parseInt(item.quantity || 1)
      const itemPnCode = item.pnCode || item.mtmCode || item.mtm || ''
      const itemSnCode = item.snCode || item.sn || ''
      const itemImei1 = orderImei1
      const itemImei2 = orderImei2
      const itemSubtotal = itemSubtotals[index]
      const ratio = totalSubtotal > 0 ? itemSubtotal / totalSubtotal : (1 / goods.length)

      const orderBaseInfo = getOrderBaseInfo(order, ratio)
      const paymentMethods = getPaymentMethods(order, ratio)

      const totalDiscount = parseFloat(order.discountAmount || order.discount || 0)
      const itemDiscountShare = totalDiscount * ratio
      const itemActualAmount = (itemSubtotal - itemDiscountShare).toFixed(2)
      const itemPaymentAmount = (paymentMethods.total * ratio).toFixed(2)

      const itemInfo = [
        `"${itemName}"`,
        `"${itemPnCode}"`,
        `"${itemSnCode}"`,
        `"${itemImei1}"`,
        `"${itemImei2}"`,
        itemQuantity,
        itemPrice.toFixed(2),
        itemSubtotal.toFixed(2),
        itemActualAmount,
        itemPaymentAmount
      ]

      const row = [
        ...orderBaseInfo,
        ...paymentMethods.values,
        ...getOrderStatusInfo(order),
        ...itemInfo,
        ...getAuxiliarySalesInfo(order),
        ...getSupplementInfo(order),
        ...getResourceExportInfo(item)
      ]
      rows.push(row)
    })
  }

  return rows
}

function getResourceExportInfo(item) {
  const selected = parseResourceTypes(item.selectedResourceTypes || item.selected_resource_types || item.resourceTypes || item.resource_types)
  const summary = item.resourceSummary || item.resource_summary || {}
  const rights = summary.rights || item.resourceRights || item.resource_rights || []
  const available = Array.isArray(rights)
    ? rights.filter(right => String(right.current_status || right.status || '').toUpperCase() === 'AVAILABLE')
      .map(right => right.resource_name || right.resource_type || right.resourceType).filter(Boolean)
    : []
  return [`"${selected.join(' / ')}"`, `"${available.join(' / ')}"`]
}

/**
 * 获取订单基本信息
 */
function getOrderBaseInfo(order, ratio = 1) {
  let createTimeFormat = '未知时间'
  const currentYear = new Date().getFullYear()
  const minValidYear = 2020
  const maxValidYear = currentYear + 1

  try {
    if (order.createDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(order.createDate)) {
        const year = parseInt(order.createDate.substring(0, 4))
        if (year >= minValidYear && year <= maxValidYear) {
          createTimeFormat = order.createDate
        }
      } else {
        const parsedDate = new Date(order.createDate)
        const parsedYear = parsedDate.getFullYear()
        if (!isNaN(parsedDate.getTime()) && parsedYear >= minValidYear && parsedYear <= maxValidYear) {
          createTimeFormat = `${parsedDate.getFullYear()}-${(parsedDate.getMonth() + 1).toString().padStart(2, '0')}-${parsedDate.getDate().toString().padStart(2, '0')}`
        }
      }
    }

    if (createTimeFormat === '未知时间' && order.createTime) {
      let timestamp = order.createTime
      if (typeof timestamp === 'string') {
        if (/^\d+$/.test(timestamp)) {
          timestamp = parseInt(timestamp)
        } else {
          const parsedDate = new Date(timestamp)
          const parsedYear = parsedDate.getFullYear()
          if (!isNaN(parsedDate.getTime()) && parsedYear >= minValidYear && parsedYear <= maxValidYear) {
            createTimeFormat = `${parsedDate.getFullYear()}-${(parsedDate.getMonth() + 1).toString().padStart(2, '0')}-${parsedDate.getDate().toString().padStart(2, '0')}`
          }
        }
      }

      if (typeof timestamp === 'number' && timestamp > 0) {
        if (timestamp < 10000000000) {
          timestamp = timestamp * 1000
        }
        const createTime = new Date(timestamp)
        const parsedYear = createTime.getFullYear()
        if (!isNaN(createTime.getTime()) && parsedYear >= minValidYear && parsedYear <= maxValidYear) {
          createTimeFormat = `${createTime.getFullYear()}-${(createTime.getMonth() + 1).toString().padStart(2, '0')}-${createTime.getDate().toString().padStart(2, '0')}`
        }
      }
    }
  } catch (error) {
    console.warn('日期格式化错误:', error)
  }

  const orderPayments = order.payments || order.paymentMethods || []
  let paymentTotal = 0
  if (orderPayments && orderPayments.length > 0) {
    orderPayments.forEach(method => {
      const amount = parseFloat(method.amount) || 0
      paymentTotal += amount
    })
  }

  const customerName = order.contactName || order.customerName || ''
  const customerPhone = order.contactMethod || order.customerPhone || order.contactPhone || ''

  return [
    `"${order.orderNo || ''}"`,
    `"${createTimeFormat}"`,
    `"${order.createUser || ''}"`,
    `"${order.storeName || ''}"`,
    `"${order.storeId || ''}"`,
    `"${order.customerSource || ''}"`,
    `"${order.customerSourceDetail || ''}"`,
    `"${customerName}"`,
    `"${customerPhone}"`,
    ((parseFloat(order.totalAmount) || 0) * ratio).toFixed(2),
    ((parseFloat(order.discountAmount || order.discount) || 0) * ratio).toFixed(2),
    ((parseFloat(order.nationalSubsidy) || 0) * ratio).toFixed(2),
    ((parseFloat(order.educationSubsidy) || 0) * ratio).toFixed(2),
    ((parseFloat(order.actualAmount || order.actualPayment || 0)) * ratio).toFixed(2),
    (paymentTotal * ratio).toFixed(2)
  ]
}

/**
 * 获取收款方式金额数组
 */
function getPaymentMethods(order, ratio = 1) {
  const payments = {
    '门店二维码': 0,
    '现金': 0,
    '国补POS（电脑）': 0,
    '国补POS（手机平板）': 0,
    '定金抵扣': 0,
    '旧机回收抵扣': 0,
    '商场优惠券': 0,
    '智店通POS': 0,
    '线上OMO平台': 0,
    '对公转账': 0,
    '对私转账': 0,
    '龙湖POS（北城专用）': 0,
    'other2': { name: '', amount: 0 }
  }

  let total = 0
  let otherCount = 0

  const orderPayments = order.payments || order.paymentMethods || []

  if (orderPayments && orderPayments.length > 0) {
    orderPayments.forEach(method => {
      const methodType = method.paymentType || method.type || ''
      const amount = parseFloat(method.amount) || 0

      if (payments.hasOwnProperty(methodType)) {
        payments[methodType] += amount
        total += amount
      } else {
        if (otherCount === 0) {
          payments['other2'] = { name: methodType, amount: amount }
          otherCount++
        }
        total += amount
      }
    })
  }

  const values = [
    (payments['门店二维码'] * ratio).toFixed(2),
    (payments['现金'] * ratio).toFixed(2),
    (payments['国补POS（电脑）'] * ratio).toFixed(2),
    (payments['国补POS（手机平板）'] * ratio).toFixed(2),
    (payments['定金抵扣'] * ratio).toFixed(2),
    (payments['旧机回收抵扣'] * ratio).toFixed(2),
    (payments['商场优惠券'] * ratio).toFixed(2),
    (payments['智店通POS'] * ratio).toFixed(2),
    (payments['线上OMO平台'] * ratio).toFixed(2),
    (payments['对公转账'] * ratio).toFixed(2),
    (payments['对私转账'] * ratio).toFixed(2),
    (payments['龙湖POS（北城专用）'] * ratio).toFixed(2),
    payments['other2'].amount > 0 ? `${payments['other2'].name}:${(payments['other2'].amount * ratio).toFixed(2)}` : ''
  ]

  return { values, total: total * ratio }
}

/**
 * 获取辅助销售人信息
 */
function getAuxiliarySalesInfo(order) {
  const salesList = order.auxiliarySalesList || order.auxiliarySales || []
  const mainSalesName = order.createUser || ''

  let salesRatioDistribution = mainSalesName
  if (salesList.length > 0) {
    const nonMainSalesList = salesList.filter(sales => !sales.isMainSales)
    
    // 获取利润为0的辅助销售人
    const zeroProfitSalesList = nonMainSalesList.filter(sales => {
      const profitAmount = parseFloat(sales.profitAmount || sales.amount || sales.salesAmount || 0)
      return profitAmount === 0
    })
    
    // 如果有利润为0的辅助销售人，显示提交人/利润为0的辅助销售人
    if (zeroProfitSalesList.length > 0) {
      const zeroProfitNames = zeroProfitSalesList.map(sales => {
        return sales.selected || sales.name || sales.salesName || ''
      }).filter(n => n)
      if (zeroProfitNames.length > 0) {
        salesRatioDistribution = mainSalesName + '/' + zeroProfitNames.join('/')
      }
    }
    // 如果所有辅助销售人都有利润分配，则只显示提交人姓名
  }

  const auxiliarySalesAmount = salesList.length > 0
    ? salesList.map(sales => {
        const name = sales.selected || sales.name || sales.salesName || ''
        const amount = parseFloat(sales.profitAmount || sales.amount || sales.salesAmount || 0)
        return { name, amount }
      })
      .filter(s => s.name && s.amount > 0)
      .map(s => `${s.name}:${s.amount.toFixed(2)}`)
      .join('/')
    : ''

  return [`"${salesRatioDistribution}"`, `"${auxiliarySalesAmount}"`]
}

/**
 * 获取订单状态信息
 */
function getOrderStatusInfo(order) {
  const subsidyStatus = order.subsidyStatus || '非国补'

  return [
    `"${order.status || '未归档'}"`,
    `"${order.invoiceStatus || ''}"`,
    `"${order.invoiceInfo || ''}"`,
    `"${order.invoiceAmount || ''}"`,
    `"${subsidyStatus}"`,
    `"${order.subsidyPerson || ''}"`,
    `"${order.subsidyId || ''}"`
  ]
}

/**
 * 获取补录信息
 */
function getSupplementInfo(order) {
  const supplementAmounts = {
    '补录教育优惠': 0,
    '商品提货运费': 0,
    '追加商品': 0,
    '退货商品': 0
  }

  if (order.supplements && order.supplements.length > 0) {
    order.supplements.forEach(sup => {
      const itemName = sup.itemName || ''
      const amount = parseFloat(sup.amount || 0)

      if (itemName.includes('教育优惠') || itemName.includes('教育补贴')) {
        supplementAmounts['补录教育优惠'] += amount
      } else if (itemName.includes('提货') || itemName.includes('运费')) {
        supplementAmounts['商品提货运费'] += amount
      } else if (itemName.includes('追加') || itemName.includes('新增商品')) {
        supplementAmounts['追加商品'] += amount
      } else if (itemName.includes('退货') || itemName.includes('退款')) {
        supplementAmounts['退货商品'] += amount
      }
    })
  }

  let updateTimeFormat = ''
  if (order.updateTime) {
    try {
      const updateDate = new Date(order.updateTime)
      if (!isNaN(updateDate.getTime())) {
        const year = updateDate.getFullYear()
        const month = String(updateDate.getMonth() + 1).padStart(2, '0')
        const day = String(updateDate.getDate()).padStart(2, '0')
        const hour = String(updateDate.getHours()).padStart(2, '0')
        const minute = String(updateDate.getMinutes()).padStart(2, '0')
        updateTimeFormat = `${year}-${month}-${day} ${hour}:${minute}`
      }
    } catch (e) {
      console.error('格式化操作时间失败:', e)
    }
  }

  return [
    supplementAmounts['补录教育优惠'].toFixed(2),
    supplementAmounts['商品提货运费'].toFixed(2),
    supplementAmounts['追加商品'].toFixed(2),
    supplementAmounts['退货商品'].toFixed(2),
    '',
    '',
    `"${order.remarks || ''}"`,
    `"${order.createDate || ''}"`,
    '',
    `"${updateTimeFormat}"`,
    `"${order.updateUser || ''}"`
  ]
}
