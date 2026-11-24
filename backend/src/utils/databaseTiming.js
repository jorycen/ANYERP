const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const timingContext = new AsyncLocalStorage();

function registerDatabaseTiming(sequelize) {
  const acquisitions = new WeakMap();
  const queries = new WeakMap();

  sequelize.addHook('beforePoolAcquire', options => {
    const timing = timingContext.getStore();
    if (!timing) return;
    const started = { timing, at: performance.now() };
    acquisitions.set(options, started);
    timing.pendingAcquisitions.add(started);
  });
  sequelize.addHook('afterPoolAcquire', (_connection, options) => {
    const started = acquisitions.get(options);
    if (!started) return;
    acquisitions.delete(options);
    started.timing.pendingAcquisitions.delete(started);
    started.timing.poolAcquireMaxMs = Math.max(
      started.timing.poolAcquireMaxMs, performance.now() - started.at
    );
  });
  sequelize.addHook('beforeQuery', (_options, query) => {
    const timing = timingContext.getStore();
    if (!timing) return;
    queries.set(query, { timing, at: performance.now() });
    timing.queryCount += 1;
  });
  sequelize.addHook('afterQuery', (_options, query) => {
    const started = queries.get(query);
    if (!started) return;
    queries.delete(query);
    started.timing.queryMaxMs = Math.max(
      started.timing.queryMaxMs, performance.now() - started.at
    );
  });
}

async function recordDatabaseTiming(label, thresholdMs, run, details = () => ({})) {
  const startedAt = performance.now();
  const timing = {
    poolAcquireMaxMs: 0,
    queryCount: 0,
    queryMaxMs: 0,
    pendingAcquisitions: new Set()
  };
  try {
    return await timingContext.run(timing, run);
  } finally {
    const finishedAt = performance.now();
    const elapsedMs = Math.round(finishedAt - startedAt);
    if (elapsedMs >= thresholdMs) {
      let unfinishedAcquireMaxMs = 0;
      for (const acquisition of timing.pendingAcquisitions) {
        unfinishedAcquireMaxMs = Math.max(unfinishedAcquireMaxMs, finishedAt - acquisition.at);
      }
      console.warn('[DB Timing]', JSON.stringify({
        label,
        ...details(),
        elapsedMs,
        poolAcquireMaxMs: Math.round(timing.poolAcquireMaxMs),
        unfinishedAcquireCount: timing.pendingAcquisitions.size,
        unfinishedAcquireMaxMs: Math.round(unfinishedAcquireMaxMs),
        queryCount: timing.queryCount,
        queryMaxMs: Math.round(timing.queryMaxMs)
      }));
    }
  }
}

module.exports = { registerDatabaseTiming, recordDatabaseTiming };
