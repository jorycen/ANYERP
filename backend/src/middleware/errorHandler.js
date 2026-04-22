/**
 * 错误处理中间件
 */
async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || '服务器内部错误';

    console.error('Error:', {
      status,
      message,
      stack: err.stack,
      path: ctx.path,
      method: ctx.method
    });

    ctx.status = status;
    ctx.body = {
      code: status,
      message: status === 500 ? '服务器内部错误' : message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    };
  }
}

module.exports = { errorHandler };
