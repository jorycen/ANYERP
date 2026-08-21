const { BusinessActionLog } = require('../models');
const { generateUUID } = require('./index');

async function recordBusinessAction({
  businessType,
  businessId,
  businessNo,
  action,
  fromStatus = null,
  toStatus = null,
  user = {},
  comment = '',
  detail = null,
  transaction = null
}) {
  if (!businessType || !businessId || !action) return null;
  return BusinessActionLog.create({
    log_id: generateUUID(),
    business_type: businessType,
    business_id: String(businessId),
    business_no: businessNo || null,
    action,
    from_status: fromStatus || null,
    to_status: toStatus || null,
    actor_staff_id: user?.staffId || null,
    actor_name: user?.name || user?.phone || String(user?.staffId || ''),
    comment: comment || '',
    detail_json: detail ? JSON.stringify(detail) : null,
    create_time: new Date()
  }, transaction ? { transaction } : undefined);
}

async function listBusinessActions(businessType, businessId) {
  const rows = await BusinessActionLog.findAll({
    where: { business_type: businessType, business_id: String(businessId) },
    order: [['create_time', 'ASC'], ['log_id', 'ASC']],
    raw: true
  });
  return rows.map(row => ({
    ...row,
    detail: row.detail_json ? parseJson(row.detail_json) : null
  }));
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

module.exports = { recordBusinessAction, listBusinessActions };
