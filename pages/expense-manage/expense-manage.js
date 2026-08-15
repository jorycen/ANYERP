const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');

function listOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  return [];
}

function today() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isTruthy(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'y'].includes(String(value || '').toLowerCase());
}

function emptyForm() {
  return {
    storeIndex: -1,
    storeId: '',
    storeName: '',
    regionName: '',
    expenseTypeIndex: -1,
    expenseTypeId: '',
    expenseType: '',
    expenseParty: '',
    amount: '',
    paymentMethodIndex: 0,
    paymentMethod: 'CORPORATE',
    hasInvoice: false,
    invoiceType: '',
    invoiceNo: '',
    expenseDate: today(),
    remark: ''
  };
}

Page({
  data: {
    stores: [],
    expenseTypes: [],
    paymentMethods: [
      { label: '财务对公', value: 'CORPORATE' },
      { label: '私人垫付', value: 'PERSONAL_ADVANCE' }
    ],
    form: emptyForm(),
    records: [],
    submitting: false,
    loading: false,
    revokingRecordKey: ''
  },

  onLoad() {
    if (userUtils.isPurchaseQueryOnly()) {
      wx.reLaunch({ url: '/pages/purchase-application/purchase-application' });
      return;
    }
    Promise.all([this.loadStores(), this.loadExpenseTypes(), this.loadRecords()]);
  },

  onPullDownRefresh() {
    Promise.all([this.loadExpenseTypes(), this.loadRecords()])
      .finally(() => wx.stopPullDownRefresh());
  },

  loadStores() {
    const user = userUtils.getUserInfo();
    return api.store.getStores(user.distributorId || '').then(result => {
      const stores = result.data || [];
      const index = stores.findIndex(store => String(store.storeId) === String(user.storeId || ''));
      const selectedIndex = index >= 0 ? index : (stores.length === 1 ? 0 : -1);
      const selected = stores[selectedIndex] || {};
      this.setData({
        stores,
        'form.storeIndex': selectedIndex,
        'form.storeId': selected.storeId || '',
        'form.storeName': selected.name || '',
        'form.regionName': selected.regionName || ''
      });
    });
  },

  loadExpenseTypes() {
    return api.expense.types(true).then(result => {
      this.setData({ expenseTypes: listOf(result) });
    }).catch(err => {
      wx.showToast({ title: err.message || '报销类型加载失败', icon: 'none' });
    });
  },

  loadRecords() {
    this.setData({ loading: true });
    return api.expense.list({ scope: 'my', page: 1, pageSize: 100 }).then(result => {
      const statusMap = {
        pending_approval: '待领导审批',
        approved: '结算单草稿',
        rejected: '已拒绝',
        pending_payment: '应付待结算',
        paid: '已付款',
        cancelled: '已取消'
      };
      const stageMap = {
        pending_approval: '领导审批',
        approved: '待结算',
        pending_payment: '财务付款',
        paid: '已完成',
        rejected: '已结束',
        cancelled: '已结束'
      };
      const paymentMap = { CORPORATE: '财务对公', PERSONAL_ADVANCE: '私人垫付' };
      const records = listOf(result).map(item => ({
        ...item,
        recordKey: `expense:${item.expense_id || item.expenseId || ''}`,
        statusText: statusMap[item.status] || item.status || '-',
        canRevoke: item.can_revoke !== undefined ? isTruthy(item.can_revoke) : ['pending_approval', 'approved', 'pending_payment'].includes(item.status),
        currentStage: item.current_stage_name || item.currentStageName || item.current_stage || item.currentStage || item.stage_text || item.stageText || stageMap[item.status] || '-',
        paymentMethodText: paymentMap[item.payment_method] || item.payment_method || '-',
        amountText: Number(item.amount || 0).toFixed(2),
        createTimeText: String(item.create_time || '').replace('T', ' ').slice(0, 16)
      }));
      this.setData({ records, loading: false });
    }).catch(err => {
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '费用记录加载失败', icon: 'none' });
    });
  },

  revokeRecord(e) {
    const recordKey = e.currentTarget.dataset.key;
    const record = this.data.records.find(item => item.recordKey === recordKey);
    if (!record || !record.canRevoke || this.data.revokingRecordKey) return;
    wx.showModal({
      title: '确认撤销报销',
      content: '确认撤销这条报销申请？撤销后将停止后续审批、结算或付款处理。',
      confirmText: '确认撤销',
      confirmColor: '#d93025',
      success: result => {
        if (!result.confirm) return;
        const expenseId = record.expense_id || record.expenseId;
        this.setData({ revokingRecordKey: record.recordKey });
        wx.showLoading({ title: '撤销处理中' });
        api.expense.revoke(expenseId, { reason: '申请人撤销', source: 'mini_program', cascade: true })
          .then(response => {
            wx.showToast({ title: response?.message || '报销已撤销', icon: 'success' });
            return this.loadRecords();
          })
          .catch(err => wx.showToast({ title: Number(err.statusCode) === 404 ? '后台暂未部署报销撤销接口' : (err.message || '撤销失败'), icon: 'none' }))
          .finally(() => {
            wx.hideLoading();
            this.setData({ revokingRecordKey: '' });
          });
      }
    });
  },

  openRecordDetail(e) {
    const recordKey = e.currentTarget.dataset.key;
    const record = this.data.records.find(item => item.recordKey === recordKey);
    if (!record || !(record.expense_id || record.expenseId)) return;
    wx.navigateTo({
      url: `/pages/application-detail/application-detail?type=expense&id=${encodeURIComponent(record.expense_id || record.expenseId)}`
    });
  },

  onStoreChange(e) {
    const index = Number(e.detail.value);
    const store = this.data.stores[index] || {};
    this.setData({
      'form.storeIndex': index,
      'form.storeId': store.storeId || '',
      'form.storeName': store.name || '',
      'form.regionName': store.regionName || ''
    });
  },

  onExpenseTypeChange(e) {
    const index = Number(e.detail.value);
    const type = this.data.expenseTypes[index] || {};
    this.setData({
      'form.expenseTypeIndex': index,
      'form.expenseTypeId': type.type_id || type.typeId || '',
      'form.expenseType': type.name || ''
    });
  },

  onPaymentMethodChange(e) {
    const index = Number(e.detail.value);
    const method = this.data.paymentMethods[index] || {};
    this.setData({
      'form.paymentMethodIndex': index,
      'form.paymentMethod': method.value || ''
    });
  },

  onDateChange(e) {
    this.setData({ 'form.expenseDate': e.detail.value });
  },

  onInvoiceChange(e) {
    const hasInvoice = Boolean(e.detail.value);
    const updates = { 'form.hasInvoice': hasInvoice };
    if (!hasInvoice) {
      updates['form.invoiceType'] = '';
      updates['form.invoiceNo'] = '';
    }
    this.setData(updates);
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  submit() {
    const form = this.data.form;
    if (this.data.submitting) return;
    if (!form.storeId) return wx.showToast({ title: '请选择门店', icon: 'none' });
    if (!form.expenseTypeId) return wx.showToast({ title: '请选择报销类型', icon: 'none' });
    if (!String(form.expenseParty || '').trim()) return wx.showToast({ title: '请填写费用发生方', icon: 'none' });
    if (!Number.isFinite(Number(form.amount)) || Number(form.amount) <= 0) {
      return wx.showToast({ title: '请输入正确的费用金额', icon: 'none' });
    }

    this.setData({ submitting: true });
    api.expense.create({
      storeId: form.storeId,
      expenseTypeId: form.expenseTypeId,
      expenseParty: String(form.expenseParty).trim(),
      amount: Number(form.amount),
      paymentMethod: form.paymentMethod,
      hasInvoice: form.hasInvoice,
      invoiceType: form.invoiceType,
      invoiceNo: form.invoiceNo,
      expenseDate: form.expenseDate,
      remark: form.remark,
      attachmentUrls: []
    }).then(result => {
      wx.showToast({ title: result.message || '提交成功', icon: 'success' });
      const store = this.data.stores[form.storeIndex] || {};
      const nextForm = emptyForm();
      nextForm.storeIndex = form.storeIndex;
      nextForm.storeId = store.storeId || '';
      nextForm.storeName = store.name || '';
      nextForm.regionName = store.regionName || '';
      this.setData({ form: nextForm });
      return this.loadRecords();
    }).catch(err => {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' });
    }).finally(() => this.setData({ submitting: false }));
  }
});
