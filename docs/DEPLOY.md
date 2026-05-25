# ANY-ERP 部署指南 - 腾讯云托管

## 一、前置准备

### 1.1 开通服务
- 开通腾讯云托管（Cloud Base 云托管）
- 开通容器镜像仓库

### 1.2 本地构建 Docker 镜像

```bash
cd D:/艾诺云/Soft/ANY-ERP/backend

# 构建镜像
docker build -t any-erp-backend:latest .

# 本地测试
docker run -p 3000:3000 \
  -e DB_HOST=sh-cynosdbmysql-grp-lpycb6gi.sql.tencentcdb.com \
  -e DB_PORT=29244 \
  -e DB_NAME=cloud1-8glwjlnq4c74f7f1 \
  -e DB_USER=ainuoyun \
  -e DB_PASSWORD=lx123456. \
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
   DB_HOST = sh-cynosdbmysql-grp-lpycb6gi.sql.tencentcdb.com
   DB_PORT = 29244
   DB_NAME = cloud1-8glwjlnq4c74f7f1
   DB_USER = ainuoyun
   DB_PASSWORD = lx123456.
   JWT_SECRET = any-erp-secret-key-2024
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
    env: 'cloud1-8glwjlnq4c74f7f1',
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
