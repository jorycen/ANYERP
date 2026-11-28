const COS = require('cos-nodejs-sdk-v5');
const cloudbase = require('@cloudbase/node-sdk');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

let cosClient = null;
let cloudbaseApp = null;

function getCloudStorageConfig() {
  return config.cloudStorage;
}

function parseCloudFileId(fileId) {
  const raw = String(fileId || '').trim();
  if (!raw.startsWith('cloud://')) return null;

  const withoutScheme = raw.slice('cloud://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) return null;

  const bucketToken = withoutScheme.slice(0, slashIndex);
  const dotIndex = bucketToken.indexOf('.');
  return {
    fileId: raw,
    cloudEnv: dotIndex > 0 ? bucketToken.slice(0, dotIndex) : '',
    bucketName: dotIndex > 0 ? bucketToken.slice(dotIndex + 1) : bucketToken,
    key: withoutScheme.slice(slashIndex + 1)
  };
}

function getCosClient() {
  const storageConfig = getCloudStorageConfig();
  if (!storageConfig.enabled) return null;
  if (!cosClient) {
    cosClient = new COS({
      SecretId: storageConfig.secretId,
      SecretKey: storageConfig.secretKey
    });
  }
  return cosClient;
}

function getCloudbaseApp() {
  if (cloudbaseApp) return cloudbaseApp;
  const storageConfig = getCloudStorageConfig();
  cloudbaseApp = cloudbase.init({
    env: storageConfig.envId,
    ...(storageConfig.cloudbaseAccessKey ? { accessKey: storageConfig.cloudbaseAccessKey } : {}),
    ...(storageConfig.cloudbaseSecretId && storageConfig.cloudbaseSecretKey
      ? { secretId: storageConfig.cloudbaseSecretId, secretKey: storageConfig.cloudbaseSecretKey }
      : {}),
    ...(storageConfig.cloudbaseSessionToken ? { sessionToken: storageConfig.cloudbaseSessionToken } : {})
  });
  return cloudbaseApp;
}

function normalizeUploadCategory(category) {
  const value = String(category || 'general').trim().toLowerCase();
  const normalized = value.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'general';
}

function normalizeFileExtension(originalName, mimeType) {
  const originalExt = path.extname(String(originalName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(originalExt)) return originalExt;
  const mimeExt = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf'
  }[String(mimeType || '').toLowerCase()];
  return mimeExt || '';
}

async function uploadCloudFile({ buffer, originalName, mimeType, category = 'general' }) {
  const storageConfig = getCloudStorageConfig();
  const canUseCloudbase = storageConfig.cloudbaseAuthAvailable;
  const canUseCos = Boolean(storageConfig.secretId && storageConfig.secretKey);
  if (!storageConfig.enabled || (!canUseCloudbase && !canUseCos)) {
    throw Object.assign(new Error('云存储上传凭证未配置'), {
      status: 503,
      code: 'CLOUD_STORAGE_NOT_CONFIGURED'
    });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('上传文件内容为空'), { status: 400, code: 'EMPTY_UPLOAD_FILE' });
  }

  const now = new Date();
  const datePath = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0')].join('/');
  const extension = normalizeFileExtension(originalName, mimeType);
  const key = `${normalizeUploadCategory(category)}/${datePath}/${crypto.randomUUID()}${extension}`;
  let fileId;
  if (canUseCloudbase) {
    const result = await getCloudbaseApp().uploadFile({ cloudPath: key, fileContent: buffer });
    fileId = result && (result.fileID || result.fileId);
  } else {
    await getCosClient().putObject({
      Bucket: storageConfig.bucket,
      Region: storageConfig.region,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream'
    });
    fileId = `cloud://${storageConfig.envId}.${storageConfig.bucket}/${key}`;
  }
  if (!fileId) {
    throw Object.assign(new Error('云存储未返回文件标识'), { status: 502, code: 'CLOUD_STORAGE_UPLOAD_EMPTY' });
  }
  const resolved = await getSignedCloudFileUrl(fileId);
  return {
    fileId,
    url: resolved.url,
    expiresIn: resolved.expiresIn,
    source: resolved.source,
    key,
    originalName: String(originalName || '').slice(0, 255),
    mimeType: String(mimeType || '').slice(0, 128),
    size: buffer.length
  };
}

