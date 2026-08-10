const XLSX = require('xlsx');
const { FreightPlatform, Store } = require('../../models');
const { generateUUID } = require('../../utils');
const {
  listFreightRecords,
  getFreightExportRows
} = require('./freightService');

function currentUser(ctx) {
  return ctx.state.user || {};
}

function platformPayload(body, user) {
  const name = String(body.platformName || body.platform_name || '').trim();
  if (!name) ctxThrow(400, '请输入配送平台名称');
  if (name.length > 64) ctxThrow(400, '配送平台名称不能超过64个字符');
  return {
    platform_name: name,
    sort_order: Number(body.sortOrder || body.sort_order || 0) || 0,
    status: body.status === undefined ? 1 : (Number(body.status) ? 1 : 0),
    update_user: user.name || user.phone || 'system',
    update_time: new Date()
  };
}

function ctxThrow(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function getPlatforms(ctx) {
  const includeDisabled = String(ctx.query.includeDisabled || '') === '1';
  const where = includeDisabled ? {} : { status: 1 };
  const rows = await FreightPlatform.findAll({ where, order: [['sort_order', 'ASC'], ['platform_name', 'ASC']] });
  ctx.body = { code: 0, data: rows };
}

async function createPlatform(ctx) {
  const user = currentUser(ctx);
  const payload = platformPayload(ctx.request.body || {}, user);
  const existed = await FreightPlatform.findOne({ where: { platform_name: payload.platform_name } });
  if (existed) ctxThrow(400, '配送平台名称已存在');
  const row = await FreightPlatform.create({
    platform_id: generateUUID(),
    create_user: user.name || user.phone || 'system',
    create_time: new Date(),
    ...payload
  });
  ctx.body = { code: 0, data: row, message: '配送平台已创建' };
}

async function updatePlatform(ctx) {
  const row = await FreightPlatform.findByPk(ctx.params.id);
  if (!row) ctxThrow(404, '配送平台不存在');
  const user = currentUser(ctx);
  const payload = platformPayload(ctx.request.body || {}, user);
  const existed = await FreightPlatform.findOne({ where: { platform_name: payload.platform_name, platform_id: { [require('sequelize').Op.ne]: row.platform_id } } });
  if (existed) ctxThrow(400, '配送平台名称已存在');
  await row.update(payload);
  ctx.body = { code: 0, data: row, message: '配送平台已更新' };
}

async function deletePlatform(ctx) {
  const row = await FreightPlatform.findByPk(ctx.params.id);
  if (!row) ctxThrow(404, '配送平台不存在');
  await row.update({ status: 0, update_user: currentUser(ctx).name || 'system', update_time: new Date() });
  ctx.body = { code: 0, message: '配送平台已停用' };
}

function filtersFromQuery(query) {
  return {
    startDate: query.startDate || query.start_date,
    endDate: query.endDate || query.end_date,
    storeId: query.storeId || query.store_id,
    platformId: query.platformId || query.platform_id,
    sourceType: query.sourceType || query.source_type
  };
}

async function getRecords(ctx) {
  const result = await listFreightRecords({
    filters: filtersFromQuery(ctx.query),
    user: currentUser(ctx),
    page: ctx.query.page,
    pageSize: ctx.query.pageSize || ctx.query.page_size
  });
  ctx.body = {
    code: 0,
    data: {
      list: result.rows,
      total: result.count,
      page: Number(ctx.query.page) || 1,
      pageSize: Number(ctx.query.pageSize || ctx.query.page_size) || 20
    }
  };
}

async function exportRecords(ctx) {
  const rows = await getFreightExportRows({ filters: filtersFromQuery(ctx.query), user: currentUser(ctx) });
  const exportRows = [];
  rows.forEach(row => {
    const json = row.toJSON();
    const items = Array.isArray(json.items) && json.items.length ? json.items : [{}];
    items.forEach(item => exportRows.push({
      运费记录号: json.freight_id,
      来源类型: json.source_type === 'purchase' ? '采购申请' : '调拨申请',
      来源单号: json.source_no,
      配送平台: json.platform_name || '',
      运费金额: json.amount,
      商品ID: item.product_id || '',
      SN码: item.sn_code || '',
      分摊数量: item.quantity || '',
      商品分摊运费: item.allocated_amount || '',
      商品单位运费: item.unit_amount || '',
      门店: json.store_name || '',
      调出门店: json.from_store_name || '',
      调入门店: json.to_store_name || '',
      状态: json.status,
      创建人: json.create_user || '',
      创建时间: json.create_time
    }));
  });
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '运费记录');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const fileName = `运费记录_${new Date().toISOString().slice(0, 10)}.xlsx`;
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  ctx.body = buffer;
}

module.exports = {
  getPlatforms,
  createPlatform,
  updatePlatform,
  deletePlatform,
  getRecords,
  exportRecords
};
