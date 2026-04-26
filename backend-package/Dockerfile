FROM registry.tencentcloud.com/tencentyun/tencent-serverless-nodejs:18

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
