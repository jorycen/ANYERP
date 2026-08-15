const API_BASE_URL = 'https://anyerp-api-249791-6-1410946266.sh.run.tcloudbase.com/api/v1';
const CLOUDBASE_ENV_ID = 'cloud1-8glwjlnq4c74f7f1';
const CLOUD_RUN_SERVICE = 'anyerp-api';
const API_PREFIX = '/api/v1';
const TOKEN_KEY = 'anyerpToken';
const accessControl = require('../pages/profile/user-utils.js');
const inFlightMutations = new Map();

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => (
      JSON.stringify(key) + ':' + stableSerialize(value[key])
    )).join(',') + '}';
  }
  return JSON.stringify(value);
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || wx.getStorageSync('authToken') || '';
}

function setToken(token) {
  if (token) {
    wx.setStorageSync(TOKEN_KEY, token);
    wx.setStorageSync('authToken', token);
  }
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync('authToken');
}

function buildUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return API_BASE_URL + (path.charAt(0) === '/' ? path : '/' + path);
}

function buildContainerPath(path) {
  if (/^https?:\/\//.test(path)) {
    const index = path.indexOf(API_PREFIX);
    return index >= 0 ? path.slice(index) : path;
  }

  const normalizedPath = path.charAt(0) === '/' ? path : '/' + path;
  return normalizedPath.indexOf(API_PREFIX) === 0 ? normalizedPath : API_PREFIX + normalizedPath;
}

function unwrapResponse(body) {
  if (!body) return body;
  if (body.code === 0 || body.code === 200) {
    return body.data !== undefined ? body.data : body;
  }
  if (body.code !== undefined) {
    const error = new Error(body.message || body.error || 'Request failed');
    const responseCode = Number(body.code);
    if (responseCode) error.statusCode = responseCode;
    error.body = body;
    throw error;
  }
  return body;
}

function isHtmlResponse(data) {
  return typeof data === 'string' && /<!doctype html|<html/i.test(data);
}

function shouldFallbackToHttpResponse(res) {
  const status = res && res.statusCode;
  return status === 404 || status === 405 || isHtmlResponse(res && res.data);
}

function handleResponse(res, resolve, reject, options = {}) {
  const status = res.statusCode;
  const body = res.data || {};

  if (status === 401) {
    clearToken();
    const error = new Error(body.message || 'Login expired');
    error.statusCode = 401;
    error.body = body;
    reject(error);
    return;
  }

  if (status < 200 || status >= 300) {
    if (!options.silentErrors) {
      console.error('API响应失败:', {
        statusCode: status,
        body: body
      });
    }
    const error = new Error(body.message || body.error || ('Request failed: ' + status));
    error.statusCode = status;
    error.body = body;
    reject(error);
    return;
  }

  try {
    resolve(unwrapResponse(body));
  } catch (err) {
    reject(err);
  }
}

function isContainerTimeout(err) {
  const message = err && (err.errMsg || err.message || JSON.stringify(err));
  return String(message || '').indexOf('102002') >= 0 ||
    String(message || '').indexOf('请求超时') >= 0 ||
    String(message || '').indexOf('timeout') >= 0;
}

function isRetryableError(err) {
  const statusCode = Number(err && err.statusCode);
  if (!statusCode) return true;
  return statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestByHttp(opts, method, header, resolve, reject) {
  wx.request({
    url: buildUrl(opts.url),
    method,
    data: opts.data || {},
    header,
    timeout: opts.timeout || 30000,
    success: (res) => handleResponse(res, resolve, reject, opts),
    fail: (err) => reject(new Error(err.errMsg || 'Network request failed'))
  });
}

function requestOnce(opts) {
  const method = opts.method || 'GET';
  const header = Object.assign({
    'content-type': 'application/json'
  }, opts.header || {});

  const token = getToken();
  if (opts.auth !== false && token) {
    header.Authorization = 'Bearer ' + token;
  }

  return new Promise((resolve, reject) => {
    const success = (res) => {
      if (wx.request && shouldFallbackToHttpResponse(res)) {
        console.warn('cloud.callContainer returned route fallback response, retry HTTPS:', {
          statusCode: res.statusCode,
          url: opts.url
        });
        requestByHttp(opts, method, header, resolve, reject);
        return;
      }
      handleResponse(res, resolve, reject, opts);
    };
    const fail = (err) => {
      console.warn('cloud.callContainer failed, fallback to HTTPS:', err);
      if (wx.request) {
        requestByHttp(opts, method, header, resolve, reject);
        return;
      }
      reject(new Error(err.errMsg || 'Network request failed'));
    };

    if (wx.cloud && wx.cloud.callContainer) {
      wx.cloud.callContainer({
        config: { env: CLOUDBASE_ENV_ID },
        path: buildContainerPath(opts.url),
        method,
        data: opts.data || {},
        timeout: opts.timeout || 30000,
        header: Object.assign({ 'X-WX-SERVICE': CLOUD_RUN_SERVICE }, header),
        success,
        fail
      });
      return;
    }

    requestByHttp(opts, method, header, resolve, reject);
  });
}

function request(options) {
  const opts = typeof options === 'string' ? { url: options } : Object.assign({}, options);
  const method = String(opts.method || 'GET').toUpperCase();
  if (!accessControl.canUsePurchaseQueryApi(opts.url, method)) {
    return Promise.reject(new Error('当前账号仅允许查询采购申请'));
  }
  const maxRetries = opts.retries !== undefined
    ? Math.max(0, Number(opts.retries) || 0)
    : (method === 'GET' ? 1 : 0);
  const retryDelay = Math.max(0, Number(opts.retryDelay) || 800);

  const run = attempt => requestOnce(opts).catch(err => {
    if (attempt >= maxRetries || !isRetryableError(err)) {
      throw err;
    }

    const delay = retryDelay * (attempt + 1);
    console.warn('API请求暂时失败，准备重试:', {
      url: opts.url,
      attempt: attempt + 1,
      delay,
      message: err && err.message
    });
    return wait(delay).then(() => run(attempt + 1));
  });

  // 同一页面快速连点时，复用同一个进行中的写请求，避免后端创建重复单据。
  // 只合并进行中的请求；请求结束后仍允许用户按业务需要重新提交。
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (!isMutation || opts.dedupe === false) return run(0);

  const dedupeKey = [
    method,
    buildUrl(opts.url),
    getToken(),
    stableSerialize(opts.data || {})
  ].join('\n');
  const pending = inFlightMutations.get(dedupeKey);
  if (pending) return pending;

  const requestPromise = run(0);
  inFlightMutations.set(dedupeKey, requestPromise);
  requestPromise.then(
    () => { if (inFlightMutations.get(dedupeKey) === requestPromise) inFlightMutations.delete(dedupeKey); },
    () => { if (inFlightMutations.get(dedupeKey) === requestPromise) inFlightMutations.delete(dedupeKey); }
  );
  return requestPromise;
}

module.exports = {
  API_BASE_URL,
  CLOUDBASE_ENV_ID,
  CLOUD_RUN_SERVICE,
  TOKEN_KEY,
  getToken,
  setToken,
  clearToken,
  request
};
