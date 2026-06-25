const { Sequelize } = require('sequelize');
const config = require('./index');

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];
const TRANSIENT_DB_ERROR_PATTERNS = [
  /SequelizeConnectionError/i,
  /SequelizeConnectionRefusedError/i,
  /SequelizeHostNotReachableError/i,
  /SequelizeHostNotFoundError/i,
  /SequelizeConnectionTimedOutError/i,
  /SequelizeConnectionAcquireTimeoutError/i,
  /Connection lost/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /PROTOCOL_CONNECTION_LOST/i,
  /PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR/i,
  /PROTOCOL_ENQUEUE_AFTER_QUIT/i,
  /read ECONNRESET/i
];

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorText(error) {
  return [
    error?.name,
    error?.code,
    error?.errno,
    error?.message,
    error?.parent?.code,
    error?.parent?.errno,
    error?.parent?.message,
    error?.original?.code,
    error?.original?.errno,
    error?.original?.message
  ].filter(Boolean).join(' ');
}

function isTransientDatabaseError(error) {
  const text = getErrorText(error);
  return TRANSIENT_DB_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

const poolMax = parseInteger(process.env.DB_POOL_MAX, 10);
const poolMin = Math.min(parseInteger(process.env.DB_POOL_MIN, 0), poolMax);
const connectTimeout = parseInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10000);
const acquireTimeout = parseInteger(process.env.DB_POOL_ACQUIRE_MS, 10000);
const idleTimeout = parseInteger(process.env.DB_POOL_IDLE_MS, 60000);
const evictInterval = parseInteger(process.env.DB_POOL_EVICT_MS, 30000);

const sequelize = new Sequelize(
  config.database.database,
  config.database.username,
  config.database.password,
  {
    host: config.database.host,
    port: config.database.port,
    dialect: 'mysql',
    charset: config.database.charset,
    logging: config.database.logging,
    pool: {
      max: poolMax,
      min: poolMin,
      acquire: acquireTimeout,
      idle: idleTimeout,
      evict: evictInterval
    },
    dialectOptions: {
      charset: 'utf8mb4',
      connectTimeout
    },
    retry: {
      match: TRANSIENT_DB_ERROR_PATTERNS,
      max: parseInteger(process.env.DB_QUERY_RETRY_MAX, 3),
      backoffBase: 1000,
      backoffExponent: 2
    }
  }
);

async function withDatabaseRetry(operation, label = 'database operation', retryDelays = DEFAULT_RETRY_DELAYS) {
  let lastError;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < retryDelays.length && isTransientDatabaseError(error);
      if (!shouldRetry) {
        throw error;
      }

      const delay = retryDelays[attempt];
      console.warn(`[DB] ${label} failed, retry ${attempt + 1}/${retryDelays.length} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function warmupDatabase(label = 'startup warmup') {
  await withDatabaseRetry(async () => {
    await sequelize.authenticate();
    await sequelize.query('SELECT 1');
  }, label);

  console.log(`[DB] ${label} completed`);
}

console.log(
  `[DB Config] MySQL ${config.database.username}@${config.database.host}:${config.database.port}/${config.database.database}, pool min=${poolMin}, max=${poolMax}`
);

module.exports = {
  sequelize,
  Sequelize,
  warmupDatabase,
  withDatabaseRetry,
  isTransientDatabaseError
};
