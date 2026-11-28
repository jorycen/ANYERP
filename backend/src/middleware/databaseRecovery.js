const { ensureDatabaseReady, getDatabaseStatus } = require('../config/database');

async function databaseRecoveryMiddleware(ctx, next) {
  await ensureDatabaseReady('api request database activation');
  return next();
}

async function databaseHealth(ctx) {
  const status = getDatabaseStatus();

  ctx.status = status.ready ? 200 : 503;
  ctx.body = {
    code: ctx.status,
    data: status,
    message: status.ready ? '数据库已就绪' : '数据库未就绪'
  };
}

module.exports = {
  databaseRecoveryMiddleware,
  databaseHealth
};
