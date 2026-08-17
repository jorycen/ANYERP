const requestConfig = require('./request.js');
const ocrConfig = require('./ocr-config.js');

function getApiBaseUrl() {
  return ocrConfig.apiBaseUrl || requestConfig.API_BASE_URL || '';
}

function getAuthToken() {
  return ocrConfig.token || (requestConfig.getToken ? requestConfig.getToken() : '') || '';
}

function normalizeResult(data) {
  if (!data) {
    return {
      couponCode: '',
      rawText: '',
      confidence: 0
    };
  }

  const payload = data.data || data;
  return {
    couponCode: payload.couponCode || payload.code || '',
    rawText: payload.rawText || payload.text || '',
    confidence: payload.confidence || 0,
    candidates: payload.candidates || []
  };
}

function recognizeCouponCode(filePath, options) {
  options = options || {};
  const apiBaseUrl = getApiBaseUrl();
  const token = getAuthToken();

  if (!apiBaseUrl) {
    return Promise.reject(new Error('OCR API地址未配置'));
  }

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: apiBaseUrl.replace(/\/$/, '') + '/ocr/coupon',
      filePath,
      name: 'image',
      timeout: options.timeout || 120000,
      formData: {
        scene: options.scene || 'coupon'
      },
      header: token ? {
        Authorization: 'Bearer ' + token
      } : {},
      success: res => {
        let body = res.data || {};
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (err) {
            reject(new Error('OCR返回结果解析失败'));
            return;
          }
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(body.message || body.error || ('OCR识别失败: ' + res.statusCode)));
          return;
        }

        if (body.code !== undefined && Number(body.code) !== 0 && Number(body.code) !== 200) {
          reject(new Error(body.message || body.error || 'OCR识别失败'));
          return;
        }

        resolve(normalizeResult(body));
      },
      fail: err => {
        reject(new Error((err && err.errMsg) || 'OCR上传失败'));
      }
    });
  });
}

module.exports = {
  recognizeCouponCode
};
