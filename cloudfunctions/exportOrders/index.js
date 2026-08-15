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

async function countOrdersWithResourceType(whereCondition, resourceType) {
  let offset = 0
  let count = 0
  while (true) {
    const result = await db.collection('orders').where(whereCondition).skip(offset).limit(1000).get()
    const rows = result.data || []
    count += rows.filter(order => orderHasResourceType(order, resourceType)).length
    offset += rows.length
    if (rows.length < 1000) return count
  }
}

/**
 * 导出订单数据云函数（异步版本）
 * @param {Object} event - 调用参数
 * @param {string} event.action - 操作类型
 * @param {Object} event.data - 查询参数
 */
exports.main = async (event, context) => {
  const { action, data } = event

  try {
    switch (action) {
      case 'createExportTask':
        return await createExportTask(data)
      case 'getExportStatus':
        return await getExportStatus(data)
      case 'getMyExportTasks':
        return await getMyExportTasks(data)
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
      message: error.message || '操作失败',
      data: null
    }
  }
}

/**
 * 创建导出任务
 * @param {Object} data - 导出参数
 */
async function createExportTask(data) {
  const {
    userRole = 'staff',
    userName = '',
    storeId = '',
    createUser = '',
    orderNo = '',
    status = '',
    snCode = '',
    startDate = '',
    endDate = '',
    onlyReportedToMall = false,
    resourceType = ''
  } = data

  try {
    // 先查询符合条件的订单数量
    const countResult = await countOrders({
      userRole, userName, storeId, createUser, orderNo, status, snCode, startDate, endDate, onlyReportedToMall, resourceType
    })

    if (countResult.count === 0) {
      return {
        code: -1,
        message: '暂无订单数据可导出',
        data: null
      }
    }

    // 创建导出任务
    const taskData = {
      status: 'pending',
      params: {
        userRole,
        userName,
        storeId,
        createUser,
        orderNo,
        status,
        snCode,
        startDate,
        endDate,
        onlyReportedToMall,
        resourceType
      },
      totalOrders: countResult.count,
      processedOrders: 0,
      fileID: '',
      fileName: '',
      downloadUrl: '',
      errorMessage: '',
      createTime: new Date(),
      updateTime: new Date(),
      expireTime: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24小时后过期
    }

    const result = await db.collection('export_tasks').add({
      data: taskData
    })

    // 触发异步处理（使用云调用）
    try {
      await cloud.callFunction({
        name: 'processExport',
        data: {
          action: 'processTask',
          data: {
            taskId: result._id
          }
        }
      })
    } catch (triggerError) {
      console.error('触发异步处理失败:', triggerError)
      // 不影响返回，因为任务已创建，可以通过定时器重试
    }

    return {
      code: 0,
      message: '导出任务已创建',
      data: {
        taskId: result._id,
        totalOrders: countResult.count,
        status: 'pending'
      }
    }

  } catch (error) {
    console.error('创建导出任务失败:', error)
    return {
      code: -1,
      message: error.message || '创建导出任务失败',
      data: null
    }
  }
}

/**
 * 查询导出任务状态
 * @param {Object} data - 查询参数
 * @param {string} data.taskId - 任务ID
 */
async function getExportStatus(data) {
  const { taskId } = data

  if (!taskId) {
    return {
      code: -1,
      message: '任务ID不能为空',
      data: null
    }
  }

  try {
    const result = await db.collection('export_tasks').doc(taskId).get()

    if (!result.data) {
      return {
        code: -1,
        message: '任务不存在',
        data: null
      }
    }

    const task = result.data

    return {
      code: 0,
      message: '查询成功',
      data: {
        taskId: taskId,
        status: task.status,
        totalOrders: task.totalOrders,
        processedOrders: task.processedOrders,
        fileName: task.fileName,
        downloadUrl: task.downloadUrl,
        errorMessage: task.errorMessage,
        createTime: task.createTime,
        expireTime: task.expireTime
      }
    }

  } catch (error) {
    console.error('查询导出状态失败:', error)
    return {
      code: -1,
      message: error.message || '查询失败',
      data: null
    }
  }
}

/**
 * 获取我的导出任务列表
 * @param {Object} data - 查询参数
 * @param {string} data.userName - 用户名
 */
async function getMyExportTasks(data) {
  const { userName = '' } = data

  try {
    // 查询该用户最近7天的导出任务
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    const result = await db.collection('export_tasks')
      .where({
        'params.userName': userName,
        createTime: _.gte(sevenDaysAgo)
      })
      .orderBy('createTime', 'desc')
      .limit(50)
      .get()

    // 格式化返回数据
    const tasks = result.data.map(task => ({
      _id: task._id,
      status: task.status,
      totalOrders: task.totalOrders,
      processedOrders: task.processedOrders,
      fileName: task.fileName,
      downloadUrl: task.downloadUrl,
      errorMessage: task.errorMessage,
      createTime: task.createTime,
      expireTime: task.expireTime
    }))

    return {
      code: 0,
      message: '查询成功',
      data: tasks
    }

  } catch (error) {
    console.error('查询我的导出任务失败:', error)
    return {
      code: -1,
      message: error.message || '查询失败',
      data: null
    }
  }
}

/**
 * 统计符合条件的订单数量
 */
async function countOrders(params) {
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

  if (resourceType) {
    return { count: await countOrdersWithResourceType(whereCondition, resourceType) }
  }

  const countResult = await db.collection('orders').where(whereCondition).count()

  return {
    count: countResult.total
  }
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
