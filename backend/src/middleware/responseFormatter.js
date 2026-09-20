/**
 * 响应格式化中间件
 */
const chinaDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

function formatChinaDate(date) {
  const parts = Object.fromEntries(chinaDateFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function normalizeResponseDates(value, seen = new WeakSet()) {
  if (value instanceof Date) return formatChinaDate(value);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || typeof value.pipe === 'function') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = normalizeResponseDates(value[index], seen);
    return value;
  }
  for (const key of Object.keys(value)) value[key] = normalizeResponseDates(value[key], seen);
  return value;
}

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

  // 所有业务接口统一输出北京时间，避免浏览器或小程序直接展示 UTC 导致少 8 小时。
  normalizeResponseDates(ctx.body);

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

module.exports = { responseFormatter, formatChinaDate, normalizeResponseDates };
