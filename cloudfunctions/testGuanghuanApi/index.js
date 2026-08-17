// 云函数入口文件
const cloud = require('wx-server-sdk');
const axios = require('axios');
const crypto = require('crypto');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

// 光环API配置
const GUANGHUAN_CONFIG = {
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
  Base_URL: 'https://cdghkkm.hklring.com:10001/posbox/crland',
  MALL_CODE: 'GHL419',
  STORE_CODE: 'GHL419',
  TILL_ID: '01',
  CHECK_CODE: 'P88888888'
};

// 支付方式映射
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
};

/**
 * 生成MD5签名（按照光环API规范）
 */
function generateSign(params, signKey) {
  const sortedKeys = Object.keys(params).sort();
  let signString = '';
  
  for (const key of sortedKeys) {
    if (key !== 'Sign' && params[key] !== undefined && params[key] !== null && params[key] !== '') {
      signString += `${key}=${params[key]}&`;
    }
  }
  
  signString = signString.slice(0, -1) + signKey;
  console.log('待签名字符串:', signString);
  
  return crypto.createHash('md5').update(signString).digest('hex').toUpperCase();
}

/**
 * 格式化时间为 yyyyMMddhhmmss (北京时间 UTC+8)
 */
function formatTimeToApi(time) {
  let date = time ? new Date(time) : new Date();
  
  // 转换为北京时间 (UTC+8)
  const beijingTime = date.getTime() + 8 * 60 * 60 * 1000;
  date = new Date(beijingTime);
  
  // 使用 UTC 方法获取，避免时区问题
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}${hour}${minute}${second}`;
}

/**
 * 格式化时间为 yyyy-mm-dd HH:mm:ss:SSS
 */
function formatTimestamp(time) {
  const date = time ? new Date(time) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}:${ms}`;
}

/**
 * 映射支付方式
 */
function mapPaymentMethod(method) {
  return PAYMENT_METHOD_MAP[method] || 'OT';
}

/**
 * 构建光环API请求数据
 */
function buildGuanghuanRequest(order) {
  const goods = order.goods || order.items || [];
  const itemList = goods.map(item => ({
    itemCode: item.pnCode || '',
    price: parseFloat(item.price) || 0,
    quantity: parseInt(item.quantity) || 1
  }));
  
  const payments = order.paymentMethods || order.payments || [];
  const orderTime = formatTimeToApi(order.createTime);
  const payList = payments.map(payment => ({
    paymentMethod: mapPaymentMethod(payment.type || payment.method),
    payAmt: parseFloat(payment.amount) || 0,
    value: parseFloat(payment.amount) || 0,
    discountAmt: 0,
    time: orderTime,
    cardBank: '',
    cardNumber: ''
  }));
  
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
  };
  
  return requestData;
}

/**
 * 构建完整的请求体
 */
function buildFullRequestBody(requestData) {
  const requestDataJson = JSON.stringify(requestData);
  const timestamp = formatTimestamp();
  
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
  };
  
  const sign = generateSign(publicParams, GUANGHUAN_CONFIG.Sign_Key);
  publicParams.Sign = sign;
  
  const requestBody = {
    REQUEST: {
      HRT_ATTRS: publicParams,
      REQUEST_DATA: requestData
    }
  };
  
  return requestBody;
}

/**
 * 查看订单上传数据（不上传，仅预览）
 */
async function previewOrderUploadData(orderNo) {
  if (!orderNo) {
    return {
      success: false,
      message: '订单编号不能为空'
    };
  }
  
  try {
    const orderResult = await db.collection('orders')
      .where({ orderNo: orderNo })
      .limit(1)
      .get();
    
    if (!orderResult.data || orderResult.data.length === 0) {
      return {
        success: false,
        message: '未找到订单'
      };
    }
    
    const order = orderResult.data[0];
    const requestData = buildGuanghuanRequest(order);
    const fullRequestBody = buildFullRequestBody(requestData);
    
    console.log('=== 订单上传数据预览 ===');
    console.log('原始订单:', JSON.stringify(order, null, 2));
    console.log('光环API请求数据:', JSON.stringify(fullRequestBody, null, 2));
    
    return {
      success: true,
      orderNo: orderNo,
      originalOrder: order,
      guanghuanRequestData: requestData,
      fullRequestBody: fullRequestBody,
      requestUrl: GUANGHUAN_CONFIG.Base_URL
    };
    
  } catch (error) {
    console.error('预览订单上传数据失败:', error);
    return {
      success: false,
      message: error.message || '预览失败',
      error: error.stack
    };
  }
}

/**
 * 测试上传订单（实际上传）
 */
async function testUploadOrder(orderNo) {
  if (!orderNo) {
    return {
      success: false,
      message: '订单编号不能为空'
    };
  }
  
  try {
    const orderResult = await db.collection('orders')
      .where({ orderNo: orderNo })
      .limit(1)
      .get();
    
    if (!orderResult.data || orderResult.data.length === 0) {
      return {
        success: false,
        message: '未找到订单'
      };
    }
    
    const order = orderResult.data[0];
    const requestData = buildGuanghuanRequest(order);
    const fullRequestBody = buildFullRequestBody(requestData);
    
    console.log('=== 开始上传订单到光环API ===');
    console.log('请求地址:', GUANGHUAN_CONFIG.Base_URL);
    console.log('请求数据:', JSON.stringify(fullRequestBody, null, 2));
    
    const response = await axios({
      method: 'POST',
      url: GUANGHUAN_CONFIG.Base_URL,
      data: fullRequestBody,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      },
      timeout: 30000,
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    });
    
    console.log('光环API响应:', JSON.stringify(response.data, null, 2));
    
    return {
      success: true,
      orderNo: orderNo,
      requestData: fullRequestBody,
      responseData: response.data,
      responseStatus: response.status
    };
    
  } catch (error) {
    console.error('上传订单失败:', error);
    return {
      success: false,
      message: error.message || '上传失败',
      error: error.stack,
      errorCode: error.code
    };
  }
}

/**
 * 测试接口连通性
 */
async function testConnection() {
  return {
    success: true,
    message: '请使用 previewOrderUploadData 或 testUploadOrder 来测试',
    config: {
      baseUrl: GUANGHUAN_CONFIG.Base_URL,
      apiId: GUANGHUAN_CONFIG.Api_ID
    }
  };
}

// 云函数入口函数
exports.main = async (event, context) => {
  const { action, orderNo } = event;
  
  try {
    switch (action) {
      case 'preview':
        return await previewOrderUploadData(orderNo);
        
      case 'upload':
        return await testUploadOrder(orderNo);
        
      case 'testConnection':
        return await testConnection();
        
      default:
        return {
          success: false,
          message: '未知的操作类型',
          availableActions: ['preview', 'upload', 'testConnection'],
          usage: '调用方式: { action: "preview", orderNo: "订单号" } 或 { action: "upload", orderNo: "订单号" }'
        };
    }
  } catch (error) {
    console.error('云函数执行错误:', error);
    return {
      success: false,
      message: error.message || '执行失败',
      error: error.stack
    };
  }
};
