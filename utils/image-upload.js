const backendRequest = require('./request').request;

const IMAGE_URL_CACHE_TTL = 5 * 60 * 1000;
const imageUrlCache = Object.create(null);

function chooseImages(options = {}) {
  const count = Math.max(1, Number(options.count || 1));
  const sourceType = options.sourceType || ['camera', 'album'];
  const success = typeof options.success === 'function' ? options.success : () => {};
  const fail = typeof options.fail === 'function' ? options.fail : () => {};

  if (wx.chooseMedia) {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType,
      success: result => success((result.tempFiles || []).map(item => item.tempFilePath).filter(Boolean)),
      fail
    });
    return;
  }

  wx.chooseImage({
    count,
    sourceType,
    sizeType: ['compressed'],
    success: result => success(result.tempFilePaths || []),
    fail
  });
}

function uploadImages(filePaths, folder) {
  const paths = (filePaths || []).filter(Boolean);
  if (!paths.length) return Promise.resolve([]);
  if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
    return Promise.reject(new Error('当前环境不支持图片上传'));
  }

  const batchId = Date.now();
  return Promise.all(paths.map((filePath, index) => new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `${folder}/${batchId}_${index}.jpg`,
      filePath,
      success: result => {
        if (result && result.fileID) resolve(result.fileID);
        else reject(new Error('图片上传未返回文件ID'));
      },
      fail: reject
    });
  })));
}

function imageValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.fileID || value.fileId || value.file_id || value.fileIDPath || value.file_path || value.filePath ||
    value.cloudPath || value.cloud_path || value.url || value.tempFileURL || value.tempFileUrl ||
    value.downloadUrl || value.downloadURL || value.download_url || value.fileUrl || value.file_url || '';
}

function normalizeImageValues(values) {
  if (typeof values === 'string') {
    try {
      const parsed = JSON.parse(values);
      if (parsed !== values) return normalizeImageValues(parsed);
    } catch (_) {
      return values ? [values] : [];
    }
    return values ? [values] : [];
  }
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    const value = imageValue(values);
    return value ? [value] : [];
  }
  const items = Array.isArray(values) ? values : (values ? [values] : []);
  return items.reduce((result, item) => result.concat(normalizeImageValues(item)), []);
}

function resolveImageUrlsViaBackend(values, cloudIds) {
  if (typeof backendRequest !== 'function' || !cloudIds.length) return Promise.resolve(null);
  return backendRequest({
    url: '/storage/file-urls',
    method: 'POST',
    data: { fileIds: cloudIds },
    retries: 0,
    silentErrors: true
  }).then(result => {
    const items = Array.isArray(result)
      ? result
      : (result && Array.isArray(result.items)
        ? result.items
        : (result && result.data && Array.isArray(result.data.items)
          ? result.data.items
          : (result && Array.isArray(result.data) ? result.data : [])));
    const urlMap = {};
    items.forEach(item => {
      const fileId = item && (item.fileId || item.fileID || item.file_id);
      const url = item && (item.url || item.tempFileURL || item.tempFileUrl || item.downloadUrl || item.download_url);
      if (fileId && /^https?:\/\//i.test(url || '')) urlMap[fileId] = url;
    });
    if (!Object.keys(urlMap).length) return null;
    const mappedValues = values.map(value => urlMap[value] || value);
    const remainingCloudIds = mappedValues.filter(value => /^cloud:\/\//i.test(value));
    return remainingCloudIds.length
      ? resolveImageUrlsViaCloud(mappedValues, remainingCloudIds)
      : mappedValues;
  }).catch(() => null);
}

function resolveImageUrlsViaCloud(values, cloudIds) {
  if (!wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') return Promise.resolve(values);
  return new Promise(resolve => {
    wx.cloud.getTempFileURL({
      fileList: cloudIds,
      success: result => {
        const urlMap = {};
        (result.fileList || []).forEach(item => {
          const fileID = item.fileID || item.fileId || item.file_id;
          const tempUrl = item.tempFileURL || item.tempFileUrl || item.url || item.downloadUrl || item.download_url;
          if (fileID && tempUrl) urlMap[fileID] = tempUrl;
        });
        resolve(values.map(value => urlMap[value] || value));
      },
      fail: () => resolve(values)
    });
  });
}

function resolveImageUrls(fileIds) {
  const values = [...new Set(normalizeImageValues(fileIds).filter(Boolean))];
  const now = Date.now();
  const getCachedUrl = value => {
    const cached = imageUrlCache[value];
    if (!cached || cached.expiresAt <= now) return '';
    return cached.url;
  };
  const cloudIds = values.filter(value => /^cloud:\/\//i.test(value) && !getCachedUrl(value));
  if (!cloudIds.length) return Promise.resolve(values.map(value => getCachedUrl(value) || value));
  const requestValues = values.map(value => getCachedUrl(value) || value);
  return resolveImageUrlsViaBackend(requestValues, cloudIds)
    .then(result => result || resolveImageUrlsViaCloud(requestValues, cloudIds))
    .then(resolvedValues => {
      resolvedValues.forEach((url, index) => {
        if (/^cloud:\/\//i.test(values[index]) && /^https?:\/\//i.test(url || '')) {
          imageUrlCache[values[index]] = { url, expiresAt: Date.now() + IMAGE_URL_CACHE_TTL };
        }
      });
      return values.map(value => getCachedUrl(value) || value);
    });
}

module.exports = {
  chooseImages,
  uploadImages,
  resolveImageUrls,
  imageValue,
  normalizeImageValues
};
