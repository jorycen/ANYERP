const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const timingContext = new AsyncLocalStorage();
const stageContext = new AsyncLocalStorage();

async function recordDatabaseStage(label, run) {
  const timing = timingContext.getStore();
  if (!timing) return run();
  const stage = { label, elapsedMs: 0, queryCount: 0, queryMaxMs: 0, poolAcquireMaxMs: 0 };
  const startedAt = performance.now();
  timing.stages.push(stage);
  try {
    return await stageContext.run(stage, run);
  } finally {
    stage.elapsedMs = Math.round(performance.now() - startedAt);
  }
}

function registerDatabaseTiming(sequelize) {
  const acquisitions = new WeakMap();
  const queries = new WeakMap();

  sequelize.addHook('beforePoolAcquire', options => {
    const timing = timingContext.getStore();
    if (!timing) return;
    const started = { timing, stage: stageContext.getStore(), at: performance.now() };
    acquisitions.set(options, started);
    timing.pendingAcquisitions.add(started);
  });
  sequelize.addHook('afterPoolAcquire', (_connection, options) => {
    const started = acquisitions.get(options);
    if (!started) return;
    acquisitions.delete(options);
    started.timing.pendingAcquisitions.delete(started);
    const elapsed = Math.round(performance.now() - started.at);
    started.timing.poolAcquireMaxMs = Math.max(started.timing.poolAcquireMaxMs, elapsed);
    if (started.stage) started.stage.poolAcquireMaxMs = Math.max(started.stage.poolAcquireMaxMs, elapsed);
  });
  sequelize.addHook('beforeQuery', (_options, query) => {
    const timing = timingContext.getStore();
    if (!timing) return;
    const stage = stageContext.getStore();
    queries.set(query, { timing, stage, at: performance.now() });
    timing.queryCount += 1;
    if (stage) stage.queryCount += 1;
  });
  sequelize.addHook('afterQuery', (_options, query) => {
    const started = queries.get(query);
    if (!started) return;
    queries.delete(query);
    const elapsed = Math.round(performance.now() - started.at);
    if (elapsed > started.timing.queryMaxMs) {
      started.timing.queryMaxMs = elapsed;
      started.timing.queryMaxStage = started.stage?.label || null;
    }
    if (started.stage) started.stage.queryMaxMs = Math.max(started.stage.queryMaxMs, elapsed);
  });
}

async function recordDatabaseTiming(label, thresholdMs, run, details = () => ({})) {
  const startedAt = performance.now();
  const timing = {
    poolAcquireMaxMs: 0,
    queryCount: 0,
    queryMaxMs: 0,
    queryMaxStage: null,
    stages: [],
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
        queryMaxMs: timing.queryMaxMs,
        ...(timing.stages.length && { queryMaxStage: timing.queryMaxStage, stages: timing.stages })
      }));
    }
  }
}

module.exports = { registerDatabaseTiming, recordDatabaseTiming, recordDatabaseStage };
