# ANY-ERP 部署指南 - 腾讯云托管

## 一、前置准备

### 1.1 开通服务
- 开通腾讯云托管（Cloud Base 云托管）
- 开通容器镜像仓库

### 1.2 构建正式 WEB 静态资源

生产容器读取 `backend/public`，正式 WEB 源码位于 `frontend/web`。每次部署前必须先执行：

```powershell
cd D:/艾诺云/小艾虾/ANY-ERP
powershell -ExecutionPolicy Bypass -File scripts/build-web-production.ps1
```

脚本会：

1. 安装 `frontend/web` 锁定依赖。
2. 构建到 `frontend/dist-web`。
3. 清理并更新 `backend/public`。

`frontend/dist-web` 和 `backend/public` 是正式发布产物，已纳入版本管理。提交功能代码时，必须同时提交这两个目录，确保 `index.html` 引用的哈希资源与后端实际提供的资源一致。

不得只构建根目录的 `web`，也不得在未更新 `backend/public` 时直接重新构建后端镜像。

### 1.3 SPA History 路由与同源 API 配置

正式前端使用 Vue Router History 模式，部署到域名根路径时必须保持以下配置一致：

- Vite `base`：`/`
- Router `createWebHistory` base：`import.meta.env.BASE_URL`
- CloudBase 静态网站首页文档：`index.html`
- CloudBase 静态网站 4xx 错误文档：`index.html`
- 前端 API base：通过构建时变量 `VITE_API_BASE_URL` 设置；同源部署使用 `/api/v1`，独立后端使用完整 HTTPS 地址，代码会去除末尾斜杠。
- `VITE_API_BASE_URL`：若静态托管与后端不是同一回源入口，设置为后端服务的完整 `/api/v1` 地址；若使用 CDN/网关分流，则设置为 `/api/v1`

4xx fallback 只负责前端页面路由。`/api/*` 必须在 CDN/网关层单独回源到云托管后端服务，不能回源到 COS，也不能由静态托管错误文档返回 `index.html`。

`frontend/web/src/api/index.js` 会去除 API base URL 末尾重复斜杠，并将路径型配置规范为单斜杠；生产发布前仍必须确认该变量指向真实后端服务，不能把静态托管域名误当作 API 源站。

如果域名响应头出现 `x-cloudbase-upstream-type: Tencent-COS`，说明请求当前进入静态托管；此时应检查自定义域名或 CDN 的路径路由，确保 `/api/*` 指向后端服务、其他页面路径指向静态托管。回源路径必须直接使用规范化的单斜杠路径，不能配置为“固定 `/` + 原始请求路径”的重复拼接形式。

发布后必须刷新 HTML、路由和资源相关 CDN 缓存，并按以下顺序验证：

```powershell
curl.exe -i https://your-domain.example/login
curl.exe -i https://your-domain.example/dashboard
curl.exe -i https://your-domain.example/assets/<actual-asset>.js
curl.exe -i https://your-domain.example/api/v1/health/db
```

预期：页面路由返回 `index.html` 且状态码为 200；静态资源按真实文件返回；API 返回后端响应而不是 HTML。

### 1.4 本地构建 Docker 镜像

```bash
cd D:/艾诺云/Soft/ANY-ERP/backend

# 构建镜像
docker build -t any-erp-backend:latest .

# 本地测试
docker run -p 3000:3000 \
  -e DB_HOST=your-db-host.example.com \
  -e DB_PORT=3306 \
  -e DB_NAME=any_erp \
  -e DB_USER=your-db-user \
  -e DB_PASSWORD=your-db-password \
  any-erp-backend:latest
```

## 二、推送到镜像仓库

### 2.1 登录腾讯云镜像仓库
```bash
docker login --username=your_username registry.tencent.tencent.com
```

### 2.2 打标签
```bash
docker tag any-erp-backend:latest registry.tencent.tencent.com/your_namespace/any-erp-backend:v1.0.0
```

### 2.3 推送
```bash
docker push registry.tencent.tencent.com/your_namespace/any-erp-backend:v1.0.0
```

## 三、云托管控制台部署

如果云托管通过 GitHub 仓库自动构建，必须确认部署分支包含目标提交；GitHub 默认分支为 `main` 时，功能分支提交不会自动进入生产版本。

### 3.1 创建服务
1. 进入腾讯云托管控制台
2. 创建服务：`cloud1`
3. 选择服务配置：
   - 计费模式：按量计费
   - 地域：ap-shanghai（上海）
   - 流量协议：HTTP

### 3.2 配置服务
1. **镜像配置**：
   - 选择刚才推送的镜像
   - 镜像版本：`v1.0.0`

2. **环境变量**：
   ```
   NODE_ENV = production
   PORT = 3000
   DB_HOST = your-db-host.example.com
   DB_PORT = 3306
   DB_NAME = any_erp
   DB_USER = your-db-user
   DB_PASSWORD = your-db-password
   JWT_SECRET = your-jwt-secret
   ```

3. **端口配置**：
   - 容器端口：`3000`
   - 服务端口：`80`

4. **健康检查**：
   - 路径：`/`
   - 端口：`3000`

### 3.3 创建版本
1. 点击部署新版本
2. 选择镜像版本
3. 设置实例数量（建议 1-2 个）
4. 等待部署完成

## 四、获取服务地址

部署成功后，在服务详情页获取：
- **服务地址**：`https://cloud1-xxxxxx.service.tencentyun.com`
- **API地址**：`https://cloud1-xxxxxx.service.tencentyun.com/api/v1`

## 五、小程序配置

在小程序的 `app.js` 中更新 API 地址：

```javascript
import cloudbase from '@cloudbase/js-sdk'

const app = cloudbase.init({
    env: 'any_erp',
    region: 'ap-shanghai'
})

const auth = app.auth();
await auth.signInAnonymously();

const result = await app.callContainer({
    name: 'cloud1',  // 云托管服务名称
    method: 'GET',
    path: '/api/v1/auth/login',  // 完整API路径
    data: {
        phone: '13800138000',
        password: '123456'
    },
});
```

## 六、常见问题

### Q1: 部署失败
- 检查镜像是否推送成功
- 检查环境变量是否配置正确
- 查看日志排查错误

### Q2: 数据库连接失败
- 确认云托管与 MySQL 网络互通
- 检查数据库账号密码是否正确
- 确认数据库是否开启外网访问

### Q3: 小程序调用失败
- 检查服务是否启动成功
- 确认 API 路径是否正确
- 查看云托管日志排查
