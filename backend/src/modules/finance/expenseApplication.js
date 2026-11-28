const M = require('../../models');
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function recipient(value, paymentMethod, applicantName, draft = false) {
  const input = value && typeof value === 'object' ? value : {};
  if (paymentMethod === 'PERSONAL_ADVANCE') return { version: 1, mode: 'EMPLOYEE', payeeName: applicantName || '', description: '支付至员工账户' };
  const data = { version: 1, mode: paymentMethod === 'CORPORATE_OTHER' ? 'OTHER' : (input.mode === 'OTHER' ? 'OTHER' : 'UNIT'),
    source: ['SUPPLIER', 'COUNTERPARTY', 'TEMPORARY'].includes(input.source) ? input.source : 'TEMPORARY',
    supplierId: String(input.supplierId || ''), accountId: String(input.accountId || ''),
    payeeName: String(input.payeeName || '').trim(), bankName: String(input.bankName || '').trim(),
    accountNumber: String(input.accountNumber || '').trim(), remark: String(input.remark || '').trim(),
    paymentText: String(input.paymentText || '').trim() };
  if (!draft && !data.paymentText && (!data.payeeName || !data.bankName || !data.accountNumber)) fail('请填写付款账号信息');
  if (data.paymentText.length > 2000) fail('付款账号信息不能超过2000字');
  // Free-form payment instructions must survive downstream bank snapshot readers.
  if (data.paymentText && !data.accountNumber) data.accountNumber = data.paymentText;
  if (!draft && data.source === 'SUPPLIER' && !data.supplierId) fail('请选择已有供应商，或切换为手工收款方');
  if (data.payeeName.length > 255 || data.bankName.length > 128 || data.accountNumber.length > (data.paymentText ? 2000 : 128) || data.remark.length > 512) fail('收款信息超过长度限制');
  return data;
}
function attachments(values, draft = false) {
  if (!Array.isArray(values) || (!draft && !values.length)) fail('请至少上传一份费用凭证（图片、PDF或Excel）');
  if (values.length > 20) fail('最多上传20份费用凭证');
  return values.map(value => {
    const url = typeof value === 'string' ? value : value?.url;
    if (!url || !/^(https?:\/\/|cloud:\/\/|\/uploads\/)/i.test(url)) fail('附件地址无效');
    const name = typeof value === 'string' ? value.split('?')[0] : (value.name || value.original_name || url.split('?')[0]);
    if (typeof value === 'object' && Number(value.size || 0) > 10 * 1024 * 1024) fail('单个费用附件不能超过10MB');
    if (!/\.(jpe?g|png|webp|gif|heic|heif|pdf|xlsx?)$/i.test(name)) fail('附件仅支持图片、PDF或Excel');
    return { url, name: String(name).split('/').pop(), size: typeof value === 'object' ? Number(value.size || 0) : 0 };
  });
}
async function options(ctx) {
  const [stores, suppliers, accounts, distributors] = await Promise.all([
    M.Store.findAll({ where: { status: 1, is_deleted: 0 }, attributes: ['store_id', 'name', 'distributor_id'], order: [['name', 'ASC']], raw: true }),
    M.Supplier.findAll({ where: { status: 1, is_deleted: 0 }, attributes: ['supplier_id', 'name'], order: [['name', 'ASC']], raw: true }),
    M.SupplierPaymentAccount.findAll({ where: { status: 1, is_deleted: 0 }, attributes: ['account_id', 'supplier_id', 'company_name', 'bank_name', 'account_number', 'remark'], raw: true }),
    M.Distributor.findAll({ attributes: ['distributor_id', 'name'], raw: true })
  ]);
  const names = new Map(distributors.map(row => [row.distributor_id, row.name]));
  ctx.body = { allocationStores: stores.map(row => ({ ...row, distributor_name: names.get(row.distributor_id) || row.distributor_id })), suppliers: suppliers.map(row => ({ ...row, accounts: accounts.filter(account => account.supplier_id === row.supplier_id) })) };
}
async function validateTargets(attribution, month, transaction) {
  if (attribution.type !== 'STORE') return;
  const ids = attribution.details.map(row => row.target_id);
  if (new Set(ids.map(String)).size !== ids.length) fail('分摊门店不能重复');
  const stores = await M.Store.findAll({ where: { store_id: ids, status: 1, is_deleted: 0 }, transaction });
  if (stores.length !== ids.length) fail('分摊门店不存在或已停用');
  const byId = new Map(stores.map(store => [String(store.store_id), store]));
  for (const row of attribution.details) row.target_name = byId.get(String(row.target_id)).name;
  if (month) for (const id of new Set(stores.map(store => store.distributor_id).filter(Boolean))) {
    await require('./expenseAccountingController').assertPeriodOpen(id, month, transaction);
  }
}
module.exports = { recipient, attachments, options, validateTargets };
