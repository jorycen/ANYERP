FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libglib2.0-0 libgl1 \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm install --production

COPY backend/requirements.txt ./
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY backend/ ./

EXPOSE 3000

CMD ["node", "src/index.js"]