function validateCloudFileId(fileId) {
  const parsed = parseCloudFileId(fileId);
  if (!parsed) throw Object.assign(new Error('无效的云存储文件标识'), { status: 400, code: 'INVALID_CLOUD_FILE_ID' });

  const storageConfig = getCloudStorageConfig();
  if (parsed.cloudEnv !== storageConfig.envId || parsed.bucketName !== storageConfig.bucket) {
    throw Object.assign(new Error('云存储文件所属环境或存储桶不匹配'), {
      status: 400,
      code: 'CLOUD_FILE_SCOPE_MISMATCH'
    });
  }
  if (parsed.key.includes('..') || parsed.key.startsWith('/')) {
    throw Object.assign(new Error('云存储文件路径不合法'), { status: 400, code: 'INVALID_CLOUD_FILE_PATH' });
  }
  if (storageConfig.allowedPrefixes.length && !storageConfig.allowedPrefixes.some(prefix => (
    parsed.key === prefix || parsed.key.startsWith(`${prefix}/`)
  ))) {
    throw Object.assign(new Error('云存储文件目录不在允许范围内'), { status: 403, code: 'CLOUD_FILE_PREFIX_DENIED' });
  }
  return parsed;
}

function getSignedCloudFileUrl(fileId) {
  const storageConfig = getCloudStorageConfig();
  const parsed = validateCloudFileId(fileId);

  return Promise.resolve().then(async () => {
    try {
      if (!storageConfig.cloudbaseAuthAvailable) {
        throw Object.assign(new Error('云存储服务未发现服务端身份配置'), { code: 'CLOUD_STORAGE_AUTH_MISSING' });
      }
      const result = await getCloudbaseApp().getTempFileURL({
        fileList: [{ fileID: parsed.fileId, maxAge: storageConfig.expiresSeconds }]
      });
      const item = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
      const url = item && (item.tempFileURL || item.tempFileUrl || item.url);
      if (url) {
        return {
          fileId: parsed.fileId,
          url,
          key: parsed.key,
          expiresIn: storageConfig.expiresSeconds,
          source: 'cloudbase-node-sdk'
        };
      }
      const sdkError = new Error((item && (item.message || item.errMsg)) || (result && result.message) || '云存储服务未返回临时地址');
      sdkError.code = (item && item.code) || (result && result.code) || 'CLOUD_STORAGE_EMPTY_URL';
      throw sdkError;
    } catch (cloudbaseError) {
      if (!storageConfig.enabled) {
        throw Object.assign(new Error('后台未配置云存储访问凭证或云托管身份'), {
          status: 503,
          code: 'CLOUD_STORAGE_NOT_CONFIGURED',
          cause: cloudbaseError
        });
      }

      const client = getCosClient();
      return new Promise((resolve, reject) => {
        client.getObjectUrl({
          Bucket: parsed.bucketName,
          Region: storageConfig.region,
          Key: parsed.key,
          Sign: true,
          Expires: storageConfig.expiresSeconds
        }, (error, data) => {
          if (error) {
            reject(error);
            return;
          }
          const url = data && (data.Url || data.url);
          if (!url) {
            reject(Object.assign(new Error('云存储未返回临时地址'), { code: 'CLOUD_STORAGE_EMPTY_URL' }));
            return;
          }
          resolve({
            fileId: parsed.fileId,
            url,
            key: parsed.key,
            expiresIn: storageConfig.expiresSeconds,
            source: 'cos-signed-url'
          });
        });
      });
    }
  });
}

module.exports = {
  getCloudStorageConfig,
  parseCloudFileId,
  validateCloudFileId,
  getSignedCloudFileUrl,
  uploadCloudFile
};
