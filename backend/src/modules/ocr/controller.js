const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 90000;

function getPythonBin() {
  return process.env.OCR_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';
}

function safeSuffix(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.bmp', '.webp'].includes(ext) ? ext : '.jpg';
}

function parseResponse(data) {
  if (!data) return {};
  return typeof data === 'string' ? JSON.parse(data) : data;
}

function proxyToOcrService(file, scene) {
  const serviceUrl = process.env.OCR_SERVICE_URL;
  if (!serviceUrl) {
    return Promise.resolve(null);
  }

  const boundary = `----anyerp-ocr-${Date.now()}-${randomUUID()}`;
  const fileName = file.originalname || 'coupon.jpg';
  const chunks = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="scene"\r\n\r\n${scene || ''}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`),
    Buffer.from(`Content-Type: ${file.mimetype || 'application/octet-stream'}\r\n\r\n`),
    file.buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ];
  const body = Buffer.concat(chunks);
  const url = new URL(serviceUrl);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...(process.env.OCR_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.OCR_SERVICE_TOKEN}` } : {})
      },
      timeout: Number(process.env.OCR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; });
      res.on('end', () => {
        try {
          const parsed = parseResponse(response);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(parsed.message || parsed.error || `OCR服务响应异常：${res.statusCode}`));
            return;
          }
          resolve(parsed.data || parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('OCR服务请求超时'));
    });
    req.write(body);
    req.end();
  });
}

function runPaddleOcr(imagePath, scene) {
  const scriptPath = path.join(__dirname, 'coupon_ocr.py');
  const pythonBin = getPythonBin();
  const timeoutMs = Number(process.env.OCR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, '--image', imagePath, '--scene', scene || ''], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`OCR识别超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr || `OCR进程退出异常：${code}`));
        return;
      }

      try {
        const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const jsonLine = lines.reverse().find(line => line.startsWith('{') && line.endsWith('}'));
        resolve(JSON.parse(jsonLine || stdout));
      } catch (error) {
        reject(new Error(`OCR结果解析失败：${error.message}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
  });
}

async function recognizeCoupon(ctx) {
  const file = ctx.file;
  if (!file || !file.buffer) {
    ctx.throw(400, '请上传图片');
  }

  const maxSizeMb = Number(process.env.OCR_MAX_IMAGE_SIZE_MB || 8);
  if (file.size > maxSizeMb * 1024 * 1024) {
    ctx.throw(413, `图片不能超过${maxSizeMb}MB`);
  }

  const scene = String(ctx.request.body?.scene || '');

  const proxiedResult = await proxyToOcrService(file, scene);
  if (proxiedResult) {
    ctx.body = {
      code: 0,
      message: '成功',
      data: proxiedResult
    };
    return;
  }

  if (process.env.OCR_ENABLE_LOCAL_PADDLE !== 'true') {
    ctx.throw(503, 'OCR服务未配置，请设置 OCR_SERVICE_URL');
  }

  const tempPath = path.join(os.tmpdir(), `coupon-ocr-${Date.now()}-${randomUUID()}${safeSuffix(file.originalname)}`);

  try {
    await fs.promises.writeFile(tempPath, file.buffer);
    const result = await runPaddleOcr(tempPath, scene);
    ctx.body = {
      code: 0,
      message: '成功',
      data: result
    };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
}

module.exports = {
  recognizeCoupon
};
