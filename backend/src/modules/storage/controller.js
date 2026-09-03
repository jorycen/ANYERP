const { getCloudStorageConfig, getSignedCloudFileUrl } = require('../../utils/cloudStorage');

const MAX_FILE_IDS = 50;

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
  resolveCloudFileUrls
};
