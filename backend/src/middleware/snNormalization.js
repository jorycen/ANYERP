const { normalizeSnFields } = require('../utils/snCode');
async function snNormalization(ctx, next) {
  const query = normalizeSnFields({ ...ctx.query });
  ctx.query = query;
  normalizeSnFields(ctx.request.body);
  await next();
}
module.exports = { snNormalization };
