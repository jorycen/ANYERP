const config = require('../config');
const { sequelize, withDatabaseRetry } = require('../config/database');

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let heartbeatTimer = null;
let heartbeatStopped = true;

function parseTime(value) {
  const match = TIME_PATTERN.exec(String(value || '').trim());
  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

function getZonedTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );

  return {
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: date.getMilliseconds()
  };
}

function getMillisecondsOfDay(parts) {
  return (
    parts.hour * 60 * MINUTE_MS
    + parts.minute * MINUTE_MS
    + parts.second * 1000
    + parts.millisecond
  );
}

function isWithinHeartbeatWindow(date, heartbeatConfig) {
  const currentMs = getMillisecondsOfDay(getZonedTimeParts(date, heartbeatConfig.timeZone));
  const startMs = heartbeatConfig.startMinutes * MINUTE_MS;
  const endMs = heartbeatConfig.endMinutes * MINUTE_MS;
  return currentMs >= startMs && currentMs < endMs;
}

function getDelayUntilNextWindow(date, heartbeatConfig) {
  const currentMs = getMillisecondsOfDay(getZonedTimeParts(date, heartbeatConfig.timeZone));
  const startMs = heartbeatConfig.startMinutes * MINUTE_MS;

  if (currentMs < startMs) {
    return startMs - currentMs;
  }

  return DAY_MS - currentMs + startMs;
}

function normalizeHeartbeatConfig(rawConfig) {
  const startMinutes = parseTime(rawConfig.startTime);
  const endMinutes = parseTime(rawConfig.endTime);

  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    throw new Error('数据库心跳开始/结束时间必须使用 HH:mm 格式，且开始时间必须早于结束时间');
  }

  // Validate the configured IANA time zone before the scheduler starts.
  new Intl.DateTimeFormat('en-US', { timeZone: rawConfig.timeZone }).format(new Date());

  return {
    ...rawConfig,
    startMinutes,
    endMinutes
  };
}

async function executeDatabaseHeartbeat(heartbeatConfig) {
  const retryDelays = Array.from(
    { length: heartbeatConfig.retryMax },
    () => heartbeatConfig.retryDelayMs
  );
  const startedAt = Date.now();

  try {
    await withDatabaseRetry(
      () => sequelize.query('SELECT 1', { retry: { max: 0 } }),
      'scheduled heartbeat',
      retryDelays
    );
    console.log(`[DB Heartbeat] completed in ${Date.now() - startedAt}ms`);
  } catch (error) {
    // Heartbeat availability must never determine whether the HTTP service stays alive.
    console.error(`[DB Heartbeat] failed after ${heartbeatConfig.retryMax} retries: ${error.message}`);
  }
}

function scheduleHeartbeatCycle(heartbeatConfig, delayMs) {
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null;
    runHeartbeatCycle(heartbeatConfig).catch(error => {
      console.error(`[DB Heartbeat] scheduler error: ${error.message}`);
      if (!heartbeatStopped) {
        scheduleHeartbeatCycle(heartbeatConfig, heartbeatConfig.intervalMs);
      }
    });
  }, Math.max(1, delayMs));
  heartbeatTimer.unref?.();
}

async function runHeartbeatCycle(heartbeatConfig) {
  if (heartbeatStopped) return;

  const now = new Date();
  if (!isWithinHeartbeatWindow(now, heartbeatConfig)) {
    scheduleHeartbeatCycle(heartbeatConfig, getDelayUntilNextWindow(now, heartbeatConfig));
    return;
  }

  const cycleStartedAt = Date.now();
  await executeDatabaseHeartbeat(heartbeatConfig);

  if (heartbeatStopped) return;
  const elapsedMs = Date.now() - cycleStartedAt;
  scheduleHeartbeatCycle(heartbeatConfig, Math.max(1, heartbeatConfig.intervalMs - elapsedMs));
}

function startDatabaseHeartbeat() {
  if (!config.databaseHeartbeat.enabled) {
    console.log('[DB Heartbeat] disabled');
    return;
  }

  if (heartbeatTimer || !heartbeatStopped) {
    return;
  }

  let heartbeatConfig;
  try {
    heartbeatConfig = normalizeHeartbeatConfig(config.databaseHeartbeat);
  } catch (error) {
    console.error(`[DB Heartbeat] invalid configuration, scheduler disabled: ${error.message}`);
    return;
  }

  heartbeatStopped = false;
  console.log(
    `[DB Heartbeat] enabled ${heartbeatConfig.startTime}-${heartbeatConfig.endTime} `
    + `${heartbeatConfig.timeZone}, interval=${heartbeatConfig.intervalMs}ms`
  );
  runHeartbeatCycle(heartbeatConfig).catch(error => {
    console.error(`[DB Heartbeat] scheduler error: ${error.message}`);
    if (!heartbeatStopped) {
      scheduleHeartbeatCycle(heartbeatConfig, heartbeatConfig.intervalMs);
    }
  });
}

function stopDatabaseHeartbeat() {
  heartbeatStopped = true;
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

module.exports = {
  startDatabaseHeartbeat,
  stopDatabaseHeartbeat,
  parseTime,
  normalizeHeartbeatConfig,
  isWithinHeartbeatWindow,
  getDelayUntilNextWindow
};
