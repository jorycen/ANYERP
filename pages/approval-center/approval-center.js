const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');
const imageUpload = require('../../utils/image-upload.js');
const { normalizePnCode } = require('../../utils/pn.js');

const APPROVAL_PAGE_SIZE = 20;

const TYPE_CONFIG = {
  sales: { label: '销售审批', className: 'sales' },
  purchase: { label: '采购审批', className: 'purchase' },
  expense: { label: '报销审批', className: 'purchase' },
  product: { label: '商品审批', className: 'product' },
  return: { label: '退库审批', className: 'return' },
  salesReturn: { label: '销售退单', className: 'return' },
  resource: { label: '资源套回', className: 'resource' },
  profit: { label: '毛利调整', className: 'profit' }
};

function listOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  return [];
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function photoList(...values) {
  const result = [];
  const imageKey = key => /photo|image|picture|attachment|screenshot|voucher|proof|receipt|invoice|label|file|path|url|link|resource|凭证|图片|照片|附件/i.test(key || '');
  const isFileReference = value => /^(?:cloud:\/\/|https?:\/\/|wxfile:\/\/|\/|data:image\/|blob:)/i.test(value || '');
  const isImageFileName = value => /\.(?:jpg|jpeg|png|gif|webp|bmp|heic)(?:[?#].*)?$/i.test(value || '');
  const add = value => {
    if (value && !result.includes(value)) result.push(value);
  };
  const visit = (value, key = '') => {
    if (!value) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (parsed !== value) {
          visit(parsed, key);
          return;
        }
      } catch (_) {
        // 普通字符串按图片地址或文件 ID 处理。
      }
      // 业务字段也可能叫 xxxUrl/xxxPhoto，但值可能是标题或枚举（例如 GOV_SUBSIDY）。
      // 只有真实文件地址、云文件 ID 或图片文件名才允许进入图片列表。
      if (isFileReference(text) || (imageKey(key) && isImageFileName(text))) add(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, key));
      return;
    }
    if (typeof value !== 'object') return;

    const direct = value.fileID || value.fileId || value.file_id || value.url || value.tempFileURL || value.tempFileUrl ||
      value.downloadUrl || value.downloadURL || value.download_url || value.fileUrl || value.file_url || value.imageUrl || value.image_url ||
      value.photoUrl || value.photo_url || value.cloudPath || value.cloud_path || value.filePath || value.file_path ||
      value.temp_file_url || value.temp_file_path || value.storagePath || value.storage_path || value.path || value.link;
    if (direct && (isFileReference(direct) || isImageFileName(direct))) add(direct);
    Object.keys(value).forEach(childKey => {
      // 详情接口常把申请单包在 data/request/application 等嵌套对象中，不能只遍历图片字段。
      // visit 内部仍会校验字段名或文件地址，因此不会把普通备注文本当成附件。
      visit(value[childKey], childKey);
    });
  };
  values.forEach(value => visit(value));
  return result;
}

function attachmentItems(...values) {
  const result = [];
  const attachmentKey = key => /photo|image|picture|attachment|screenshot|voucher|proof|receipt|invoice|label|file|path|url|link|resource|凭证|图片|照片|附件/i.test(key || '');
  const isFileReference = value => /^(?:cloud:\/\/|https?:\/\/|wxfile:\/\/|\/|data:|blob:)/i.test(value || '');
  const isKnownFileName = value => /\.(?:jpg|jpeg|png|gif|webp|bmp|heic|pdf|docx?|xlsx?|pptx?|zip|rar|txt)(?:[?#].*)?$/i.test(value || '');
  const add = (url, source, name, mimeType) => {
    if (!url || result.some(item => item.url === url)) return;
    const text = String(url);
    const label = name || (typeof source === 'string' ? source.split('/').pop().split('?')[0] : '') || '附件';
    const image = /^image\//i.test(mimeType || '') || /\.(?:jpg|jpeg|png|gif|webp|bmp|heic)(?:[?#].*)?$/i.test(`${label} ${text}`) || (!mimeType && !/\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|txt)(?:[?#].*)?$/i.test(`${label} ${text}`));
    result.push({ url: text, name: label, isImage: image });
  };
  const visit = (value, key = '', meta = {}) => {
    if (!value) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (parsed !== value) {
          visit(parsed, key, meta);
          return;
        }
      } catch (_) {
        // 普通字符串继续按文件地址或附件字段处理。
      }
      if (isFileReference(text) || (attachmentKey(key) && isKnownFileName(text))) add(text, text, meta.name, meta.mimeType);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, key, meta));
      return;
    }
    if (typeof value !== 'object') return;
    const name = value.name || value.fileName || value.file_name || value.originalName || value.original_name || value.title || meta.name;
    const mimeType = value.mimeType || value.mime_type || value.type || meta.mimeType;
    const direct = value.fileID || value.fileId || value.file_id || value.url || value.tempFileURL || value.tempFileUrl ||
      value.downloadUrl || value.downloadURL || value.download_url || value.fileUrl || value.file_url || value.imageUrl || value.image_url ||
      value.photoUrl || value.photo_url || value.cloudPath || value.cloud_path || value.filePath || value.file_path ||
      value.temp_file_url || value.temp_file_path || value.storagePath || value.storage_path || value.path || value.link;
    if (direct && (isFileReference(direct) || isKnownFileName(direct))) add(direct, direct, name, mimeType);
    Object.keys(value).forEach(childKey => visit(value[childKey], childKey, { name, mimeType }));
  };
  values.forEach(value => visit(value));
  return result;
}

function resolveAttachments(...values) {
  const attachments = attachmentItems(...values);
  return imageUpload.resolveImageUrls(attachments.map(item => item.url))
    .catch(() => attachments.map(item => item.url))
    .then(urls => attachments.map((item, index) => Object.assign({}, item, { url: urls[index] || item.url })));
}

function detailObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.data && !Array.isArray(value.data) && typeof value.data === 'object') return value.data;
  return value;
}

function uniqueValues(values) {
  const result = [];
  (Array.isArray(values) ? values : []).forEach(value => {
    if (value && !result.includes(value)) result.push(value);
  });
  return result;
}

function taskPageParams(options = {}) {
  return {
    page: Math.max(1, Number(options.page) || 1),
    pageSize: Math.max(1, Number(options.pageSize) || APPROVAL_PAGE_SIZE)
  };
}

function resolveTaskPhotos(tasks) {
  return Promise.all(tasks.map(task => {
    // 与调拨管理保持一致：原始照片 ID 单独保存，页面只使用转换后的 photoUrls。
    const photoIds = uniqueValues(Array.isArray(task.photos) ? task.photos : photoList(task.raw));
    return imageUpload.resolveImageUrls(photoIds)
      .catch(() => photoIds)
      .then(photoUrls => resolveAttachments(task.raw)
        .then(attachments => {
          const uniquePhotoUrls = uniqueValues(photoUrls);
          const fileItems = attachments.filter(item => !item.isImage);
          task.photoIds = photoIds;
          task.photoUrls = uniquePhotoUrls;
          task.photos = uniquePhotoUrls;
          task.attachments = uniquePhotoUrls.map(url => ({ url, name: '图片', isImage: true })).concat(fileItems);
          task.files = fileItems;
          return task;
        }));
  }));
}

