/**
 * 错误处理中间件
 */
async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    let status = err.status || 500;
    let message = err.message || '服务器内部错误';

    if (err.name === 'SequelizeValidationError') {
      status = 400;
      message = '验证错误: ' + err.errors.map(e => `${e.path}: ${e.message}`).join(', ');
    } else if (err.name === 'SequelizeUniqueConstraintError') {
      status = 400;
      message = '数据已存在: ' + (err.errors[0]?.message || err.message);
    } else if (err.parent?.sqlMessage) {
      message = '数据库错误: ' + err.parent.sqlMessage;
    }

    console.error('Error:', {
      status,
      message,
      originalError: err.message,
      stack: err.stack,
      path: ctx.path,
      method: ctx.method
    });

    ctx.status = status;
    ctx.body = {
      code: status,
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    };
  }
}

module.exports = { errorHandler };
