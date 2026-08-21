const { Op } = require('sequelize');
const {
  ProductSn,
  Product,
  Store,
  SnLog,
  ApprovalFlowInstance,
  sequelize
} = require('../../models');
const { generateUUID } = require('../../utils');

const SN_CHANGE_FLOW_CODE = 'sn_change';
const SN_CHANGE_BUSINESS_TYPE = 'sn_change';

function applicationError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : {};
  } catch (_) {
    return {};
  }
}

function assertStoreVisible(user, storeId) {
  const accessibleStoreIds = user?.accessibleStoreIds || [];
  if (!accessibleStoreIds.includes('*') && !accessibleStoreIds.map(String).includes(String(storeId || ''))) {
    throw applicationError(403, '无权操作该门店库存数据');
  }
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw applicationError(400, '至少需要提交一条SN修改明细');
  }

  const seen = new Set();
  return items.map((item, index) => {
    const snId = normalizeText(item?.snId || item?.sn_id);
    const newSnCode = normalizeText(item?.newSnCode || item?.new_sn_code || item?.newCode);
    if (!snId) throw applicationError(400, `第${index + 1}条明细缺少SN记录ID`);
    if (!newSnCode) throw applicationError(400, `第${index + 1}条明细的新SN不能为空`);
    if (seen.has(snId)) throw applicationError(400, `SN记录${snId}重复提交`);
    seen.add(snId);
    return { snId, newSnCode };
  });
}

async function loadAndValidateItems(items, user, transaction) {
  const snIds = items.map(item => item.snId);
  const rows = await ProductSn.findAll({
    where: { sn_id: { [Op.in]: snIds }, is_deleted: 0 },
    include: [
      { model: Product, attributes: ['name'] },
      { model: Store, attributes: ['name'] }
    ],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const rowMap = new Map(rows.map(row => [String(row.sn_id), row]));
  const newCodePairs = new Set();
  const validated = [];

  for (const item of items) {
    const row = rowMap.get(item.snId);
    if (!row) throw applicationError(404, `SN记录${item.snId}不存在`);
    assertStoreVisible(user, row.store_id);
    if (row.status !== 'in_stock') {
      throw applicationError(409, `SN ${row.sn_code} 仅允许修改在库状态记录`);
    }
    if (row.sn_code === item.newSnCode) {
      throw applicationError(400, `SN ${row.sn_code} 未发生变化`);
    }

    const pairKey = `${row.pn_code || ''}\u0000${item.newSnCode}`;
    if (newCodePairs.has(pairKey)) {
      throw applicationError(400, `同一申请中存在重复的新SN：${item.newSnCode}`);
    }
    newCodePairs.add(pairKey);

    const exists = await ProductSn.findOne({
      where: {
        pn_code: row.pn_code || '',
        sn_code: item.newSnCode,
        is_deleted: 0,
        sn_id: { [Op.ne]: row.sn_id }
      },
      transaction
    });
    if (exists) {
      throw applicationError(409, `SN码[${item.newSnCode}]在同一PN下已被使用`);
    }

    validated.push({
      snId: row.sn_id,
      oldSnCode: row.sn_code,
      newSnCode: item.newSnCode,
      pnCode: row.pn_code || '',
      productId: row.product_id || '',
      productName: row.Product?.name || '',
      storeId: row.store_id || '',
      storeName: row.Store?.name || ''
    });
  }

  return validated;
}

async function assertNoPendingApplications(items, transaction) {
  const pending = await ApprovalFlowInstance.findAll({
    where: { business_type: SN_CHANGE_BUSINESS_TYPE, status: 'pending' },
    attributes: ['payload_json'],
    transaction
  });
  const pendingSnIds = new Set();
  for (const instance of pending) {
    const payload = parsePayload(instance.payload_json);
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      if (item.snId) pendingSnIds.add(String(item.snId));
    }
  }
  const duplicated = items.find(item => pendingSnIds.has(String(item.snId)));
  if (duplicated) {
    throw applicationError(409, `SN记录${duplicated.snId}已有待审批的修改申请`);
  }
}

async function createSnChangeApplication(input, user, startApprovalInstance) {
  const reason = normalizeText(input?.reason);
  if (!reason) throw applicationError(400, 'SN修改申请原因不能为空');
  if (!user?.staffId) throw applicationError(401, '当前账号信息无效');

  const items = normalizeItems(input?.items);
  return sequelize.transaction(async transaction => {
    const validated = await loadAndValidateItems(items, user, transaction);
    await assertNoPendingApplications(items, transaction);
    const applicationId = generateUUID();
    const instance = await startApprovalInstance({
      flowCode: SN_CHANGE_FLOW_CODE,
      businessType: SN_CHANGE_BUSINESS_TYPE,
      businessId: applicationId,
      subjectStaffId: user.staffId,
      title: `SN修改申请（${validated.length}条）`,
      summary: reason,
      payload: {
        reason,
        applicantStaffId: user.staffId,
        applicantName: user.name || user.phone || '-',
        items: validated
      }
    }, user, transaction);

    return {
      instanceId: instance.instance_id,
      instanceNo: instance.instance_no,
      status: instance.status,
      businessId: applicationId,
      items: validated
    };
  });
}

async function applySnChangeApplication(instance, transaction, approver) {
  const payload = parsePayload(instance.payload_json);
  const reason = normalizeText(payload.reason);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!reason || items.length === 0) {
    throw applicationError(409, 'SN修改申请数据不完整，无法生效');
  }

  const currentItems = await loadAndValidateItems(
    items.map(item => ({ snId: item.snId, newSnCode: item.newSnCode })),
    {
      accessibleStoreIds: ['*']
    },
    transaction
  );

  for (const item of currentItems) {
    const submitted = items.find(row => String(row.snId) === String(item.snId));
    if (String(submitted.oldSnCode || '') !== String(item.oldSnCode || '')) {
      throw applicationError(409, `SN ${item.oldSnCode} 已发生变化，请重新发起申请`);
    }
  }

  const operatorName = normalizeText(approver?.name || approver?.phone) || '系统';
  for (const item of currentItems) {
    await ProductSn.update(
      { sn_code: item.newSnCode },
      { where: { sn_id: item.snId }, transaction }
    );
    await SnLog.create({
      log_id: generateUUID(),
      sn_id: item.snId,
      sn_code: item.newSnCode,
      old_sn_code: item.oldSnCode,
      product_id: item.productId,
      product_name: item.productName,
      store_id: item.storeId,
      action: 'modify_sn',
      remark: `SN码由 ${item.oldSnCode} 修改为 ${item.newSnCode}；申请人：${payload.applicantName || '-'}；申请原因：${reason}`,
      create_user: payload.applicantName || operatorName
    }, { transaction });
  }
}

async function submitSnChangeApplication(ctx) {
  try {
    const { startInstance } = require('../approval/service');
    const result = await createSnChangeApplication(ctx.request.body || {}, ctx.state.user, startInstance);
    ctx.body = { code: 0, message: 'SN修改申请已提交，等待经销商账号审批', data: result };
  } catch (error) {
    if (error.status) ctx.throw(error.status, error.message);
    throw error;
  }
}

module.exports = {
  SN_CHANGE_FLOW_CODE,
  SN_CHANGE_BUSINESS_TYPE,
  createSnChangeApplication,
  applySnChangeApplication,
  submitSnChangeApplication,
  _test: { normalizeItems, parsePayload }
};
