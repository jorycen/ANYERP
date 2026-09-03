/**
 * 响应格式化中间件
 */
async function responseFormatter(ctx, next) {
  await next();

  // 如果 body 是流或二进制文件，不处理
  if (ctx.body && (typeof ctx.body.pipe === 'function' || Buffer.isBuffer(ctx.body))) {
    return;
  }

  const contentType = ctx.response.get('Content-Type') || '';
  if (
    contentType.includes('application/octet-stream') ||
    contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  ) {
    return;
  }

  // 如果 body 为空，不处理
  if (!ctx.body) {
    return;
  }

  // 如果已经设置了 code（可能是错误响应或已有格式），不处理
  if (ctx.body.code !== undefined) {
    return;
  }

  // 格式化成功响应
  ctx.body = {
    code: 0,
    message: '成功',
    data: ctx.body
  };
}

module.exports = { responseFormatter };