function loadTaskDetails(task) {
  if (!task || !task.businessId) return Promise.resolve(task);
  let detailPromise = Promise.resolve(null);
  if (task.type === 'sales') detailPromise = api.order.getDetails(task.businessId).catch(() => null);
  if (task.type === 'purchase') detailPromise = api.purchase.detail(task.businessId).catch(() => null);

  return detailPromise.then(detail => {
    const source = detailObject(detail);
    if (!source) return task;

    task.raw = Object.assign({}, task.raw, source);
    const currentUser = userUtils.getUserInfo();
    if (['sales', 'purchase', 'product'].includes(task.type)) {
      task.organizationName = applicantOrganization(task.raw, currentUser);
      task.organizationLabel = applicantOrganizationLabel(task.raw, currentUser);
    }
    if (task.type === 'sales') {
      task.needsApproval = String(task.raw.status || task.raw.order_status || '') === 'pending_approval';
      task.details = (task.details || []).map(row => {
        if (row.label === '审批要求') row.value = '归档前最终毛利为负';
        return row;
      });
    }
    if (task.type === 'purchase') {
      const targetStore = task.raw.store_name || task.raw.storeName || task.raw.Store?.name || '';
      if (targetStore) {
        task.details = (task.details || []).map(row => row.label === '采购门店' ? Object.assign({}, row, { value: targetStore }) : row);
      }
    }
    task.photos = uniqueValues((task.photos || []).concat(photoList(source)));
    if (task.type !== 'sales') return task;
    return api.order.getGrossProfit(task.businessId).then(grossProfit => {
      const profit = detailObject(grossProfit) || {};
      const amount = profit.grossProfitAmount ?? profit.gross_profit_amount;
      if (amount !== undefined && amount !== null && Number.isFinite(Number(amount))) {
        task.details = (task.details || []).map(row => row.label === '毛利'
          ? Object.assign({}, row, { value: `¥${money(amount)}` })
          : row);
      }
      return task;
    }).catch(() => task);
  }).then(updatedTask => resolveTaskPhotos([updatedTask]).then(tasks => tasks[0] || updatedTask));
}

function displayAttributes(value) {
  const attributes = parseObject(value);
  return Object.keys(attributes).map(key => `${key}: ${attributes[key]}`).join('；') || '-';
}

function buildProductEditForm(application, payload, task) {
  const attributes = parseObject(payload.attributes);
  const barcodes = Array.isArray(payload.barcodes) ? payload.barcodes : [];
  const pnCode = normalizePnCode(payload.pnCode || payload.pn_code || barcodes.map(item => item && item.code).find(Boolean) || '');
  return {
    name: task.title || payload.name || '',
    categoryId: application.category_id || application.categoryId || payload.categoryId || '',
    categoryName: application.category_name || application.categoryName || payload.categoryName || '-',
    categoryIndex: -1,
    config: payload.config || '',
    pnCode,
    unit: payload.unit || '鍙?',
    needSn: Boolean(payload.needSn || payload.need_sn),
    needImei: Boolean(payload.needImei || payload.need_imei),
    remark: payload.remark || '',
    attributes,
    attributeRows: Object.keys(attributes).map(key => ({ key, label: key, value: attributes[key] })),
    labelPhotoIds: uniqueValues([].concat(payload.labelPhotoIds || [], payload.label_photo_ids || [])),
    labelPhotoUrls: uniqueValues([].concat(payload.labelPhotoUrls || [], payload.label_photo_urls || []))
  };
}

function buildProductReviewPayload(task) {
  const form = task && task.productEdit ? task.productEdit : {};
  const attributes = {};
  (form.attributeRows || []).forEach(row => {
    const key = String(row.key || '').trim();
    if (key && row.value !== undefined && row.value !== null && String(row.value).trim() !== '') attributes[key] = row.value;
  });
  const pnCode = normalizePnCode(form.pnCode || '');
  return {
    name: String(form.name || '').trim(),
    categoryId: form.categoryId || '',
    config: String(form.config || '').trim(),
    pnCode,
    barcodes: pnCode ? [{ type: 'manufacturer', code: pnCode }] : [],
    unit: String(form.unit || '鍙?').trim(),
    needSn: form.needSn ? 1 : 0,
    needImei: form.needImei ? 1 : 0,
    remark: String(form.remark || '').trim(),
    attributes: Object.keys(attributes).length ? attributes : null,
    labelPhotoIds: (form.labelPhotoIds || []).slice(),
    labelPhotoUrls: (form.labelPhotoUrls || []).slice(),
    labelPhotoUrl: (form.labelPhotoIds || [])[0] || (form.labelPhotoUrls || [])[0] || ''
  };
}

function flattenProductCategories(result) {
  const tree = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
  const options = [];
  const walk = (nodes, level) => (nodes || []).forEach(node => {
    const categoryId = node.category_id || node.categoryId || node.id || '';
    const name = node.name || '';
    if (categoryId) options.push({ categoryId, name, displayName: `${level ? '　'.repeat(level) : ''}${name}` });
    walk(node.children, level + 1);
  });
  walk(tree, 0);
  return options;
}

function fallbackRoles(user) {
  if (Array.isArray(user.roles) && user.roles.length) return user.roles;
  if (user.roleCode) return String(user.roleCode).split(',').filter(Boolean);
  if (user.userRole === 'distributor') return ['admin'];
  if (user.userRole === 'store_admin') return ['manager'];
  return ['clerk'];
}

