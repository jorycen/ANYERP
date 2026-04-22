/**
 * 响应格式化中间件
 */
async function responseFormatter(ctx, next) {
  await next();

  // 如果已经设置了 body（可能是错误响应），不处理
  if (ctx.body && ctx.body.code !== undefined) {
    return;
  }

  // 格式化成功响应
  ctx.body = {
    code: 0,
    message: 'success',
    data: ctx.body
  };
}

module.exports = { responseFormatter };
