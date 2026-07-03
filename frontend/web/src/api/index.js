import axios from 'axios'
import router from '../router'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options'])
const MAX_RETRY_COUNT = 2
const RETRY_BASE_DELAY = 1000

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000
})

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableError(error) {
  const method = (error.config?.method || 'get').toLowerCase()
  if (!IDEMPOTENT_METHODS.has(method)) {
    return false
  }
  if (error.code === 'ERR_CANCELED') {
    return false
  }
  if (!error.response) {
    return true
  }
  return RETRYABLE_STATUS_CODES.has(error.response.status)
}

function attachResponseInterceptor(client, onSuccess, onUnauthorized) {
  client.interceptors.response.use(
    onSuccess,
    async error => {
      if (error.response?.status === 401) {
        onUnauthorized()
        return Promise.reject(error)
      }

      const config = error.config || {}
      config.__retryCount = config.__retryCount || 0

      if (config.__retryCount < MAX_RETRY_COUNT && isRetryableError(error)) {
        config.__retryCount += 1
        await sleep(RETRY_BASE_DELAY * 2 ** (config.__retryCount - 1))
        return client.request(config)
      }

      return Promise.reject(error)
    }
  )
}

// Request interceptor
api.interceptors.request.use(
  config => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

attachResponseInterceptor(
  api,
  response => {
    const payload = response.data
    if (payload?.data?.pagination && payload.data.total === undefined) {
      payload.data.total = payload.data.pagination.total || 0
    }
    return payload
  },
  () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userInfo')
    router.push('/login')
  }
)

// 专门用于导出的axios实例（绕过响应拦截器）
const exportApi = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000
})