function hasAnyRole(roles, allowed) {
  return roles.includes('boss') || roles.some(role => allowed.includes(role));
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function historyStatusFor(type, status) {
  if (!status) return '';
  if (type === 'sales') return status === 'approved' ? '已归档' : '已作废';
  return status;
}

function rawStatus(raw = {}) {
  return String(raw.status || raw.approval_status || raw.approvalStatus || raw.approval_stage || '').toLowerCase();
}

function historyStageText(raw = {}) {
  const status = rawStatus(raw);
  if (['approved', 'archived', '已通过', '已归档', 'completed', 'paid'].includes(status)) return '已通过';
  if (['rejected', 'voided', 'cancelled', '已拒绝', '已作废', 'rejected_by_store', 'rejected_by_distributor'].includes(status)) return '已拒绝';
  return raw.statusText || raw.status_text || '已处理';
}

function handledByUser(task, user) {
  const raw = task.raw || {};
  const status = rawStatus(raw);
  if (!status || ['pending', 'pending_approval', 'pending_finance', 'pending_admin', 'pending_store', 'pending_distributor'].includes(status)) return false;
  const ids = [
    raw.review_user_id, raw.reviewUserId, raw.reviewer_id, raw.reviewerId, raw.approver_id, raw.approverId,
    raw.approved_by, raw.approvedBy, raw.reviewed_by, raw.reviewedBy,
    raw.finance_reviewer_id, raw.financeReviewerId, raw.admin_reviewer_id, raw.adminReviewerId
  ].filter(value => value !== undefined && value !== null && value !== '').map(value => String(value));
  const names = [
    raw.review_user_name, raw.reviewUserName, raw.reviewer_name, raw.reviewerName, raw.approver_name, raw.approverName,
    raw.approved_by_name, raw.approvedByName, raw.reviewed_by_name, raw.reviewedByName,
    raw.finance_reviewer_name, raw.financeReviewerName, raw.admin_reviewer_name, raw.adminReviewerName
  ].filter(Boolean).map(value => String(value).trim());
  const userIds = [user.staffId, user.userId, user.id].filter(Boolean).map(value => String(value));
  const userNames = [user.userName, user.name].filter(Boolean).map(value => String(value).trim());
  // 有明确审批人时必须匹配当前账号；没有审批人字段时，接口通常已经通过 scope=review 限定范围。
  if (ids.length || names.length) return ids.some(id => userIds.includes(id)) || names.some(name => userNames.includes(name));
  return true;
}

function markHistoryTask(task, user) {
  task.readOnly = true;
  task.stageText = historyStageText(task.raw);
  return handledByUser(task, user) ? task : null;
}

function isDistributorAccount(user = {}) {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return user.userRole === 'distributor' || user.role === 'distributor' ||
    roles.some(role => ['boss', 'admin', 'distributor', 'system_admin'].includes(String(role).toLowerCase()));
}

function isDistributorApplicant(raw = {}, user = {}) {
  const applicant = raw.Applicant || raw.applicant || raw.applicantStaff || {};
  const role = raw.applicant_role_code || raw.applicantRoleCode || applicant.role_code || applicant.roleCode || '';
  if (role) return ['boss', 'admin', 'distributor', 'system_admin'].includes(String(role).toLowerCase());
  return isDistributorAccount(user);
}

function applicantOrganization(raw = {}, user = {}) {
  const applicant = raw.Applicant || raw.applicant || raw.applicantStaff || {};
  const distributorName = raw.applicant_distributor_name || raw.applicantDistributorName || applicant.Distributor?.name || applicant.distributor_name || raw.distributor_name || raw.distributorName || raw.Distributor?.name || user.distributorName || '';
  const storeName = raw.applicant_store_name || raw.applicantStoreName || applicant.Store?.name || applicant.store_name || raw.store_name || raw.storeName || raw.Store?.name || '';
  if (isDistributorApplicant(raw, user)) return distributorName || storeName || '-';
  return storeName || distributorName || '-';
}

function applicantOrganizationLabel(raw = {}, user = {}) {
  return isDistributorApplicant(raw, user) ? '所属经销商' : '所属门店';
}

function taskBase(type, raw) {
  const config = TYPE_CONFIG[type];
  const createTime = raw.create_time || raw.createTime || '';
  return {
    key: '',
    type,
    typeLabel: config.label,
    typeClass: config.className,
    businessId: '',
    no: '',
    title: '',
    summary: '',
    storeName: raw.store_name || raw.storeName || raw.Store?.name || '',
    organizationName: raw.store_name || raw.storeName || raw.Store?.name || '',
    organizationLabel: '所属门店',
    applicant: raw.applicant_name || raw.create_user || raw.createUser || '',
    createTime,
    createTimeText: formatTime(createTime),
    sortTime: new Date(createTime || 0).getTime() || 0,
    amountLabel: '金额',
    amountText: '',
    stageText: '待审批',
    readOnly: false,
    details: [],
    items: [],
    photos: [],
    photoIds: [],
    photoUrls: [],
    attachments: [],
    files: [],
    photoLabel: '',
    detailLoading: false,
    detailLoaded: false,
    raw
  };
}

Page({
  data: {
    roles: [],
    loading: true,
    refreshing: false,
    tasks: [],
    visibleTasks: [],
    filters: [{ type: 'all', label: '全部', count: 0 }],
    activeType: 'all',
    selectedTask: null,
    reviewComment: '',
    submitting: false,
    partialError: '',
    approvalPage: 1,
    approvalHasMore: false,
    loadingMore: false,
    viewMode: 'pending',
    historyKeyword: '',
    historyStatus: '',
    historyStatusIndex: 0,
    historyStatusOptions: ['全部', '已通过', '已拒绝'],
    productHistory: [],
    productCategoryOptions: [],
    historyLoading: false,
    historyPage: 1,
    historyHasMore: false,
    historyLoadingMore: false
  },

  onLoad() {
    if (userUtils.isPurchaseQueryOnly()) {
      wx.reLaunch({ url: '/pages/purchase-application/purchase-application' });
      return;
    }
    this.refreshProfile().then(() => this.loadApprovals());
  },

  onPullDownRefresh() {
    this.setData({ refreshing: true });
    this.refreshProfile()
      .then(() => this.loadApprovals({ page: 1 }))
      .finally(() => {
        this.setData({ refreshing: false });
        wx.stopPullDownRefresh();
      });
  },

  noop() {},

  refreshProfile() {
    const cached = userUtils.getUserInfo();
    return api.auth.getProfile()
      .then(profile => {
        const next = Object.assign({}, cached, {
          userId: profile.staffId || profile.id || cached.userId,
          staffId: profile.staffId || profile.id || cached.staffId || cached.userId,
          userName: profile.name || cached.userName,
          userRole: profile.role || cached.userRole,
          roleCode: profile.roleCode || cached.roleCode || '',
          roleName: profile.roleName || cached.roleName || '',
          roleNames: profile.roleNames || [],
          roles: profile.roles || [],
          distributorId: profile.distributorId || profile.distributor_id || cached.distributorId || '',
          distributorName: profile.distributorName || profile.distributor_name || cached.distributorName || '',
          storeId: profile.storeId || cached.storeId || '',
          storeName: profile.storeName || cached.storeName || '',
          storeIds: profile.storeIds || [],
          menus: profile.menus || []
        });
        userUtils.setUserInfo(next);
        getApp().globalData.userInfo = next;
        this.setData({ roles: fallbackRoles(next) });
      })
      .catch(err => {
        console.warn('刷新审批账号权限失败，使用本地角色:', err);
        this.setData({ roles: fallbackRoles(cached) });
      });
  },

  loadApprovals(options = {}) {
    const { page, pageSize } = taskPageParams(options);
    const append = page > 1;
    const roles = this.data.roles;
    const loaders = [
      { type: 'return', run: () => this.loadReturnTasks({ page, pageSize }) },
      { type: 'salesReturn', run: () => this.loadSalesReturnTasks({ page, pageSize }) }
    ];

    if (hasAnyRole(roles, ['admin', 'manager'])) {
      loaders.push({ type: 'sales', run: () => this.loadSalesTasks({ page, pageSize }) });
    }
    if (hasAnyRole(roles, ['admin', 'purchaser'])) {
      loaders.push({ type: 'purchase', run: () => this.loadPurchaseTasks({ page, pageSize }) });
    }
    if (hasAnyRole(roles, ['admin'])) {
      loaders.push({ type: 'expense', run: () => this.loadExpenseTasks({ page, pageSize }) });
    }
    if (hasAnyRole(roles, ['admin', 'finance', 'purchaser'])) {
      loaders.push({ type: 'product', run: () => this.loadProductTasks({ page, pageSize }) });
    }
    if (roles.includes('finance')) {
      loaders.push({ type: 'resource', run: () => this.loadResourceTasks({ page, pageSize }) });
    }
    if (roles.includes('finance') || roles.includes('admin')) {
      loaders.push({ type: 'profit', run: () => this.loadProfitTasks({ page, pageSize }) });
    }

    this.setData({ loading: !append, loadingMore: append, partialError: '' });
    const settled = [];
    const failed = [];
    const publish = () => {
      const tasks = settled.reduce((all, result) => result && result.ok ? all.concat(result.value || []) : all, []);
      const merged = append ? this.data.tasks.concat(tasks) : tasks;
      const uniqueTasks = [];
      const seenKeys = {};
      merged.forEach(task => {
        if (!task || seenKeys[task.key]) return;
        seenKeys[task.key] = true;
        uniqueTasks.push(task);
      });
      uniqueTasks.sort((left, right) => right.sortTime - left.sortTime);
      this.updateTasks(uniqueTasks, failed);
      this.setData({ approvalPage: page, approvalHasMore: settled.some(result => result && result.ok && result.value && result.value.length >= pageSize) });
    };
    return Promise.all(loaders.map((loader, index) => loader.run()
      .then(value => {
        settled[index] = { ok: true, value };
        publish();
        return settled[index];
      })
      .catch(reason => {
        failed.push(TYPE_CONFIG[loader.type].label);
        console.error(`加载${TYPE_CONFIG[loader.type].label}失败:`, reason);
        settled[index] = { ok: false, reason };
        publish();
        return settled[index];
      })))
      .finally(() => this.setData({ loading: false, loadingMore: false }));
  },

  loadMoreApprovals() {
    if (this.data.loading || this.data.loadingMore || !this.data.approvalHasMore) return;
    return this.loadApprovals({ page: this.data.approvalPage + 1, pageSize: APPROVAL_PAGE_SIZE });
  },

  updateTasks(tasks, failed) {
    const filters = [{ type: 'all', label: '全部', count: tasks.length }];
    Object.keys(TYPE_CONFIG).forEach(type => {
      const count = tasks.filter(task => task.type === type).length;
      if (count) filters.push({ type, label: TYPE_CONFIG[type].label, count });
    });
    const activeExists = filters.some(filter => filter.type === this.data.activeType);
    const activeType = activeExists ? this.data.activeType : 'all';
    this.setData({
      tasks,
      filters,
      activeType,
      visibleTasks: activeType === 'all' ? tasks : tasks.filter(task => task.type === activeType),
      partialError: failed.length ? `${failed.join('、')}加载失败，可下拉重试` : ''
    });
  },

  switchFilter(e) {
    const activeType = e.currentTarget.dataset.type;
    const visibleTasks = activeType === 'all'
      ? this.data.tasks
      : this.data.tasks.filter(task => task.type === activeType);
    this.setData({ activeType, visibleTasks });
  },

  switchViewMode(e) {
    const viewMode = e.currentTarget.dataset.mode;
    this.setData({ viewMode });
    if (viewMode === 'history' && !this.data.productHistory.length) this.loadApprovalHistory();
  },

  onHistoryKeywordInput(e) {
    this.setData({ historyKeyword: e.detail.value });
  },

  onHistoryStatusChange(e) {
    const historyStatusIndex = Number(e.detail.value);
    const historyStatus = ['', 'approved', 'rejected'][historyStatusIndex] || '';
    this.setData({ historyStatusIndex, historyStatus });
    this.loadApprovalHistory();
  },

  searchProductHistory() {
    this.loadApprovalHistory();
  },

  loadSalesTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    return api.order.queryList({ status: historyStatusFor('sales', history ? this.data.historyStatus : 'pending_approval'), scope: history ? 'review' : '', page, pageSize })
      .then(result => (result.data || []).map(order => {
        const task = taskBase('sales', order);
        task.organizationName = applicantOrganization(order, user);
        task.organizationLabel = applicantOrganizationLabel(order, user);
        task.needsApproval = String(order.status || order.order_status || '') === 'pending_approval';
        task.businessId = order.orderId || order.order_id || order._id;
        task.key = `sales:${task.businessId}`;
        task.no = order.orderNo || order.order_no || task.businessId;
        task.title = order.contactName || order.customer_name || '销售订单';
        task.summary = `订单金额 ¥${money(order.totalAmount || order.total_amount)}，实付 ¥${money(order.actualAmount || order.actual_payment)}`;
        task.amountLabel = '订单金额';
        task.amountText = money(order.totalAmount || order.total_amount);
        task.applicant = order.createUser || order.create_user || '';
        task.stageText = history ? historyStageText(order) : '待店长或经销商老板审批';
        task.readOnly = history;
        task.details = [
          { label: '客户', value: order.contactName || order.customer_name || '-' },
          { label: '联系电话', value: order.contactMethod || order.customer_phone || '-' },
          { label: '实际应收', value: `¥${money(order.actualAmount || order.actual_payment || order.totalAmount || order.total_amount)}` },
          { label: '毛利', value: '正在读取后端毛利快照' },
          { label: '审批要求', value: '归档前最终毛利为负' }
        ];
        task.photoLabel = '订单上传图片';
        task.photos = photoList(
          order,
          order.subsidyPhotos,
          order.subsidy_photos,
          order.productPhotoUrls,
          order.product_photo_urls,
          order.educationSubsidyPhotoUrl,
          order.education_subsidy_photo_url,
          order.personalInfoPhoto,
          order.personal_info_photo,
          order.attachments,
          order.photos,
          order.images,
          order.orderPhotos,
          order.order_photos
        );
        task.items = (order.goods || order.items || []).map(item => ({
          name: item.productName || item.product_name || '商品',
          meta: [item.pnCode, item.snCode || item.sn_code].filter(Boolean).join(' / '),
          quantity: Number(item.quantity || 1),
          amount: `¥${money(item.salePrice || item.unitPrice || item.unit_price || item.price)}`
        }));
        return task;
      }))
      .then(tasks => {
        if (!history) tasks = tasks.filter(task => task.needsApproval);
        return history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks;
      });
  },

  loadPurchaseTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    return api.purchase.list({ status: historyStatusFor('purchase', history ? this.data.historyStatus : 'pending'), scope: history ? 'review' : '', page, pageSize })
      .then(result => listOf(result).map(request => {
        const task = taskBase('purchase', request);
        task.organizationName = applicantOrganization(request, user);
        task.organizationLabel = applicantOrganizationLabel(request, user);
        task.businessId = request.request_id || request.requestId;
        task.key = `purchase:${task.businessId}`;
        task.no = request.request_no || request.requestNo || task.businessId;
        task.title = request.supplier_name || request.Supplier?.name || '采购申请';
        task.summary = request.items_summary || '采购商品明细';
        task.amountLabel = '采购金额';
        task.amountText = money(request.total_amount || request.totalAmount);
    task.applicant = request.apply_user || request.applyUser || request.submitter_name || request.submitterName || request.create_user || request.createUser || '';
        task.stageText = history ? historyStageText(request) : task.stageText;
        task.readOnly = history;
        task.details = [
          { label: '采购门店', value: request.store_name || request.storeName || request.Store?.name || '-' },
          { label: '供应商', value: request.supplier_name || request.Supplier?.name || '-' },
          { label: '发票类型', value: request.invoice_type || request.invoiceType || '-' },
          { label: '申请备注', value: request.remark || '-' }
        ];
        const purchasePhotoUrls = imageUpload.normalizeImageValues([
          request.supplier_chat_screenshot_urls,
          request.supplierChatScreenshotUrls,
          request.supplier_chat_screenshot_url,
          request.supplierChatScreenshotUrl
        ]);
        const purchasePhotoIds = imageUpload.normalizeImageValues([
          request.supplier_chat_screenshot_ids,
          request.supplier_chat_screenshot_file_ids,
          request.supplierChatScreenshotIds
        ]);
        task.photos = photoList(
          request,
          request.supplier_chat_screenshot_urls,
          request.supplier_chat_screenshot_ids,
          request.supplier_chat_screenshot_file_ids,
          request.supplierChatScreenshotUrls,
          request.supplierChatScreenshotIds,
          request.supplier_chat_screenshot_url,
          request.supplierChatScreenshotUrl,
          request.attachments,
          request.photos,
          request.images
        );
        // URL 优先，云文件 ID 作为兜底，避免同一图片被重复展示。
        task.photos = purchasePhotoUrls.concat(purchasePhotoIds).filter((value, index, list) => list.indexOf(value) === index);
        task.photoLabel = '供应商群喊货截图';
        task.items = (request.items || []).map(item => ({
          name: item.product_name || item.productName || item.product_id || '商品',
          meta: item.product_type || item.productType || '',
          quantity: Number(item.quantity || 0),
          amount: `¥${money(item.unit_price || item.price)}`
        }));
        return task;
      }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  loadExpenseTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    const staffId = String(user.staffId || user.userId || '');
    return api.expense.list({ status: historyStatusFor('expense', history ? this.data.historyStatus : 'pending_approval'), scope: history ? 'review' : '', page, pageSize })
      .then(result => listOf(result)
        .filter(row => history || String(row.applicant_staff_id || '') !== staffId)
        .map(row => {
          const task = taskBase('expense', row);
          task.businessId = row.expense_id || row.expenseId;
          task.key = `expense:${task.businessId}`;
          task.no = row.expense_no || row.expenseNo || task.businessId;
          task.title = `${row.expense_type || '费用'} · ${row.expense_party || '-'}`;
          task.summary = row.source_type === 'purchase'
            ? `采购个人垫付 ${row.source_no || ''}`
            : `${row.region_name || row.store_name || ''} 费用报销`;
          task.amountLabel = '报销金额';
          task.amountText = money(row.amount);
          task.applicant = row.applicant_name || row.create_user || '';
          task.stageText = history ? historyStageText(row) : task.stageText;
          task.readOnly = history;
          task.details = [
            { label: '区域', value: row.region_name || '-' },
            { label: '报销类型', value: row.expense_type || '-' },
            { label: '费用发生方', value: row.expense_party || '-' },
            { label: '支付方式', value: '私人垫付' },
            { label: '发票', value: row.has_invoice ? `有${row.invoice_type ? ` · ${row.invoice_type}` : ''}` : '无' },
            { label: '说明', value: row.remark || '-' }
          ];
          task.photos = photoList(
            row,
            row.attachment_urls,
            row.attachmentUrls,
            row.attachments,
            row.invoice_photos,
            row.invoicePhotos,
            row.photos,
            row.images
          );
          task.photoLabel = '报销附件';
          return task;
        }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  loadProductTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    const staffId = String(user.staffId || user.userId || '');
    return api.product.getApplications({ status: historyStatusFor('product', history ? this.data.historyStatus : 'pending'), scope: history ? 'review' : '', keyword: history ? (this.data.historyKeyword || '').trim() : '', page, pageSize })
      .then(result => listOf(result)
        .filter(application => history || String(application.applicant_staff_id || '') !== staffId)
        .map(application => this.buildProductTask(application, history)))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  buildProductTask(application, readOnly) {
    const task = taskBase('product', application);
    const payload = parseObject(application.payload_json);
    const barcodes = (payload.barcodes || []).map(item => item && item.code).filter(Boolean);
    const statusText = { pending: '待审批', approved: '已通过', rejected: '已拒绝' }[application.status] || application.status || '待审批';
    task.businessId = application.application_id || application.applicationId;
    task.key = `product:${task.businessId}`;
    task.no = application.application_no || application.applicationNo || task.businessId;
    task.title = application.product_name || application.productName || payload.name || '新建商品';
    task.summary = `${application.category_name || '未分类'} · ${payload.config || '未填写厂商商品名称'} · PN ${barcodes.join('、') || '-'}`;
    task.applicant = application.applicant_name || '';
    task.stageText = statusText;
    task.readOnly = Boolean(readOnly || application.status !== 'pending');
    task.details = [
      { label: '商品名称', value: task.title },
      { label: '商品分类', value: application.category_name || payload.categoryName || '-' },
      { label: 'PN码', value: barcodes.join('、') || payload.pnCode || '-' },
      { label: '厂商商品名称', value: payload.config || '-' },
      { label: '单位', value: payload.unit || '台' },
      { label: 'SN / IMEI', value: `${payload.needSn ? '需要SN' : '不需要SN'} / ${payload.needImei ? '需要IMEI' : '不需要IMEI'}` },
      { label: '配置属性', value: displayAttributes(payload.attributes) },
      { label: '备注', value: payload.remark || '-' }
    ];
    task.organizationName = applicantOrganization(application, userUtils.getUserInfo());
    task.organizationLabel = applicantOrganizationLabel(application, userUtils.getUserInfo());
    task.productEdit = buildProductEditForm(application, payload, task);
    task.photos = photoList(
      application,
      payload,
      payload.labelPhotoUrls,
      payload.labelPhotoUrl,
      payload.labelPhotoIds,
      payload.labelPhotoId,
      payload.label_photo_urls,
      payload.label_photo_url,
      payload.label_photo_ids,
      payload.label_photo_id,
      application.label_photo_urls,
      application.label_photo_ids,
      application.labelPhotoUrls,
      application.labelPhotoIds,
      application.label_photo_url,
      application.labelPhotoUrl
    );
    task.photoLabel = '商品标签照片';
    if (application.review_user_name || application.review_comment || application.review_time) {
      task.details.push(
        { label: '审批人', value: application.review_user_name || '-' },
        { label: '审批意见', value: application.review_comment || '-' },
        { label: '审批时间', value: formatTime(application.review_time) }
      );
    }
    return task;
  },

  loadApprovalHistory(options = {}) {
    const { page, pageSize } = taskPageParams(options);
    const append = page > 1;
    const roles = this.data.roles || [];
    this.setData({ historyLoading: !append, historyLoadingMore: append });
    const loaders = [
      { type: 'return', run: () => this.loadReturnTasks({ history: true, page, pageSize }) },
      { type: 'salesReturn', run: () => this.loadSalesReturnTasks({ history: true, page, pageSize }) }
    ];
    if (hasAnyRole(roles, ['admin', 'manager'])) loaders.push({ type: 'sales', run: () => this.loadSalesTasks({ history: true, page, pageSize }) });
    if (hasAnyRole(roles, ['admin', 'purchaser'])) loaders.push({ type: 'purchase', run: () => this.loadPurchaseTasks({ history: true, page, pageSize }) });
    if (hasAnyRole(roles, ['admin'])) loaders.push({ type: 'expense', run: () => this.loadExpenseTasks({ history: true, page, pageSize }) });
    if (hasAnyRole(roles, ['admin', 'finance', 'purchaser'])) loaders.push({ type: 'product', run: () => this.loadProductTasks({ history: true, page, pageSize }) });
    if (roles.includes('finance')) loaders.push({ type: 'resource', run: () => this.loadResourceTasks({ history: true, page, pageSize }) });
    if (roles.includes('finance') || roles.includes('admin')) loaders.push({ type: 'profit', run: () => this.loadProfitTasks({ history: true, page, pageSize }) });

    const settled = [];
    const publish = () => {
      const keyword = (this.data.historyKeyword || '').trim().toLowerCase();
      const groups = settled.filter(Boolean).map(result => result.value || []);
      const approvalHistory = groups.reduce((all, group) => all.concat(group), [])
        .filter(task => {
          if (!keyword) return true;
          const searchable = [
            task.no, task.title, task.summary, task.applicant,
            ...(task.details || []).map(detail => `${detail.label || ''} ${detail.value || ''}`),
            task.raw && (task.raw.product_name || task.raw.productName || task.raw.pn_code || task.raw.pnCode || '')
          ].join(' ').toLowerCase();
          return searchable.includes(keyword);
        });
      approvalHistory.sort((left, right) => right.sortTime - left.sortTime);
      const merged = append ? this.data.productHistory.concat(approvalHistory) : approvalHistory;
      const uniqueHistory = [];
      const seenKeys = {};
      merged.forEach(task => {
        if (!task || seenKeys[task.key]) return;
        seenKeys[task.key] = true;
        uniqueHistory.push(task);
      });
      uniqueHistory.sort((left, right) => right.sortTime - left.sortTime);
      const hasMore = groups.some(group => group && group.length >= pageSize);
      this.setData({ productHistory: uniqueHistory, historyPage: page, historyHasMore: hasMore });
    };
    return Promise.all(loaders.map((loader, index) => loader.run()
      .then(value => {
        settled[index] = { value };
        publish();
        return value;
      })
      .catch(error => {
        console.error(`加载${TYPE_CONFIG[loader.type].label}历史失败:`, error);
        settled[index] = { value: [] };
        publish();
        return [];
      })))
      .finally(() => this.setData({ historyLoading: false, historyLoadingMore: false }));
  },

  loadMoreApprovalHistory() {
    if (this.data.historyLoading || this.data.historyLoadingMore || !this.data.historyHasMore) return;
    return this.loadApprovalHistory({ page: this.data.historyPage + 1, pageSize: APPROVAL_PAGE_SIZE });
  },

  loadReturnTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    return api.inventory.returnList({ status: historyStatusFor('return', history ? this.data.historyStatus : 'pending'), scope: history ? 'review' : '', page, pageSize })
      .then(result => (result.data || []).map(row => {
        const task = taskBase('return', row);
        task.businessId = row.return_id || row.returnId;
        task.key = `return:${task.businessId}`;
        task.no = row.return_no || row.returnNo || task.businessId;
        task.title = row.supplier_name || row.supplierName || '退库申请';
        task.summary = `原入库单 ${row.inbound_no || row.inboundNo || '-'}，共 ${row.total_quantity || row.totalQuantity || 0} 件`;
        task.amountLabel = '退库金额';
        task.amountText = money(row.total_amount || row.totalAmount);
        task.applicant = row.create_user || row.createUser || '';
        task.stageText = history ? historyStageText(row) : task.stageText;
        task.readOnly = history;
        task.details = [
          { label: '原入库单', value: row.inbound_no || row.inboundNo || '-' },
          { label: '供应商', value: row.supplier_name || row.supplierName || '-' },
          { label: '退库原因', value: row.reason || '-' }
        ];
        task.photos = photoList(
          row,
          row.return_photo_urls,
          row.returnPhotoUrls,
          row.proof_photo_url,
          row.proofPhotoUrl,
          row.attachments,
          row.photos,
          row.images
        );
        task.photoLabel = '退库凭证';
        task.items = (row.items || []).map(item => ({
          name: item.product_name || item.productName || item.product_id || '商品',
          meta: [item.pnCode, item.sn_code || item.snCode].filter(Boolean).join(' / '),
          quantity: Number(item.quantity || 0),
          amount: `¥${money(item.unit_price || item.unitPrice)}`
        }));
        return task;
      }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  loadSalesReturnTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    const roles = this.data.roles || [];
    return api.order.returnList({ status: historyStatusFor('salesReturn', history ? this.data.historyStatus : 'pending'), scope: history ? 'review' : '', page, pageSize })
      .then(result => (result.data || []).filter(row => {
        if (history) return true;
        const stage = row.approval_stage || row.approvalStage || 'pending_store';
        if (stage === 'pending_distributor') return hasAnyRole(roles, ['admin']);
        return hasAnyRole(roles, ['admin', 'manager']);
      }).map(row => {
        const task = taskBase('salesReturn', row);
        task.businessId = row.return_id || row.returnId || row.id;
        task.key = `salesReturn:${task.businessId}`;
        task.no = row.return_no || row.returnNo || task.businessId;
        task.title = row.customer_name || row.customerName || '销售退单申请';
        task.summary = `原订单 ${row.order_no || row.orderNo || '-'}，退款 ¥${money(row.refund_amount || row.refundAmount || row.total_amount || row.totalAmount)}`;
        task.amountLabel = '退款金额';
        task.amountText = money(row.refund_amount || row.refundAmount || row.total_amount || row.totalAmount);
        task.applicant = row.create_user || row.createUser || row.applicant_name || '';
        task.stageText = history ? historyStageText(row) : (row.approval_stage === 'pending_distributor' || row.approvalStage === 'pending_distributor'
          ? '待经销商总权限审批'
          : '待店长审批');
        task.readOnly = history;
        task.details = [
          { label: '原订单', value: row.order_no || row.orderNo || '-' },
          { label: '客户', value: row.customer_name || row.customerName || '-' },
          { label: '退单原因', value: row.reason || '-' },
          { label: '审批阶段', value: task.stageText },
          { label: '货物去向', value: '审批通过后生成待入库单' },
          { label: '退款规则', value: row.posted || row.isPosted ? '生成日结负向退款单' : '不生成退款单' }
        ];
        task.photos = photoList(
          row,
          row.return_photo_urls,
          row.returnPhotoUrls,
          row.proof_photo_url,
          row.proofPhotoUrl,
          row.attachments,
          row.photos,
          row.images
        );
        task.photoLabel = '退单凭证';
        task.items = (row.items || row.goods || []).map(item => ({
          name: item.product_name || item.productName || item.name || '商品',
          meta: [item.pnCode, item.sn_code || item.snCode].filter(Boolean).join(' / '),
          quantity: Number(item.quantity || 1),
          amount: `¥${money(item.sale_price || item.salePrice || item.unit_price || item.unitPrice)}`
        }));
        return task;
      }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  loadResourceTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    const staffId = String(user.staffId || user.userId || '');
    return api.inventory.resourceClaimList({ approvalStatus: historyStatusFor('resource', history ? this.data.historyStatus : 'pending_finance'), scope: history ? 'review' : '', page, pageSize })
      .then(result => (result.data || [])
        .filter(row => history || String(row.applicant_staff_id || '') !== staffId)
        .map(row => {
          const task = taskBase('resource', row);
          task.businessId = row.change_id || row.changeId;
          task.key = `resource:${task.businessId}`;
          task.no = row.change_order_no || row.changeOrderNo || task.businessId;
          task.title = `${row.resource_type || '资源'}套回`;
          task.summary = `SN ${row.sn_code || '-'}，套回金额 ¥${money(row.change_amount)}`;
          task.amountLabel = '套回金额';
          task.amountText = money(row.change_amount);
          task.applicant = row.applicant_name || '';
          task.stageText = history ? historyStageText(row) : '待财务审批';
          task.readOnly = history;
          task.details = [
            { label: 'SN', value: row.sn_code || '-' },
            { label: '资源类型', value: row.resource_type || '-' },
            { label: '状态变化', value: `${row.before_status || '-'} → ${row.after_status || '-'}` },
            { label: '申请备注', value: row.remark || '-' },
            { label: '附件', value: row.attachment_url || '无' }
          ];
          task.photos = photoList(
            row,
            row.attachment_url,
            row.attachmentUrl,
            row.attachment_urls,
            row.attachmentUrls,
            row.attachments,
            row.photos,
            row.images
          );
          task.photoLabel = '资源变更附件';
          return task;
        }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  loadProfitTasks(options = {}) {
    const history = Boolean(options.history);
    const { page, pageSize } = taskPageParams(options);
    const user = userUtils.getUserInfo();
    return api.report.profitAdjustments({ scope: 'review', status: history ? this.data.historyStatus : '', page, pageSize })
      .then(result => (result.data || []).map(row => {
        const task = taskBase('profit', row);
        task.businessId = row.adjustment_id || row.adjustmentId;
        task.key = `profit:${task.businessId}`;
        task.no = row.adjustment_no || row.adjustmentNo || task.businessId;
        task.title = `${row.employee_name || '员工'}业绩毛利调整`;
        task.summary = `订单 ${row.order_no || '-'}，${Number(row.signed_amount || 0) >= 0 ? '增加' : '减少'} ¥${money(Math.abs(Number(row.signed_amount || 0)))}`;
        task.amountLabel = '调整金额';
        task.amountText = `${Number(row.signed_amount || 0) >= 0 ? '+' : '-'}${money(Math.abs(Number(row.signed_amount || 0)))}`;
        task.applicant = row.applicant_name || '';
        task.stageText = history ? historyStageText(row) : (row.status === 'pending_admin' ? '待 admin 复审' : '待财务初审');
        task.readOnly = history;
        task.details = [
          { label: '关联订单', value: row.order_no || '-' },
          { label: '业绩员工', value: row.employee_name || '-' },
          { label: '基础毛利', value: `¥${money(row.base_gross_profit)}` },
          { label: '调整原因', value: row.reason || '-' },
          { label: '证明附件', value: (row.attachments || []).map(file => file.original_name).join('、') || '无' },
          { label: '财务意见', value: row.finance_review_comment || '未审核' }
        ];
        task.photos = photoList(
          row,
          row.attachments,
          row.attachment_urls,
          row.attachmentUrls,
          row.proof_photo_url,
          row.proofPhotoUrl,
          row.photos,
          row.images
        );
        task.photoLabel = '毛利调整证明附件';
        return task;
      }))
      .then(tasks => history ? tasks.map(task => markHistoryTask(task, user)).filter(Boolean) : tasks);
  },

  openTask(e) {
    const key = e.currentTarget.dataset.key;
    const sourceTask = this.data.tasks.concat(this.data.productHistory || []).find(task => task.key === key);
    if (!sourceTask) return;
    const selectedTask = Object.assign({}, sourceTask, {
      details: (sourceTask.details || []).slice(),
      items: (sourceTask.items || []).slice(),
      photos: (sourceTask.photos || []).slice(),
      productEdit: sourceTask.productEdit ? Object.assign({}, sourceTask.productEdit, {
        attributes: Object.assign({}, sourceTask.productEdit.attributes || {}),
        attributeRows: (sourceTask.productEdit.attributeRows || []).map(row => Object.assign({}, row)),
        labelPhotoIds: (sourceTask.productEdit.labelPhotoIds || []).slice(),
        labelPhotoUrls: (sourceTask.productEdit.labelPhotoUrls || []).slice()
      }) : null,
      photoIds: [],
      photoUrls: [],
      attachments: [],
      files: [],
      detailLoading: true,
      detailLoaded: false
    });
    this.setData({ selectedTask, reviewComment: '' }, () => {
      if (selectedTask.type === 'product') this.loadProductCategoryOptions(key);
    });
    loadTaskDetails(selectedTask).then(task => {
      if (!this.data.selectedTask || this.data.selectedTask.key !== key) return;
      task.detailLoading = false;
      task.detailLoaded = true;
      this.setData({ selectedTask: task });
    }).catch(error => {
      console.warn('加载审批详情失败:', error);
      if (!this.data.selectedTask || this.data.selectedTask.key !== key) return;
      selectedTask.detailLoading = false;
      selectedTask.detailLoaded = true;
      this.setData({ selectedTask });
    });
  },

  closeTask() {
    if (this.data.submitting) return;
    this.setData({ selectedTask: null, reviewComment: '' });
  },

  loadProductCategoryOptions(taskKey) {
    const applyOptions = options => {
      if (!this.data.selectedTask || this.data.selectedTask.key !== taskKey || !this.data.selectedTask.productEdit) return;
      const categoryId = this.data.selectedTask.productEdit.categoryId;
      const categoryIndex = options.findIndex(item => String(item.categoryId) === String(categoryId));
      this.setData({ productCategoryOptions: options, 'selectedTask.productEdit.categoryIndex': categoryIndex });
    };
    if (this.data.productCategoryOptions.length) {
      applyOptions(this.data.productCategoryOptions);
      return Promise.resolve(this.data.productCategoryOptions);
    }
    return api.product.getCategoryTree().then(result => {
      const options = flattenProductCategories(result);
      applyOptions(options);
      return options;
    }).catch(error => {
      console.warn('load product categories for review failed:', error);
      return [];
    });
  },

  onProductCategoryChange(e) {
    const index = Number(e.detail.value);
    const category = this.data.productCategoryOptions[index];
    if (!category || !this.data.selectedTask || !this.data.selectedTask.productEdit) return;
    this.setData({
      'selectedTask.productEdit.categoryIndex': index,
      'selectedTask.productEdit.categoryId': category.categoryId,
      'selectedTask.productEdit.categoryName': category.name
    });
  },

  onProductEditInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field || !this.data.selectedTask || !this.data.selectedTask.productEdit) return;
    const value = field === 'pnCode' ? normalizePnCode(e.detail.value) : e.detail.value;
    this.setData({ [`selectedTask.productEdit.${field}`]: value });
  },

  onProductAttributeInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const task = this.data.selectedTask;
    if (!task || !task.productEdit || !task.productEdit.attributeRows[index]) return;
    const rows = (task.productEdit.attributeRows || []).map(row => Object.assign({}, row));
    rows[index].value = e.detail.value;
    this.setData({ 'selectedTask.productEdit.attributeRows': rows });
  },

  onProductEditSwitch(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`selectedTask.productEdit.${field}`]: Boolean(e.detail.value) });
  },

  onCommentInput(e) {
    this.setData({ reviewComment: e.detail.value });
  },

  previewTaskPhotos(e) {
    const urls = e.currentTarget.dataset.photos || [];
    if (urls.length) wx.previewImage({ current: e.currentTarget.dataset.current || urls[0], urls });
  },

  onTaskPhotoError(e) {
    const failedUrl = e.currentTarget.dataset.photo || '';
    const task = this.data.selectedTask;
    if (!failedUrl || !task || !task.photoIds || !task.photoIds.length) return;
    imageUpload.resolveImageUrls(task.photoIds).then(photoUrls => {
      const currentUrls = (task.photoUrls || []).slice();
      const index = currentUrls.indexOf(failedUrl);
      if (index < 0 || !photoUrls[index] || photoUrls[index] === failedUrl) return;
      currentUrls[index] = photoUrls[index];
      const uniquePhotoUrls = uniqueValues(currentUrls);
      this.setData({
        'selectedTask.photoUrls': uniquePhotoUrls,
        'selectedTask.photos': uniquePhotoUrls
      });
    }).catch(() => {});
  },

  openTaskFile(e) {
    const url = e.currentTarget.dataset.url || '';
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      wx.showToast({ title: '附件地址暂不可预览', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '打开附件中' });
    wx.downloadFile({
      url,
      success: result => {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          wx.showToast({ title: '附件下载失败', icon: 'none' });
          return;
        }
        wx.openDocument({
          filePath: result.tempFilePath,
          showMenu: true,
          fail: error => wx.showToast({ title: error.errMsg || '附件暂不支持预览', icon: 'none' })
        });
      },
      fail: error => wx.showToast({ title: error.errMsg || '附件下载失败', icon: 'none' }),
      complete: () => wx.hideLoading()
    });
  },

  submitReview(e) {
    if (this.data.submitting || !this.data.selectedTask) return;
    const action = e.currentTarget.dataset.action;
    const comment = String(this.data.reviewComment || '').trim();
    if (action === 'rejected' && !comment) {
      wx.showToast({ title: '拒绝时必须填写审批意见', icon: 'none' });
      return;
    }

    wx.showModal({
      title: action === 'approved' ? '确认审批通过' : '确认拒绝申请',
      content: `${action === 'approved' ? '通过' : '拒绝'} ${this.data.selectedTask.typeLabel}“${this.data.selectedTask.no}”？`,
      confirmText: action === 'approved' ? '通过' : '拒绝',
      confirmColor: action === 'approved' ? '#07c160' : '#d92d20',
      success: result => {
        if (!result.confirm) return;
        this.setData({ submitting: true });
        this.executeReview(this.data.selectedTask, action, comment)
          .then(response => {
            wx.showToast({ title: response && response.message || '审批完成', icon: 'success' });
            this.setData({ selectedTask: null, reviewComment: '' });
            return this.loadApprovals();
          })
          .catch(err => {
            console.error('审批提交失败:', err);
            if (this.data.selectedTask && this.data.selectedTask.type === 'sales' && /无需审批|not.*approval/i.test(String(err && err.message || ''))) {
              this.setData({ selectedTask: null, reviewComment: '' });
              wx.showToast({ title: '该订单已无需审批，待办已刷新', icon: 'none' });
              this.loadApprovals();
              return;
            }
            wx.showToast({ title: err.message || '审批失败', icon: 'none', duration: 2800 });
          })
          .finally(() => this.setData({ submitting: false }));
      }
    });
  },

  executeReview(task, action, comment) {
    if (task.type === 'sales') {
      return action === 'approved'
        ? api.order.approve(task.businessId)
        : api.order.reject(task.businessId, comment);
    }
    if (task.type === 'purchase') {
      return api.purchase.approve(task.businessId, { status: action, comment });
    }
    if (task.type === 'expense') {
      return api.expense.review(task.businessId, { action, comment });
    }
    if (task.type === 'product') {
      const data = { action, comment };
      if (action === 'approved') data.payload = buildProductReviewPayload(task);
      return api.product.reviewApplication(task.businessId, data);
    }
    if (task.type === 'return') {
      return api.inventory.approveReturn({
        returnId: task.businessId,
        storeId: task.raw.store_id || task.raw.storeId || '',
        action,
        comment
      });
    }
    if (task.type === 'salesReturn') {
      const user = userUtils.getUserInfo();
      return api.order.reviewReturn(task.businessId, {
        action,
        comment,
        postToDailyStatement: action === 'approved',
        post_to_daily_statement: action === 'approved',
        createNegativeDailyStatement: action === 'approved',
        create_negative_daily_statement: action === 'approved',
        reviewerRole: user.userRole || user.role || '',
        reviewerId: user.staffId || user.userId || ''
      });
    }
    if (task.type === 'resource') {
      return api.inventory.reviewResourceClaim(task.businessId, {
        action: action === 'approved' ? 'approve' : 'reject',
        comment
      });
    }
    if (task.type === 'profit') {
      return api.report.reviewProfitAdjustment(task.businessId, action, comment);
    }
    return Promise.reject(new Error('不支持的审批类型'));
  }
});
