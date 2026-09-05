const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const { guanghuan: defaultConfig } = require('../../config');

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function chinaParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('订单时间无效');
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: china.getUTCFullYear(),
    month: pad(china.getUTCMonth() + 1),
    day: pad(china.getUTCDate()),
    hour: pad(china.getUTCHours()),
    minute: pad(china.getUTCMinutes()),
    second: pad(china.getUTCSeconds()),
    millisecond: pad(china.getUTCMilliseconds(), 3)
  };
}

function formatRequestTimestamp(value = new Date()) {
  const p = chinaParts(value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}:${p.millisecond}`;
}

function formatOrderTime(value) {
  const p = chinaParts(value);
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

function normalizeAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function paymentMethodCode(value) {
  const method = String(value || '').trim().toLowerCase();
  if (method.includes('现金') || method === 'cash') return 'CH';
  if (method.includes('支付宝') || method.includes('alipay')) return 'AP';
  if (method.includes('微信') || method.includes('wechat')) return 'WP';
  if (method.includes('银行卡') || method.includes('银联') || method.includes('bank')) return 'CI';
  return 'OT';
}

function buildRequestData(order, config = defaultConfig) {
  const plain = typeof order?.toJSON === 'function' ? order.toJSON() : order || {};
  const items = plain.OrderItems || plain.orderItems || [];
  const payments = plain.OrderPayments || plain.orderPayments || [];
  if (!plain.order_no) throw new Error('订单号为空，不能上报商场');
  if (!items.length) throw new Error('订单没有商品明细，不能上报商场');
  if (!payments.length) throw new Error('订单没有收款明细，不能上报商场');

  const orderTime = plain.submit_time || plain.create_time || new Date();
  return {
    cashierId: String(plain.create_staff_id || plain.create_user || plain.submit_user || 'ERP'),
    checkCode: config.checkCode,
    itemList: items.map(item => ({
      itemCode: String(item.pn_code || item.product_id || '').trim(),
      price: normalizeAmount(item.sale_price),
      quantity: Number(item.quantity || 1)
    })),
    mall: config.mallCode,
    mobile: String(plain.customer_phone || ''),
    orderId: String(plain.order_no),
    comments: String(plain.order_no),
    payList: payments.map(payment => ({
      cardBank: '',
      cardNumber: '',
      discountAmt: 0,
      payAmt: normalizeAmount(payment.amount),
      paymentMethod: paymentMethodCode(payment.payment_method),
      time: formatOrderTime(payment.payment_time || orderTime),
      value: normalizeAmount(payment.amount)
    })),
    store: config.storeCode,
    tillId: config.tillId,
    time: formatOrderTime(orderTime),
    totalAmt: normalizeAmount(plain.total_amount),
    type: 'SALE',
    refOrderId: '',
    source: '01'
  };
}

function createSignature(attributes, requestData, signKey) {
  const pairs = Object.entries({ ...attributes, REQUEST_DATA: JSON.stringify(requestData) })
    .filter(([key]) => key !== 'Sign')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return crypto.createHash('md5').update(`${pairs.join('&')}&${signKey}`, 'utf8').digest('hex').toUpperCase();
}

function buildPayload(order, config = defaultConfig, now = new Date()) {
  const requestData = buildRequestData(order, config);
  const attributes = {
    Api_ID: config.apiId,
    Api_Version: config.apiVersion,
    App_Pub_ID: config.appPubId,
    App_Sub_ID: config.appSubId,
    App_Token: config.appToken,
    Format: config.format,
    Partner_ID: config.partnerId,
    Sign_Method: config.signMethod,
    Sys_ID: config.sysId,
    Time_Stamp: formatRequestTimestamp(now)
  };
  attributes.Sign = createSignature(attributes, requestData, config.signKey);
  return { REQUEST: { HRT_ATTRS: attributes, REQUEST_DATA: requestData } };
}

function validateConfig(config) {
  const missing = [
    ['GUANGHUAN_CHECK_CODE', config.checkCode],
    ['GUANGHUAN_APP_TOKEN', config.appToken],
    ['GUANGHUAN_SIGN_KEY', config.signKey]
  ].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
  if (missing.length) {
    const error = new Error(`重庆光环接口凭证未配置：${missing.join('、')}`);
    error.code = 'GUANGHUAN_CONFIG_MISSING';
    error.retryable = false;
    throw error;
  }
}

function parseMallResponse(body) {
  const root = body?.RESPONSE || body || {};
  const returnData = root.RETURN_DATA || {};
  const header = returnData.header || returnData.HEADER || {};
  const code = String(header.errcode ?? header.errCode ?? root.RETURN_CODE ?? '').trim();
  const message = String(header.errmsg ?? header.errMsg ?? root.RETURN_DESC ?? root.RETURN_MESSAGE ?? '').trim();
  if (code === '0000' || code === '100') return { code, message: message || '成功', raw: body };
  const error = new Error(message || `光环接口返回失败（${code || '无返回码'}）`);
  error.code = code || 'MALL_RESPONSE_ERROR';
  error.retryable = false;
  throw error;
}

function postJson(urlText, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const body = JSON.stringify(payload);
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`光环接口 HTTP ${response.statusCode}`);
          error.retryable = response.statusCode >= 500;
          reject(error);
          return;
        }
        try { resolve(JSON.parse(text)); } catch (_) {
          const error = new Error('光环接口返回了无效 JSON');
          error.retryable = false;
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('光环接口请求超时')));
    request.on('error', error => {
      if (error.retryable === undefined) error.retryable = true;
      reject(error);
    });
    request.end(body);
  });
}

async function reportOrder(order, options = {}) {
  const config = options.config || defaultConfig;
  validateConfig(config);
  const transport = options.transport || postJson;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await transport(config.baseUrl, buildPayload(order, config), config.timeoutMs);
      return parseMallResponse(response);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === 2) break;
    }
  }
  throw lastError;
}

module.exports = {
  reportOrder,
  buildPayload,
  buildRequestData,
  createSignature,
  formatRequestTimestamp,
  formatOrderTime,
  paymentMethodCode,
  parseMallResponse,
  validateConfig,
  postJson
};
