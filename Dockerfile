# CloudBase GitHub deployment fallback for repositories whose backend lives in
# the backend/ subdirectory. Prefer configuring CloudBase target directory as
# backend and using backend/Dockerfile; this file keeps root-directory builds
# working when the console does not expose that setting.
FROM node:18-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./

EXPOSE 3000

CMD ["node", "src/index.js"]
