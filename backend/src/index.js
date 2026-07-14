const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('koa-cors');
const static = require('koa-static');
const path = require('path');
const fs = require('fs');

const authRouter = require('./modules/auth/routes');
const salesRouter = require('./modules/sales/routes');
const inventoryRouter = require('./modules/inventory/routes');
const purchaseRouter = require('./modules/purchase/routes');
const financeRouter = require('./modules/finance/routes');
const productRouter = require('./modules/product/routes');
const storeRouter = require('./modules/store/routes');
const reportRouter = require('./modules/report/routes');
const systemRouter = require('./modules/system/routes');
const dictRouter = require('./modules/dict/routes');
const ocrRouter = require('./modules/ocr/routes');
const approvalRouter = require('./modules/approval/routes');

const { ensureDatabaseReady, markDatabaseUnhealthy } = require('./config/database');
const { runMigrations } = require('./utils/dbMigration');
const { errorHandler } = require('./middleware/errorHandler');
const { responseFormatter } = require('./middleware/responseFormatter');
const { databaseRecoveryMiddleware, databaseHealth } = require('./middleware/databaseRecovery');
const { authMiddleware, storeAccessMiddleware } = require('./middleware/auth');
const { applyPendingProductPriceChanges, recoverProductImportTasks } = require('./modules/product/controller');
const { refreshOutdatedGrossProfitSnapshots } = require('./modules/sales/grossProfit');
const { startDatabaseHeartbeat } = require('./utils/databaseHeartbeat');
const { recoverExecutingBatchApplications } = require('./modules/inventory/batchMaintenance');

const app = new Koa();
const PORT = process.env.PORT || 3000;

app.use(errorHandler);
app.use(responseFormatter);
app.use(cors());
app.use(bodyParser({
  jsonLimit: '10mb',
  formLimit: '10mb',
  textLimit: '10mb'
}));

const apiRouter = new Router({ prefix: '/api/v1' });

apiRouter.get('/health/db', databaseHealth);
apiRouter.use(databaseRecoveryMiddleware);
apiRouter.use('/auth', authRouter.routes());

apiRouter.use(authMiddleware);
apiRouter.use(storeAccessMiddleware);
apiRouter.use('/sales', salesRouter.routes());
apiRouter.use('/inventory', inventoryRouter.routes());
apiRouter.use('/purchase', purchaseRouter.routes());
apiRouter.use('/finance', financeRouter.routes());
apiRouter.use('/product', productRouter.routes());
apiRouter.use('/store', storeRouter.routes());
apiRouter.use('/report', reportRouter.routes());
apiRouter.use('/system', systemRouter.routes());
apiRouter.use('/dict', dictRouter.routes());
apiRouter.use('/ocr', ocrRouter.routes());
apiRouter.use('/approval', approvalRouter.routes());

app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

app.use(static(path.join(__dirname, '../public')));

app.use(async (ctx) => {
  const requestPath = ctx.path;
  const isApiRequest = requestPath === '/api' || requestPath.startsWith('/api/');
  const lastPathSegment = requestPath.slice(requestPath.lastIndexOf('/') + 1);
  const isStaticAssetRequest = Boolean(path.extname(lastPathSegment));

  // Only browser navigation URLs may fall back to the SPA entry point. API
  // errors and missing assets must remain 404s instead of receiving HTML.
  if ((ctx.method !== 'GET' && ctx.method !== 'HEAD') || isApiRequest || isStaticAssetRequest) {
    ctx.status = 404;
    return;
  }

  const indexPath = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    ctx.type = 'html';
    ctx.body = fs.createReadStream(indexPath);
  }
});

app.on('error', (err) => {
  console.error('Server Error:', err);
});

function startBackgroundJobs() {
  setInterval(async () => {
    try {
      const count = await applyPendingProductPriceChanges();
      if (count > 0) {
        console.log(`[ProductPrice] applied ${count} pending price changes`);
      }
    } catch (error) {
      console.error('[ProductPrice] pending price job failed:', error.message);
    }
  }, 60 * 1000);
}

function initializeDatabaseInBackground(retryDelayMs = Number(process.env.DB_STARTUP_RECOVERY_RETRY_MS || 60000)) {
  (async () => {
    try {
      await ensureDatabaseReady('startup database activation', { force: true });
      await runMigrations();
      const grossProfitMigration = await refreshOutdatedGrossProfitSnapshots();
      if (grossProfitMigration.total > 0) {
        console.log(
          `[GrossProfit] formula migration completed: ${grossProfitMigration.refreshed}/${grossProfitMigration.total}, failed ${grossProfitMigration.failed}`
        );
      }
      await ensureDatabaseReady('post-migration database activation', { force: true });
      await recoverExecutingBatchApplications();
      await recoverProductImportTasks();
      console.log('[Startup] database initialization completed');
    } catch (error) {
      markDatabaseUnhealthy(error);
      console.error('[Startup] database initialization failed, will retry in background:', error.message);
      setTimeout(() => initializeDatabaseInBackground(retryDelayMs), retryDelayMs).unref?.();
    }
  })();
}

function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`ANY-ERP server started: http://localhost:${PORT}`);
      console.log(`API: http://localhost:${PORT}/api/v1`);
    });

    initializeDatabaseInBackground();
    startBackgroundJobs();
    startDatabaseHeartbeat();
  } catch (error) {
    console.error('[Startup] failed to initialize server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
