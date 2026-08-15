const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');
require('../../utils/cloud-adapter.js').install();

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusText(status) {
  return {
    submitted: '已提交',
    available: '可使用',
    archived: '已归档',
    occupied: '已占用',
    reserved: '已占用',
    redeemed: '已核销',
    refunded: '已退款',
    voided: '已作废'
  }[status] || status || '-';
}

function getErrorMessage(err, fallback) {
  if (err && err.code === 'DEPOSIT_API_NOT_DEPLOYED') {
    return '定金服务未部署，请重新部署后端';
  }
  return (err && err.message) || fallback;
}

Page({
  data: {
    form: {
      customerName: '',
      customerPhone: '',
      amount: '',
      paymentMethod: '',
      remark: ''
    },
    paymentMethods: [],
    paymentMethodOptions: [],
    paymentMethodIndex: -1,
    query: {
      status: '',
      customerPhone: ''
    },
    statusOptions: ['全部', '可使用', '已占用', '已提交（历史）', '已核销', '已退款'],
    statusValues: ['', 'available', 'occupied', 'submitted', 'redeemed', 'refunded'],
    statusIndex: 0,
    deposits: [],
    loading: false,
    submitting: false
  },

  onLoad() {
    this.loadPaymentMethods();
  },

  onShow() {
    if (!this.data.paymentMethodOptions.length) this.loadPaymentMethods();
    this.loadDeposits();
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    let value = e.detail.value;
    if (field === 'amount') {
      value = String(value || '').replace(/[^0-9.]/g, '');
      const firstDotIndex = value.indexOf('.');
      if (firstDotIndex >= 0) {
        value = value.substring(0, firstDotIndex + 1) + value.substring(firstDotIndex + 1).replace(/\./g, '').substring(0, 2);
      }
    }
    this.setData({ [`form.${field}`]: value });
  },

  onStatusChange(e) {
    const index = Number(e.detail.value || 0);
    this.setData({
      statusIndex: index,
      'query.status': this.data.statusValues[index] || ''
    });
    this.loadDeposits();
  },

  onQueryPhoneInput(e) {
    this.setData({ 'query.customerPhone': e.detail.value });
  },

  getStoreId() {
    const userInfo = userUtils.getUserInfo();
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    if (!userUtils.isStoreScoped(userInfo)) return '';
    return tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || userInfo.storeId || '';
  },

  loadPaymentMethods() {
    api.dict.getPaymentMethods(this.getStoreId()).then(methods => {
      const paymentMethods = (methods || []).filter(method => {
        const name = String(method.name || '');
        return name &&
          name !== '定金' &&
          name !== '定金抵扣' &&
          name !== 'deposit' &&
          name.indexOf('政策补贴应收') < 0 &&
          name.indexOf('客户实收') < 0;
      });
      const currentIndex = paymentMethods.findIndex(method => method.name === this.data.form.paymentMethod);
      this.setData({
        paymentMethods,
        paymentMethodOptions: paymentMethods.map(method => method.name),
        paymentMethodIndex: currentIndex
      });
    }).catch(err => {
      console.error('加载定金收款方式失败:', err);
      wx.showToast({ title: '收款方式加载失败', icon: 'none' });
    });
  },

  onPaymentMethodChange(e) {
    const index = Number(e.detail.value);
    const method = this.data.paymentMethods[index] || {};
    this.setData({
      paymentMethodIndex: index,
      'form.paymentMethod': method.name || ''
    });
  },

  loadDeposits() {
    this.setData({ loading: true });
    api.deposit.list({
      status: this.data.query.status,
      customerPhone: this.data.query.customerPhone,
      storeId: this.getStoreId(),
      page: 1,
      pageSize: 50
    }).then(res => {
      const deposits = (res.data || []).map(item => ({
        ...item,
        amountText: Number(item.amount || 0).toFixed(2),
        statusText: statusText(item.status),
        createTimeText: formatDate(item.createTime)
      }));
      this.setData({ deposits, loading: false });
    }).catch(err => {
      console.error('加载定金单失败:', err);
      this.setData({ loading: false, deposits: [] });
      wx.showToast({ title: getErrorMessage(err, '加载失败'), icon: 'none' });
    });
  },

  submitDeposit() {
    if (this._depositSubmissionLocked || this.data.submitting) return;
    const form = this.data.form;
    const amount = Number(form.amount || 0);
    if (!form.customerName) {
      wx.showToast({ title: '请填写会员称呼', icon: 'none' });
      return;
    }
    if (!form.customerPhone) {
      wx.showToast({ title: '请填写会员ID', icon: 'none' });
      return;
    }
    if (amount <= 0) {
      wx.showToast({ title: '定金金额必须大于0', icon: 'none' });
      return;
    }
    if (!form.paymentMethod) {
      wx.showToast({ title: '请选择收款方式', icon: 'none' });
      return;
    }
    this._depositSubmissionLocked = true;
    this.setData({ submitting: true });
    api.deposit.create({
      storeId: this.getStoreId(),
      customerName: form.customerName,
      customerPhone: form.customerPhone,
      amount,
      paymentMethod: form.paymentMethod,
      remark: form.remark
    }).then(() => {
      this.setData({
        submitting: false,
        form: { customerName: '', customerPhone: '', amount: '', paymentMethod: '', remark: '' },
        paymentMethodIndex: -1
      });
      this._depositSubmissionLocked = false;
      wx.showToast({ title: '已存入客户定金库', icon: 'success' });
      this.loadDeposits();
    }).catch(err => {
      console.error('提交定金单失败:', err);
      this._depositSubmissionLocked = false;
      this.setData({ submitting: false });
      wx.showToast({ title: getErrorMessage(err, '提交失败'), icon: 'none' });
    });
  },

  refundDeposit(e) {
    const depositId = e.currentTarget.dataset.id;
    const amount = Number(e.currentTarget.dataset.amount || 0);
    wx.showModal({
      title: '退款登记',
      content: '当前只记录退款事实，不处理收付款。确认记录全额退款？',
      success: res => {
        if (!res.confirm) return;
        api.deposit.refund(depositId, { amount, reason: '小程序记录退款' }).then(() => {
          wx.showToast({ title: '已记录退款', icon: 'success' });
          this.loadDeposits();
        }).catch(err => {
          wx.showToast({ title: getErrorMessage(err, '退款失败'), icon: 'none' });
        });
      }
    });
  }
});
