/**
 * ANY-ERP 后端服务入口
 */
const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('koa-cors');
const static = require('koa-static');
const path = require('path');

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

// 导入中间件
const { errorHandler } = require('./middleware/errorHandler');
const { responseFormatter } = require('./middleware/responseFormatter');
const { authMiddleware } = require('./middleware/auth');

const app = new Koa();
const router = new Router();

// 配置
const PORT = process.env.PORT || 3000;

// 全局中间件
app.use(errorHandler);
app.use(responseFormatter);
app.use(cors());
app.use(bodyParser());
app.use(static(path.join(__dirname, '../public')));

// 路由配置
router.get('/', async (ctx) => {
  ctx.body = {
    code: 0,
    message: 'ANY-ERP API 服务运行中',
    data: {
      version: '1.0.0',
      time: new Date().toISOString()
    }
  };
});

// API 路由组
const apiRouter = new Router({ prefix: '/api/v1' });

// 健康检查
apiRouter.get('/health', async (ctx) => {
  try {
    const { sequelize } = require('./models');
    await sequelize.authenticate();
    ctx.body = { code: 0, message: '数据库连接正常' };
  } catch (err) {
    ctx.body = { code: 500, message: '数据库错误', error: err.message };
  }
});

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

app.use(router.routes());
app.use(router.allowedMethods());
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

// 错误处理
app.on('error', (err, ctx) => {
  console.error('Server Error:', err);
});

app.listen(PORT, () => {
  console.log(`ANY-ERP 服务已启动: http://localhost:${PORT}`);
  console.log(`API地址: http://localhost:${PORT}/api/v1`);
});

module.exports = app;