exportApi.interceptors.request.use(
  config => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

attachResponseInterceptor(
  exportApi,
  response => response,
  () => {
    localStorage.removeItem('token')
    localStorage.removeItem('userInfo')
    router.push('/login')
  }
)

export default {
  // Auth
  login: (data) => api.post('/auth/login', data),
  getUserInfo: () => api.get('/auth/userinfo'),
  changePassword: (data) => api.post('/auth/changepassword', data),

  // Sales
  getSalesList: (params) => api.get('/sales/list', { params }),
  createSales: (data) => api.post('/sales/create', data),
  getSalesDetail: (id) => api.get(`/sales/${id}`),
  updateSales: (id, data) => api.put(`/sales/${id}`, data),
  approveOrder: (id) => api.post(`/sales/${id}/approve`),
  rejectOrder: (id, data) => api.post(`/sales/${id}/reject`, data),
  recalculateSalesSettlementCost: (id) => api.post(`/sales/${id}/recalculate-settlement-cost`),
  getPaymentMethods: () => api.get('/sales/payment-methods'),
  getDepositList: (params) => api.get('/sales/deposits', { params }),
  createDeposit: (data) => api.post('/sales/deposits', data),
  archiveDeposit: (id) => api.post(`/sales/deposits/${id}/archive`),
  refundDeposit: (id, data) => api.post(`/sales/deposits/${id}/refund`, data),
  getAvailableDeposits: (params) => api.get('/sales/deposits/available', { params }),
  getProductPns: (storeId, productId) => api.get(`/sales/product-pns/${storeId}/${productId}`),
  getProductSns: (storeId, productId, pnCode) => api.get(`/sales/product-sns/${storeId}/${productId}`, { params: { pnCode } }),

  // Inventory
  getInventoryList: (params) => api.get('/inventory/list', { params }),
  getSnList: (params) => api.get('/inventory/sn-list', { params }),
  updateSn: (snId, data) => api.put(`/inventory/sn/${snId}`, data),
  snTrace: (snCode, params) => api.get(`/inventory/sn-trace/${encodeURIComponent(snCode)}`, { params }),
  getResourceRights: (params) => api.get('/inventory/resource-rights', { params }),
  getSnResourceRights: (snId) => api.get(`/inventory/sn/${snId}/resource-rights`),
  saveSnResourceRights: (snId, data) => api.put(`/inventory/sn/${snId}/resource-rights`, data),
  getResourceRightChanges: (params) => api.get('/inventory/resource-rights/changes', { params }),
  submitResourceClaim: (data) => api.post('/inventory/resource-rights/claim', data),
  reviewResourceClaim: (id, data) => api.post(`/inventory/resource-rights/claim/${id}/review`, data),
  getProductResourceCostConfigs: (params) => api.get('/inventory/resource-rights/cost-configs', { params }),
  getResourceCostAdjustments: (params) => api.get('/inventory/resource-rights/cost-adjustments', { params }),
  saveProductResourceCostConfig: (data) => api.post('/inventory/resource-rights/cost-configs', data),
  batchAdjustResourceRights: (data) => api.post('/inventory/resource-rights/batch-adjust', data),
  batchRefreshResourceRights: (data) => api.post('/inventory/resource-rights/batch-refresh', data),
  getResourceCategories: (params) => api.get('/inventory/resource-categories', { params }),
  saveResourceCategory: (data) => api.post('/inventory/resource-categories', data),
  deleteResourceCategory: (categoryId) => api.delete(`/inventory/resource-categories/${categoryId}`),
  getGoodsTypes: (params) => api.get('/inventory/goods-types', { params }),
  saveGoodsType: (data) => api.post('/inventory/goods-types', data),
  deleteGoodsType: (goodsTypeId) => api.delete(`/inventory/goods-types/${goodsTypeId}`),
  getResourceSettlements: (params) => api.get('/inventory/resource-settlements', { params }),
  settleResource: (settlementId, data = {}) => api.post(`/inventory/resource-settlements/${settlementId}/settle`, data),
  getInboundList: (params) => api.get('/inventory/inbound-list', { params }),
  getInboundDetail: (inboundId) => api.get(`/inventory/inbound-detail/${inboundId}`),
  executeInbound: (data) => api.post('/inventory/execute-inbound', data),
  getReturnList: (params) => api.get('/inventory/return-list', { params }),
  requestReturn: (data) => api.post('/inventory/request-return', data),
  approveReturn: (data) => api.post('/inventory/approve-return', data),
  executeReturn: (data) => api.post('/inventory/execute-return', data),
  getLocationsByStore: (storeId) => api.get(`/inventory/locations/${storeId}`),
  inbound: (data) => api.post('/inventory/inbound', data),
  outbound: (data) => api.post('/inventory/outbound', data),
  transfer: (data) => api.post('/inventory/transfer', data),
  getTransferList: (params) => api.get('/inventory/transfer-list', { params }),
  confirmTransferOut: (data) => api.post('/inventory/transfer/confirm-out', data),
  confirmTransferIn: (data) => api.post('/inventory/transfer/confirm-in', data),
  getConversionList: (params) => api.get('/inventory/conversion-list', { params }),
  getConversionDetail: (id) => api.get(`/inventory/conversion/${id}`),
  createConversion: (data) => api.post('/inventory/conversion', data),
  voidConversion: (id, data) => api.post(`/inventory/conversion/${id}/void`, data),

  // Purchase
  getPurchaseRequestList: (params) => api.get('/purchase/request-list', { params }),
  getPurchaseRequestDetail: (id) => api.get(`/purchase/request-detail/${id}`),
  createPurchaseRequest: (data) => api.post('/purchase/create-request', data),
  approvePurchaseRequest: (id, data) => api.post(`/purchase/approve-request/${id}`, data),
  revokePurchaseRequest: (id, data) => api.post(`/purchase/revoke-request/${id}`, data),
  getSupplierList: (params) => api.get('/purchase/supplier-list', { params }),
  getAllSuppliers: () => api.get('/purchase/supplier-all'),
  createSupplier: (data) => api.post('/purchase/supplier', data),
  updateSupplier: (id, data) => api.put(`/purchase/supplier/${id}`, data),
  deleteSupplier: (id) => api.delete(`/purchase/supplier/${id}`),
  sortSuppliers: (data) => api.post('/purchase/supplier/sort', data),

  // Finance
  getDailyDetails: (params) => api.get('/finance/daily-details', { params }),
  getNationalSubsidyReceivables: (params) => api.get('/finance/national-subsidy-receivables', { params }),
  getDailyStatement: (params) => api.get('/finance/daily-statement', { params }),
  getDailyStatementDetail: (id) => api.get(`/finance/daily-statement/${id}`),
  getSettlementSummary: (params) => api.get('/finance/settlement-summary', { params }),
  batchSettle: (data) => api.post('/finance/batch-settle', data),
  settleNationalSubsidyReceivables: (data) => api.post('/finance/national-subsidy-receivables/settle', data),
  createExpense: (data) => api.post('/finance/expense', data),
  getExpenseList: (params) => api.get('/finance/expense-list', { params }),
  submitExpense: (id) => api.put(`/finance/expense/submit/${id}`),
  payExpense: (id, data) => api.put(`/finance/expense/pay/${id}`, data),
  getPayableList: (params) => api.get('/finance/payable-list', { params }),
  getUnpaidBySupplier: (params) => api.get('/finance/unpaid-by-supplier', { params }),
  createSettlement: (data) => api.post('/finance/create-settlement', data),
  getSettlementList: (params) => api.get('/finance/settlement-list', { params }),
  getSettlementDetail: (id) => api.get(`/finance/settlement/${id}`),
  submitSettlement: (data) => api.post('/finance/settlement/submit', data),
  confirmSettlement: (data) => api.post('/finance/settlement/confirm', data),
  voidSettlement: (data) => api.post('/finance/settlement/void', data),
  getSettlementPaymentCandidates: (params) => api.get('/finance/settlement-payment/candidates', { params }),
  exportSettlementPayments: (params) => exportApi.get('/finance/settlement-payment/export', {
    params,
    responseType: 'blob'
  }).then(response => {
    const url = window.URL.createObjectURL(new Blob([response.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }))
    const link = document.createElement('a')
    link.href = url
    let fileName = `应付实际付款_${new Date().toISOString().slice(0, 10)}.xlsx`
    const contentDisposition = response.headers['content-disposition']
    if (contentDisposition) {
      const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
      const fileNameMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
      if (encodedMatch && encodedMatch[1]) {
        fileName = decodeURIComponent(encodedMatch[1])
      } else if (fileNameMatch && fileNameMatch[1]) {
        fileName = fileNameMatch[1].replace(/['"]/g, '')
      }
    }
    link.setAttribute('download', fileName)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }),
  validateSettlementPaymentImport: (data) => api.post('/finance/settlement-payment/import/validate', data),
  commitSettlementPaymentImport: (data) => api.post('/finance/settlement-payment/import/commit', data),
  createDirectSettlementPayment: (data) => api.post('/finance/settlement-payment/direct', data),
  getSettlementPaymentBatches: (params) => api.get('/finance/settlement-payment/batches', { params }),
  getSettlementPaymentBatchDetail: (id) => api.get(`/finance/settlement-payment/batch/${id}`),
  voidSettlementPaymentBatch: (data) => api.post('/finance/settlement-payment/batch/void', data),
  confirmPayment: (data) => api.post('/finance/confirm-payment', data),
  cancelPayment: (data) => api.post('/finance/cancel-payment', data),
  getSettlementAccountsBalance: (params) => api.get('/finance/settlement-accounts/balance', { params }),
  getAccountTransactions: (accountId, params) => api.get(`/finance/settlement-account/${accountId}/transactions`, { params }),
  addAccountTransaction: (data) => api.post('/finance/settlement-account/transaction', data),
  addRebate: (data) => api.post('/finance/add-rebate', data),
  getRebateList: (params) => api.get('/finance/rebate-list', { params }),
  getRebateBalance: (params) => api.get('/finance/rebate-balance', { params }),
  getRebateSummary: () => api.get('/finance/rebate-summary'),
  reverseRebate: (id, data) => api.post(`/finance/rebate/${id}/reverse`, data),
  createManufacturerPolicy: (data) => api.post('/finance/manufacturer-policy', data),
  updateManufacturerPolicy: (id, data) => api.put(`/finance/manufacturer-policy/${id}`, data),
  getManufacturerPolicyList: (params) => api.get('/finance/manufacturer-policy-list', { params }),
  importManufacturerPrices: (data) => api.post('/finance/manufacturer-price/import', data),
  getManufacturerPriceHistory: (params) => api.get('/finance/manufacturer-price-history', { params }),
  getRebateEstimateList: (params) => api.get('/finance/rebate-estimate-list', { params }),
  getSalesCostAdjustmentList: (params) => api.get('/finance/sales-cost-adjustment-list', { params }),

  // Product
  getProductList: (params) => api.get('/product/list', { params }),
  searchProduct: (params) => api.get('/product/search', { params }),
  createProduct: (data) => api.post('/product/application', data),
  getProductApplicationList: (params) => api.get('/product/application-list', { params }),
  reviewProductApplication: (id, data) => api.post(`/product/application/${id}/review`, data),
  updateProduct: (id, data) => api.put(`/product/update/${id}`, data),
  deleteProduct: (id) => api.delete(`/product/delete/${id}`),
  togglePause: (id) => api.post(`/product/toggle-pause/${id}`),
  importProducts: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/product/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  exportProducts: (params) => {
    return exportApi.get('/product/export', { 
      params, 
      responseType: 'blob' 
    }).then(response => {
      // 创建下载链接
      const url = window.URL.createObjectURL(new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }));
      const link = document.createElement('a');
      link.href = url;
      // 从响应头中获取文件名
      let fileName = `商品导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const contentDisposition = response.headers['content-disposition'];
      if (contentDisposition) {
        const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        const fileNameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
        if (encodedMatch && encodedMatch[1]) {
          fileName = decodeURIComponent(encodedMatch[1]);
        } else if (fileNameMatch && fileNameMatch[1]) {
          fileName = fileNameMatch[1].replace(/['"]/g, '');
        }
      }
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    });
  },
  getPnList: (params) => api.get('/product/pn-list', { params }),
  addPn: (data) => api.post('/product/pn', data),
  // 商品条码
  getBarcodes: (params) => api.get('/product/barcode', { params }),
  addBarcode: (data) => api.post('/product/barcode', data),
  deleteBarcode: (id) => api.delete(`/product/barcode/${id}`),
  // 商品分类
  getCategoryTree: () => api.get('/product/category/tree'),
  createCategory: (data) => api.post('/product/category', data),
  updateCategory: (id, data) => api.put(`/product/category/${id}`, data),
  deleteCategory: (id) => api.delete(`/product/category/${id}`),
  sortCategories: (data) => api.post('/product/category/sort', data),
  // 分类字段配置
  getCategoryFields: (categoryId) => api.get('/product/category/fields', { params: { categoryId } }),
  saveCategoryFields: (data) => api.post('/product/category/fields', data),
  getCategoryFieldConfig: (categoryId) => api.get('/product/category/field-config', { params: { categoryId } }),
  // 商品价格
  getPriceList: (params) => api.get('/product/price/list', { params }),
  setPrice: (data) => api.post('/product/price/set', data),
  refreshCostPrice: (productId) => api.post(`/product/price/refresh-cost/${productId}`),
  batchRefreshCost: (data) => api.post('/product/price/batch-refresh-cost', data),
  getPriceChangeHistory: (params) => api.get('/product/price/history', { params }),
  validateImportPrices: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/product/price/import/validate', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  importPrices: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/product/price/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },
  importCostRefresh: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/product/price/import-cost-refresh', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  },

  // Store
  getStoreList: (params) => api.get('/store/list', { params }),
  getAllStores: () => api.get('/store/all'),
  createStore: (data) => api.post('/store/create', data),
  updateStore: (id, data) => api.put(`/store/update/${id}`, data),
  deleteStore: (id) => api.delete(`/store/delete/${id}`),
  getRegionList: () => api.get('/store/regions'),

  // Report
  getSalesReport: (params) => api.get('/report/sales', { params }),
  getInventoryReport: (params) => api.get('/report/inventory', { params }),
  getEmployeePerformanceReport: (params) => api.get('/report/employee-performance', { params }),
  getProfitAdjustments: (params) => api.get('/report/profit-adjustments', { params }),
  createProfitAdjustment: (data) => api.post('/report/profit-adjustments', data, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }),
  approveProfitAdjustment: (adjustmentId, data) => api.post(`/report/profit-adjustments/${adjustmentId}/approve`, data),
  rejectProfitAdjustment: (adjustmentId, data) => api.post(`/report/profit-adjustments/${adjustmentId}/reject`, data),
  downloadProfitAdjustmentAttachment: (attachmentId) => exportApi.get(`/report/profit-adjustment-attachments/${attachmentId}/download`, {
    responseType: 'blob'
  }),

  // System
  getMenus: () => api.get('/system/menus'),
  getRoles: () => api.get('/system/roles'),
  createRole: (data) => api.post('/system/role', data),
  updateRole: (roleId, data) => api.put(`/system/role/${roleId}`, data),
  deleteRole: (roleId) => api.delete(`/system/role/${roleId}`),
  getRoleMenus: (roleId) => api.get(`/system/role-menus/${roleId}`),
  assignMenus: (roleId, data) => api.post(`/system/role-menus/${roleId}`, data),
  getUsers: (params) => api.get('/system/users', { params }),
  createUser: (data) => api.post('/system/user', data),
  updateUser: (staffId, data) => api.put(`/system/user/${staffId}`, data),
  resetUserPassword: (staffId) => api.post(`/system/user/${staffId}/reset-password`),
  getUserRegions: (userId) => api.get(`/system/user-regions/${userId}`),
  assignUserRegions: (userId, data) => api.post(`/system/assign-user-regions/${userId}`, data),

  // Dict - Customer Source
  getCustomerSourceList: (params) => api.get('/dict/customer-source/list', { params }),
  getAllCustomerSources: () => api.get('/dict/customer-source/all'),
  getCustomerSourceTree: () => api.get('/dict/customer-source/tree'),
  createCustomerSource: (data) => api.post('/dict/customer-source/create', data),
  updateCustomerSource: (id, data) => api.put(`/dict/customer-source/update/${id}`, data),
  deleteCustomerSource: (id) => api.delete(`/dict/customer-source/delete/${id}`),
  sortCustomerSources: (data) => api.post('/dict/customer-source/sort', data),

  // Dict - Payment Method
  getPaymentMethodList: (params) => api.get('/dict/payment-method/list', { params }),
  getAllPaymentMethods: (params) => api.get('/dict/payment-method/all', { params }),
  getPaymentMethodsByStore: (storeId) => api.get('/dict/payment-method/by-store', { params: { storeId } }),
  createPaymentMethod: (data) => api.post('/dict/payment-method/create', data),
  updatePaymentMethod: (id, data) => api.put(`/dict/payment-method/update/${id}`, data),
  deletePaymentMethod: (id) => api.delete(`/dict/payment-method/delete/${id}`),
  sortPaymentMethods: (data) => api.post('/dict/payment-method/sort', data),

  // Dict - Settlement Account
  getSettlementAccountList: (params) => api.get('/dict/settlement-account/list', { params }),
  getAllSettlementAccounts: () => api.get('/dict/settlement-account/all'),
  createSettlementAccount: (data) => api.post('/dict/settlement-account/create', data),
  updateSettlementAccount: (id, data) => api.put(`/dict/settlement-account/update/${id}`, data),
  deleteSettlementAccount: (id) => api.delete(`/dict/settlement-account/delete/${id}`),
  sortSettlementAccounts: (data) => api.post('/dict/settlement-account/sort', data),

  // Dict - Supplement Item
  getSupplementItemList: (params) => api.get('/dict/supplement-item/list', { params }),
  getAllSupplementItems: () => api.get('/dict/supplement-item/all'),
  createSupplementItem: (data) => api.post('/dict/supplement-item/create', data),
  updateSupplementItem: (id, data) => api.put(`/dict/supplement-item/update/${id}`, data),
  deleteSupplementItem: (id) => api.delete(`/dict/supplement-item/delete/${id}`),
  sortSupplementItems: (data) => api.post('/dict/supplement-item/sort', data)
}
