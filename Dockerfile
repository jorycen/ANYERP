# 使用轻量级 Node.js 镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 lock 文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制源代码 (忽略 .env, NODE_MODULES 在 .dockerignore 中)
COPY . .

# 暴露端口 (微信云托管默认监听 80，但可以在内部映射)
EXPOSE 3000

# 启动命令
CMD ["node", "src/index.js"]
