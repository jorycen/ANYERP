const { getCloudStorageConfig, getSignedCloudFileUrl, uploadCloudFile } = require('../../utils/cloudStorage');

const MAX_FILE_IDS = 50;
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function upload(ctx) {
  const file = ctx.request.file;
  if (!file) ctx.throw(400, '请选择要上传的文件');
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
    ctx.throw(400, '仅支持 JPG、PNG、WEBP 或 PDF 文件');
  }
  if (Number(file.size || file.buffer?.length || 0) > MAX_UPLOAD_BYTES) {
    ctx.throw(400, '单个文件不能超过 10MB');
  }

  const category = String(ctx.request.body?.category || 'general').trim();
  const result = await uploadCloudFile({
    buffer: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    category
  });
  ctx.body = { code: 0, data: result };
}

async function resolveCloudFileUrls(ctx) {
  const input = ctx.request.body && ctx.request.body.fileIds;
  const fileIds = Array.isArray(input)
    ? [...new Set(input.map(value => String(value || '').trim()).filter(Boolean))].slice(0, MAX_FILE_IDS)
    : [];

  if (!fileIds.length) ctx.throw(400, '请提供云存储文件标识');

  const items = await Promise.all(fileIds.map(async fileId => {
    try {
      const resolved = await getSignedCloudFileUrl(fileId);
      return { fileId, url: resolved.url, expiresIn: resolved.expiresIn, source: resolved.source };
    } catch (error) {
      console.error('[CloudStorage][resolve]', {
        fileIdSuffix: fileId.slice(-48),
        code: error.code || '',
        status: error.status || 500,
        message: error.message
      });
      return { fileId, url: '', error: error.code || error.message || '解析文件地址失败' };
    }
  }));

  ctx.body = {
    code: 0,
    data: {
      configured: getCloudStorageConfig().enabled,
      items
    }
  };
}

module.exports = {
  upload,
  resolveCloudFileUrls
};
