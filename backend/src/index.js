/**
 * ANY-ERP 后端服务入口
 */
 

const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('koa-cors');
const static = require('koa-static');
const path = require('path');
const fs = require('fs');

// 导入路由
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

// 导入中间件
const { errorHandler } = require('./middleware/errorHandler');
const { responseFormatter } = require('./middleware/responseFormatter');
const { authMiddleware } = require('./middleware/auth');
const { applyPendingProductPriceChanges } = require('./modules/product/controller');

const app = new Koa();

const { runMigrations } = require('./utils/dbMigration');

// 启动时运行数据库迁移
(async () => {
  await runMigrations();
})();

// 配置
const PORT = process.env.PORT || 3000;

// 全局中间件
app.use(errorHandler);
app.use(responseFormatter);
app.use(cors());
app.use(bodyParser({
  jsonLimit: '10mb',
  formLimit: '10mb',
  textLimit: '10mb'
}));

// API 路由组
const apiRouter = new Router({ prefix: '/api/v1' });

// 公开接口（无需鉴权）
apiRouter.use('/auth', authRouter.routes());

// 需要鉴权的接口
apiRouter.use(authMiddleware);
apiRouter.use('/sales', salesRouter.routes());
apiRouter.use('/inventory', inventoryRouter.routes());
apiRouter.use('/purchase', purchaseRouter.routes());
apiRouter.use('/finance', financeRouter.routes());
apiRouter.use('/product', productRouter.routes());
apiRouter.use('/store', storeRouter.routes());
apiRouter.use('/report', reportRouter.routes());
apiRouter.use('/system', systemRouter.routes());
apiRouter.use('/dict', dictRouter.routes());

app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

// 静态文件服务
app.use(static(path.join(__dirname, '../public')));

// SPA 回退：非 API 路径返回 index.html
app.use(async (ctx) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    ctx.type = 'html';
    ctx.body = fs.createReadStream(indexPath);
  }
});

// 错误处理
app.on('error', (err, ctx) => {
  console.error('Server Error:', err);
});

app.listen(PORT, () => {
  console.log(`ANY-ERP 服务已启动: http://localhost:${PORT}`);
  console.log(`API地址: http://localhost:${PORT}/api/v1`);
});

setInterval(async () => {
  try {
    const count = await applyPendingProductPriceChanges();
    if (count > 0) {
      console.log(`[ProductPrice] 已生效 ${count} 条预约价格变更`);
    }
  } catch (error) {
    console.error('[ProductPrice] 预约价格生效任务失败:', error.message);
  }
}, 60 * 1000);

module.exports = app;
