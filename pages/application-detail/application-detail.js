const api = require('../../utils/api.js');

function firstValue(item, keys) {
  for (const key of keys) {
    if (item && item[key] !== undefined && item[key] !== null && String(item[key]).trim() !== '') return item[key];
  }
  return '';
}

function parseDateValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (!value) return NaN;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  const normalized = match
    ? `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${match[6] || '00'}`
    : (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text.replace(/-/g, '/') : text);
  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp) ? NaN : timestamp;
}

function formatDate(value) {
  if (!value) return '-';
  const timestamp = parseDateValue(value);
  if (Number.isNaN(timestamp)) return String(value);
  const date = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function unwrap(result) {
  if (!result) return {};
  if (result.data && !Array.isArray(result.data)) return result.data;
  return result;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function statusText(type, status) {
  const maps = {
    purchase: { pending: '待审批', approved: '已通过', purchased: '已采购', partial: '部分入库', partially_received: '部分入库', completed: '已完成', received: '已完成', rejected: '已拒绝', revoked: '已撤销', cancelled: '已取消' },
    product: { pending: '待审批', approved: '已通过', rejected: '已拒绝', revoked: '已撤销' },
    expense: { pending_approval: '待审批', approved: '已通过', pending_payment: '待付款', paid: '已付款', rejected: '已拒绝', cancelled: '已取消' }
  };
  return maps[type]?.[status] || status || '-';
}

function stageText(type, status) {
  const maps = {
    purchase: { pending: '采购审批', approved: '采购执行', purchased: '采购执行', rejected: '已结束', revoked: '已结束', cancelled: '已结束' },
    product: { pending: '商品审批', approved: '已进入商品库', rejected: '已结束', revoked: '已结束' },
    expense: { pending_approval: '领导审批', approved: '待结算', pending_payment: '财务付款', paid: '已完成', rejected: '已结束', cancelled: '已结束' }
  };
  return maps[type]?.[status] || status || '-';
}

function normalizeDetail(type, raw) {
  const status = String(firstValue(raw, ['status']) || '');
  const reviewComment = firstValue(raw, ['approve_comment', 'approveComment', 'review_comment', 'reviewComment', 'revoke_comment', 'revokeComment']);
  const reviewUserName = firstValue(raw, ['approve_user', 'approveUser', 'review_user_name', 'reviewUserName', 'revoke_user', 'revokeUser']);
  const reviewTime = formatDate(firstValue(raw, ['approve_time', 'approveTime', 'review_time', 'reviewTime', 'revoke_time', 'revokeTime']));
  const base = {
    type,
    typeLabel: type === 'purchase' ? '采购申请' : (type === 'product' ? '新建商品' : '报销申请'),
    status,
    statusText: statusText(type, status),
    currentStage: firstValue(raw, ['current_stage_name', 'currentStageName', 'current_stage', 'currentStage']) || stageText(type, status),
    recordNo: firstValue(raw, ['request_no', 'requestNo', 'application_no', 'applicationNo', 'expense_no', 'expenseNo']) || '-',
    createTime: formatDate(firstValue(raw, ['create_time', 'createTime'])),
    reviewComment,
    reviewUserName,
    reviewTime
  };

  if (type === 'purchase') {
    base.supplierName = firstValue(raw, ['supplier_name', 'supplierName']) || raw.Supplier?.name || '-';
    base.storeName = firstValue(raw, ['store_name', 'storeName']) || raw.Store?.name || '-';
    base.reason = firstValue(raw, ['reason', 'remark']) || '-';
    base.amountText = Number(firstValue(raw, ['total_amount', 'totalAmount']) || 0).toFixed(2);
    base.items = (raw.items || raw.PurchaseRequestItems || []).map(item => ({
      name: item.product_name || item.productName || item.product_id || '-',
      quantity: item.quantity || 0,
      unitPrice: Number(item.unit_price || item.unitPrice || 0).toFixed(2),
      subtotal: Number(item.subtotal || 0).toFixed(2)
    }));
    base.inbounds = (raw.Inbounds || raw.inbounds || []).map(item => ({
      no: item.inbound_no || item.inboundNo || item.inbound_id || '-',
      status: item.status || '-'
    }));
  } else if (type === 'product') {
    const payload = parseJson(raw.payload_json || raw.payloadJson, {});
    base.productName = firstValue(raw, ['product_name', 'productName']) || payload.name || '-';
    base.categoryName = firstValue(raw, ['category_name', 'categoryName']) || '-';
    base.applicantName = firstValue(raw, ['applicant_name', 'applicantName']) || '-';
    base.productRows = [
      { label: 'PN编码', value: (payload.barcodes || []).map(item => item.code).filter(Boolean).join('、') || payload.manufacturerCode || '-' },
      { label: '规格配置', value: payload.config || '-' },
      { label: '单位', value: payload.unit || '-' },
      { label: '备注', value: payload.remark || '-' }
    ];
  } else {
    base.storeName = firstValue(raw, ['store_name', 'storeName']) || raw.Store?.name || '-';
    base.expenseType = firstValue(raw, ['expense_type', 'expenseType']) || '-';
    base.expenseParty = firstValue(raw, ['expense_party', 'expenseParty']) || '-';
    base.expenseDate = firstValue(raw, ['expense_date', 'expenseDate']) || '-';
    base.paymentMethod = firstValue(raw, ['payment_method', 'paymentMethod']) || '-';
    base.reason = firstValue(raw, ['remark', 'reason']) || '-';
    base.amountText = Number(firstValue(raw, ['amount']) || 0).toFixed(2);
  }
  return base;
}

Page({
  data: { loading: true, error: '', detail: null },

  onLoad(options) {
    const type = options.type || '';
    const id = options.id || '';
    if (!type || !id) {
      this.setData({ loading: false, error: '缺少申请信息' });
      return;
    }
    let request;
    if (type === 'purchase') request = api.purchase.detail(id);
    else if (type === 'product') request = api.product.applicationDetail(id);
    else if (type === 'expense') request = api.expense.detail(id);
    else request = Promise.reject(new Error('申请类型不支持'));

    request.then(result => {
      this.setData({ detail: normalizeDetail(type, unwrap(result)), loading: false });
    }).catch(error => {
      this.setData({ loading: false, error: error.message || '申请详情加载失败' });
    });
  }
});
