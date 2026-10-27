const fs = require('fs');
const path = require('path');
const {
  Order,
  OrderItem,
  Store,
  PerformanceProfitAdjustment,
  PerformanceProfitAdjustmentAttachment,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const correction = require('./settlementPriceCorrection');

const UPLOAD_DIR = path.resolve(__dirname, '../../../uploads/performance-profit-adjustments');
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf', '.xls', '.xlsx', '.doc', '.docx']);
const ARCHIVED_STATUSES = ['已归档', 'completed', 'archived'];

function hasRole(user, role) {
  if (Array.isArray(user?.roles) && user.roles.length > 0) return user.roles.includes(role);
  return String(user?.roleCode || '').split(',').map(item => item.trim()).includes(role);
}

function createAdjustmentNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `PPA${stamp}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
}

async function getAccessibleStoreIds(user) {
  if (user.accessibleStoreIds?.includes('*')) {
    const stores = await Store.findAll({ attributes: ['store_id'], raw: true });
    return stores.map(store => store.store_id);
  }
  return user.accessibleStoreIds || [];
}

async function getAccessibleOrder(orderId, user, transaction = null) {
  const storeIds = await getAccessibleStoreIds(user);
  if (!storeIds.length) return null;
  return Order.findOne({
    where: { order_id: orderId, store_id: { [Op.in]: storeIds }, is_deleted: 0 },
    include: [{ model: OrderItem }],
    transaction
  });
}

function validateFiles(files = []) {
  if (files.length > 5) throw Object.assign(new Error('最多上传5个附件'), { status: 400 });
  for (const file of files) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw Object.assign(new Error(`不支持附件格式：${file.originalname}`), { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      throw Object.assign(new Error(`附件不能超过10MB：${file.originalname}`), { status: 400 });
    }
  }
}

async function createProfitAdjustment(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  const { orderId, adjustmentType, reason } = body;
  const files = ctx.files || [];
  const type = String(adjustmentType || '').trim();
  const trimmedReason = String(reason || '').trim();

  if (!orderId) ctx.throw(400, '请选择订单');
  if (type !== correction.TYPE) ctx.throw(400, '不再支持手工增加或减少毛利，请选择结算定价纠错并填写正确定价');
  const input = correction.validate(body);
  const evidence = String(body.evidence || '').trim();
  if (evidence.length < 2 || evidence.length > 2000) ctx.throw(400, '请填写2至2000字的定价依据或凭据编号');
  if (!body.previewHash) ctx.throw(400, '请先预览本次纠错影响');
  if (!trimmedReason) ctx.throw(400, '请填写调整原因');
  if (trimmedReason.length > 1000) ctx.throw(400, '调整原因不能超过1000字');
  validateFiles(files);

  const order = await getAccessibleOrder(orderId, user);
  if (!order) ctx.throw(404, '订单不存在或无权操作');
  if (!ARCHIVED_STATUSES.includes(String(order.order_status || ''))) {
    ctx.throw(400, '只有已归档订单可以申请毛利调整');
  }

  const adjustmentId = generateUUID();
  const storedFiles = [];
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });

  try {
    for (const file of files) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const storageName = `${generateUUID()}${extension}`;
      const filePath = path.join(UPLOAD_DIR, storageName);
      await fs.promises.writeFile(filePath, file.buffer);
      storedFiles.push({ file, storageName, filePath });
    }

    await sequelize.transaction(async transaction => {
      const selected = await correction.select(ctx, order.order_id, input, transaction);
      if (selected.previewHash !== body.previewHash) ctx.throw(409, '订单或结算数据已变化，请重新预览');
      const pending = await PerformanceProfitAdjustment.findOne({ where: { order_id: order.order_id,
        adjustment_type: correction.TYPE, status: { [Op.in]: ['pending_finance', 'pending_admin'] } }, transaction, lock: transaction.LOCK.UPDATE });
      if (pending) ctx.throw(409, '本订单已有待审批定价纠错，请先处理原申请');
      await PerformanceProfitAdjustment.create({
        adjustment_id: adjustmentId,
        adjustment_no: createAdjustmentNo(),
        order_id: order.order_id,
        order_no: order.order_no,
        store_id: order.store_id,
        employee_name: order.create_user || '',
        adjustment_type: type,
        product_id: selected.originalItem.product_id,
        amount: Math.abs(selected.result.salesDelta),
        // Effective base profit is corrected atomically; never add the same delta again.
        signed_amount: 0,
        base_gross_profit: selected.result.salesBefore,
        correction_data: { input, evidence, previewHash: selected.previewHash, result: selected.result },
        reason: trimmedReason,
        status: 'pending_finance',
        applicant_staff_id: user.staffId,
        applicant_name: user.name,
        create_time: new Date(),
        update_time: new Date()
      }, { transaction });

      if (storedFiles.length) {
        await PerformanceProfitAdjustmentAttachment.bulkCreate(storedFiles.map(({ file, storageName, filePath }) => ({
          attachment_id: generateUUID(),
          adjustment_id: adjustmentId,
          original_name: path.basename(file.originalname || '附件').slice(0, 255),
          storage_name: storageName,
          mime_type: file.mimetype || 'application/octet-stream',
          file_size: file.size || 0,
          file_path: storageName,
          upload_staff_id: user.staffId,
          upload_user: user.name,
          create_time: new Date()
        })), { transaction });
      }
    });
  } catch (error) {
    await Promise.all(storedFiles.map(({ filePath }) => fs.promises.unlink(filePath).catch(() => {})));
    throw error;
  }

  ctx.body = { code: 0, message: '结算定价纠错申请已提交，审批通过后同步销售端和产品端毛利', data: { adjustmentId } };
}

async function getCorrectionOptions(ctx) {
  ctx.body = { code: 0, data: await correction.select(ctx, ctx.query.orderId) };
}
async function previewCorrection(ctx) {
  const body = ctx.request.body || {};
  const selected = await correction.select(ctx, body.orderId, correction.validate(body));
  const impact = correction.previewResponse(selected.result, ctx.state.user);
  ctx.body = { code: 0, data: { ...impact, previewHash: selected.previewHash,
    note: '按原归档税费及规则重算，销售与产品两端毛利之和不等同于公司财务利润；不改变客户成交价、采购成本或商品主档定价。' } };
}

async function listProfitAdjustments(ctx) {
  if (await require('../approval/businessRuntime').reviewList(ctx, 'profit_adjustment')) {
    ctx.body.data.list = ctx.body.data.list.map(row => correction.display(row, ctx.state.user));
    return;
  }
  const user = ctx.state.user;
  const { scope = 'mine', orderId, status, page = 1, pageSize = 20 } = ctx.query;
  const storeIds = await getAccessibleStoreIds(user);
  if (!storeIds.length) {
    ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
    return;
  }

  const where = { store_id: { [Op.in]: storeIds } };
  if (orderId) where.order_id = orderId;
  if (status) where.status = status;

  if (scope === 'review') {
    const reviewStatuses = [];
    if (hasRole(user, 'finance')) reviewStatuses.push('pending_finance');
    if (hasRole(user, 'admin')) reviewStatuses.push('pending_admin');
    if (!reviewStatuses.length) {
      ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
      return;
    }
    where.status = { [Op.in]: reviewStatuses };
  } else if (scope === 'order') {
    if (!hasRole(user, 'finance') && !hasRole(user, 'admin') && !hasRole(user, 'boss')) {
      where[Op.or] = [
        { status: 'approved' },
        { applicant_staff_id: user.staffId }
      ];
    }
  } else {
    where.applicant_staff_id = user.staffId;
  }

  const currentPage = Math.max(Number(page) || 1, 1);
  const currentPageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const result = await PerformanceProfitAdjustment.findAndCountAll({
    where,
    include: [{
      model: PerformanceProfitAdjustmentAttachment,
      as: 'attachments',
      attributes: ['attachment_id', 'original_name', 'mime_type', 'file_size', 'create_time']
    }],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'PerformanceProfitAdjustment.status',
      pendingStatuses: ['pending_finance', 'pending_admin'],
      dateColumns: ['PerformanceProfitAdjustment.create_time'],
      idColumn: 'PerformanceProfitAdjustment.adjustment_id'
    }),
    offset: (currentPage - 1) * currentPageSize,
    limit: currentPageSize,
    distinct: true
  });

  ctx.body = formatPaginatedResult(result.rows.map(row => correction.display(row.toJSON(), ctx.state.user)), {
    page: currentPage,
    pageSize: currentPageSize,
    count: result.count
  });
}

async function reviewProfitAdjustment(ctx, action) {
  const user = ctx.state.user;
  const adjustmentId = ctx.params.adjustmentId;
  const comment = String(ctx.request.body?.comment || '').trim();
  if (action === 'reject' && !comment) ctx.throw(400, '拒绝时必须填写原因');
  if (comment.length > 512) ctx.throw(400, '审核意见不能超过512字');

  let responseMessage = action === 'approve' ? '审核通过' : '申请已拒绝';
  await sequelize.transaction(async transaction => {
    const adjustment = await PerformanceProfitAdjustment.findByPk(adjustmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!adjustment) ctx.throw(404, '毛利调整申请不存在');

    const storeIds = await getAccessibleStoreIds(user);
    if (!storeIds.includes(adjustment.store_id)) ctx.throw(403, '无权审核该申请');
    if (action === 'approve' && adjustment.adjustment_type !== correction.TYPE) ctx.throw(409, '历史手工增减申请不能继续批准，请拒绝后按实际业务来源重新申请');
    if (!await require('../approval/businessRuntime').advance(ctx, 'profit_adjustment', adjustment, transaction, action, comment)) { responseMessage = '本次审批已记录，等待下一审批人'; return; }
    if (action === 'approve') await correction.apply(ctx, adjustment, transaction);
    await adjustment.update({ status: action === 'approve' ? 'approved' : 'rejected', admin_reviewer_id: user.staffId, admin_reviewer_name: user.name, admin_review_comment: comment, admin_review_time: new Date(), update_time: new Date() }, { transaction });
  });

  ctx.body = {
    code: 0,
    message: responseMessage
  };
}

async function approveProfitAdjustment(ctx) {
  return reviewProfitAdjustment(ctx, 'approve');
}

async function rejectProfitAdjustment(ctx) {
  return reviewProfitAdjustment(ctx, 'reject');
}

async function downloadProfitAdjustmentAttachment(ctx) {
  const user = ctx.state.user;
  const attachment = await PerformanceProfitAdjustmentAttachment.findByPk(ctx.params.attachmentId);
  if (!attachment) ctx.throw(404, '附件不存在');
  const adjustment = await PerformanceProfitAdjustment.findByPk(attachment.adjustment_id);
  if (!adjustment) ctx.throw(404, '申请记录不存在');

  const storeIds = await getAccessibleStoreIds(user);
  const privileged = hasRole(user, 'finance') || hasRole(user, 'admin') || hasRole(user, 'boss');
  const owner = String(adjustment.applicant_staff_id) === String(user.staffId);
  const approvedVisible = adjustment.status === 'approved';
  if (!storeIds.includes(adjustment.store_id) || (!privileged && !owner && !approvedVisible)) {
    ctx.throw(403, '无权下载该附件');
  }
  const storedPath = path.isAbsolute(attachment.file_path)
    ? attachment.file_path
    : path.join(UPLOAD_DIR, attachment.storage_name || attachment.file_path);
  if (!fs.existsSync(storedPath)) ctx.throw(404, '附件文件已丢失');

  const safeName = String(attachment.original_name || '附件').replace(/[\r\n"]/g, '_');
  ctx.type = attachment.mime_type || 'application/octet-stream';
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  ctx.body = fs.createReadStream(storedPath);
}

module.exports = {
  getCorrectionOptions,
  previewCorrection,
  createProfitAdjustment,
  listProfitAdjustments,
  approveProfitAdjustment,
  rejectProfitAdjustment,
  downloadProfitAdjustmentAttachment
};
