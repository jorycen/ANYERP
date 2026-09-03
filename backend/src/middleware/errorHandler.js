const { isTransientDatabaseError, markDatabaseUnhealthy, recoverDatabaseInBackground } = require('../config/database');

function localizeDatabaseDetail(detail) {
  const text = String(detail || '').trim();
  if (!text) return '数据库操作失败，请联系管理员';
  if (/duplicate entry/i.test(text)) return '数据已存在，不能重复提交';
  if (/unknown column ['`]?([^'` ]+)/i.test(text)) {
    return `数据库缺少字段：${text.match(/unknown column ['`]?([^'` ]+)/i)?.[1] || '未知字段'}`;
  }
  if (/doesn't exist|does not exist/i.test(text) && /table/i.test(text)) return '数据库表不存在，请联系管理员';
  if (/cannot be null/i.test(text)) return '必填数据不能为空';
  if (/data too long/i.test(text)) return '字段内容过长，请检查输入内容';
  if (/foreign key constraint fails/i.test(text)) return '关联数据不存在或不符合约束';
  if (/lock wait timeout|deadlock found/i.test(text)) return '数据库并发冲突，请稍后重试';
  if (/connection|connect|timeout|econnreset|econnrefused/i.test(text)) return '数据库连接异常，请稍后重试';
  return '数据库操作失败，请联系管理员';
}

function localizeErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '系统内部错误';
  if (/^internal server error$/i.test(text)) return '系统内部错误';
  if (/^database connection is temporarily unavailable/i.test(text)) return '数据库连接暂时不可用，请稍后重试';
  if (/^validation error\s*:/i.test(text)) return `数据校验失败：${text.replace(/^validation error\s*:\s*/i, '')}`;
  if (/^data already exists\s*:/i.test(text)) return '数据已存在，请检查是否重复提交';
  if (/^database error\s*:/i.test(text)) return localizeDatabaseDetail(text.replace(/^database error\s*:\s*/i, ''));
  if (!/[\u4e00-\u9fff]/.test(text) && /[A-Za-z]/.test(text)) return '操作失败，请稍后重试';
  return text;
}

async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    let status = err.status || 500;
    let message = err.message || '系统内部错误';

    if (isTransientDatabaseError(err)) {
      status = 503;
      message = '数据库连接暂时不可用，请稍后重试';
      markDatabaseUnhealthy(err);
      recoverDatabaseInBackground('post-error database recovery');
    } else if (err.name === 'SequelizeValidationError') {
      status = 400;
      message = '数据校验失败：' + err.errors.map(e => `${e.path}: ${e.message}`).join('，');
    } else if (err.name === 'SequelizeUniqueConstraintError') {
      status = 400;
      message = '数据已存在，请检查是否重复提交';
    } else if (err.parent?.sqlMessage) {
      message = localizeDatabaseDetail(err.parent.sqlMessage);
    }

    message = localizeErrorMessage(message);

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

module.exports = { errorHandler, localizeDatabaseDetail, localizeErrorMessage };
