const COS = require('cos-nodejs-sdk-v5');
const cloudbase = require('@cloudbase/node-sdk');
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
  getSignedCloudFileUrl
};
