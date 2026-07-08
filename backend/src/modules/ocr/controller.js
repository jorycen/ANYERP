const fs = require('fs');
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
  const tempPath = path.join(os.tmpdir(), `coupon-ocr-${Date.now()}-${randomUUID()}${safeSuffix(file.originalname)}`);

  try {
    await fs.promises.writeFile(tempPath, file.buffer);
    const result = await runPaddleOcr(tempPath, scene);
    ctx.body = {
      code: 0,
      message: 'ok',
      data: result
    };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
}

module.exports = {
  recognizeCoupon
};
