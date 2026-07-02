const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTime,
  normalizeHeartbeatConfig,
  isWithinHeartbeatWindow,
  getDelayUntilNextWindow
} = require('../src/utils/databaseHeartbeat');

const heartbeatConfig = normalizeHeartbeatConfig({
  enabled: true,
  startTime: '09:30',
  endTime: '23:00',
  intervalMs: 420000,
  timeZone: 'Asia/Shanghai',
  retryMax: 3,
  retryDelayMs: 2000
});

test('parseTime accepts HH:mm and rejects invalid values', () => {
  assert.equal(parseTime('09:30'), 570);
  assert.equal(parseTime('23:00'), 1380);
  assert.equal(parseTime('9:30'), null);
  assert.equal(parseTime('24:00'), null);
});

test('heartbeat window includes 09:30 and excludes 23:00 in Asia/Shanghai', () => {
  assert.equal(
    isWithinHeartbeatWindow(new Date('2026-07-02T01:29:59.999Z'), heartbeatConfig),
    false
  );
  assert.equal(
    isWithinHeartbeatWindow(new Date('2026-07-02T01:30:00.000Z'), heartbeatConfig),
    true
  );
  assert.equal(
    isWithinHeartbeatWindow(new Date('2026-07-02T14:59:59.999Z'), heartbeatConfig),
    true
  );
  assert.equal(
    isWithinHeartbeatWindow(new Date('2026-07-02T15:00:00.000Z'), heartbeatConfig),
    false
  );
});

test('next window delay targets 09:30 Asia/Shanghai', () => {
  assert.equal(
    getDelayUntilNextWindow(new Date('2026-07-02T01:29:30.000Z'), heartbeatConfig),
    30 * 1000
  );
  assert.equal(
    getDelayUntilNextWindow(new Date('2026-07-02T15:00:00.000Z'), heartbeatConfig),
    10.5 * 60 * 60 * 1000
  );
});

test('heartbeat window configuration rejects invalid or overnight ranges', () => {
  assert.throws(
    () => normalizeHeartbeatConfig({ ...heartbeatConfig, startTime: '23:00', endTime: '09:30' }),
    /start must be earlier than end/
  );
  assert.throws(
    () => normalizeHeartbeatConfig({ ...heartbeatConfig, timeZone: 'Invalid/Timezone' }),
    RangeError
  );
});
