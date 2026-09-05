/**
 * 配置文件
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const rootDir = path.resolve(__dirname, '../../..');
loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(rootDir, 'cloud-db.env'));
loadEnvFile(path.join(rootDir, 'backend', '.env'));
loadEnvFile(path.join(rootDir, '.env.local'));
loadEnvFile(path.join(rootDir, 'backend', '.env.local'));

module.exports = {
  // 数据库配置
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'any_erp',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  },

  // 数据库营业时段心跳配置
  databaseHeartbeat: {
    enabled: parseBoolean(process.env.DB_HEARTBEAT_ENABLED, true),
    startTime: process.env.DB_HEARTBEAT_START_TIME || '09:30',
    endTime: process.env.DB_HEARTBEAT_END_TIME || '23:00',
    intervalMs: parsePositiveInteger(process.env.DB_HEARTBEAT_INTERVAL_MS, 7 * 60 * 1000),
    timeZone: process.env.DB_HEARTBEAT_TIMEZONE || 'Asia/Shanghai',
    retryMax: parsePositiveInteger(process.env.DB_HEARTBEAT_RETRY_MAX, 3),
    retryDelayMs: parsePositiveInteger(process.env.DB_HEARTBEAT_RETRY_DELAY_MS, 2000)
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-env',
    expiresIn: '7d' // 7天过期
  },

  cloudStorage: {
    cloudbaseAccessKey: process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_API_KEY || process.env.CLOUD_BASE_APIKEY || process.env.CLOUD_BASE_API_KEY || process.env.TCB_API_KEY || '',
    cloudbaseSecretId: process.env.TENCENTCLOUD_SECRETID || process.env.TENCENTCLOUD_SECRET_ID || '',
    cloudbaseSecretKey: process.env.TENCENTCLOUD_SECRETKEY || process.env.TENCENTCLOUD_SECRET_KEY || '',
    cloudbaseSessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN || '',
    cloudbaseAuthAvailable: Boolean(
      process.env.CLOUDBASE_APIKEY ||
      process.env.CLOUDBASE_API_KEY ||
      process.env.CLOUD_BASE_APIKEY ||
      process.env.CLOUD_BASE_API_KEY ||
      process.env.TCB_API_KEY ||
      (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) ||
      (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) ||
      process.env.TENCENTCLOUD_SESSIONTOKEN ||
      process.env.TENCENTCLOUD_SESSION_TOKEN
    ),
    enabled: Boolean(
      process.env.CLOUDBASE_APIKEY ||
      process.env.CLOUDBASE_API_KEY ||
      process.env.CLOUD_BASE_APIKEY ||
      process.env.CLOUD_BASE_API_KEY ||
      process.env.TCB_API_KEY ||
      (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) ||
      (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) ||
      process.env.TENCENTCLOUD_SESSIONTOKEN ||
      process.env.TENCENTCLOUD_SESSION_TOKEN ||
      (process.env.COS_SECRET_ID || process.env.TENCENT_COS_SECRET_ID || process.env.TCB_COS_SECRET_ID) &&
      (process.env.COS_SECRET_KEY || process.env.TENCENT_COS_SECRET_KEY || process.env.TCB_COS_SECRET_KEY)
    ),
    envId: process.env.CLOUD_STORAGE_ENV_ID || 'cloud1-8glwjlnq4c74f7f1',
    bucket: process.env.COS_BUCKET || process.env.TCB_COS_BUCKET || '636c-cloud1-8glwjlnq4c74f7f1-1410946266',
    region: process.env.COS_REGION || process.env.TCB_COS_REGION || 'ap-shanghai',
    secretId: process.env.COS_SECRET_ID || process.env.TENCENT_COS_SECRET_ID || process.env.TCB_COS_SECRET_ID || '',
    secretKey: process.env.COS_SECRET_KEY || process.env.TENCENT_COS_SECRET_KEY || process.env.TCB_COS_SECRET_KEY || '',
    expiresSeconds: parsePositiveInteger(process.env.COS_URL_EXPIRES_SECONDS, 900),
    allowedPrefixes: String(process.env.COS_ALLOWED_PREFIXES || '')
      .split(',')
      .map(value => value.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
  },

  // 重庆光环（香港置地）订单上报。非敏感参数沿用旧配置，凭证从环境变量读取。
  guanghuan: {
    storeId: process.env.GUANGHUAN_STORE_ID || 'D0218911',
    mallCode: process.env.GUANGHUAN_MALL_CODE || 'GHL419',
    storeCode: process.env.GUANGHUAN_STORE_CODE || 'GHL419',
    tillId: process.env.GUANGHUAN_TILL_ID || '01',
    checkCode: process.env.GUANGHUAN_CHECK_CODE || '',
    appSubId: process.env.GUANGHUAN_APP_SUB_ID || '100001KKM',
    appToken: process.env.GUANGHUAN_APP_TOKEN || '',
    apiId: process.env.GUANGHUAN_API_ID || 'kukumao.orderCollect',
    apiVersion: process.env.GUANGHUAN_API_VERSION || '1.0.0',
    signMethod: process.env.GUANGHUAN_SIGN_METHOD || 'md5',
    format: process.env.GUANGHUAN_FORMAT || 'json',
    partnerId: process.env.GUANGHUAN_PARTNER_ID || '100001',
    sysId: process.env.GUANGHUAN_SYS_ID || '69b911cfb1816aaa6c8d8ab4',
    appPubId: process.env.GUANGHUAN_APP_PUB_ID || '10001',
    signKey: process.env.GUANGHUAN_SIGN_KEY || '',
    baseUrl: process.env.GUANGHUAN_BASE_URL || 'https://cdghkkm.hklring.com:10001/posbox/crland',
    timeoutMs: parsePositiveInteger(process.env.GUANGHUAN_TIMEOUT_MS, 30000)
  },

  // 分页配置
  page: {
    defaultSize: 20,
    maxSize: 100
  }
};
