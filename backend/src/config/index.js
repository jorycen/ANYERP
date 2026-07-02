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

  // 分页配置
  page: {
    defaultSize: 20,
    maxSize: 100
  }
};
