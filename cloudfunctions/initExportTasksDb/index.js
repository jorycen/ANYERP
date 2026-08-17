// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

/**
 * 初始化导出任务数据库
 * 创建 export_tasks 集合（如果不存在）
 */
exports.main = async (event, context) => {
  try {
    // 检查集合是否存在
    const collections = await db.listCollections().get()
    const exists = collections.data.some(col => col.name === 'export_tasks')

    if (!exists) {
      // 创建集合
      await db.createCollection('export_tasks')
      console.log('export_tasks 集合创建成功')

      // 创建索引
      await db.collection('export_tasks').createIndex({
        data: {
          status: 1,
          createTime: -1
        }
      })

      return {
        code: 0,
        message: 'export_tasks 集合创建成功',
        data: null
      }
    } else {
      return {
        code: 0,
        message: 'export_tasks 集合已存在',
        data: null
      }
    }
  } catch (error) {
    console.error('创建集合失败:', error)
    return {
      code: -1,
      message: error.message || '创建集合失败',
      data: null
    }
  }
}
