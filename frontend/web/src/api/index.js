import axios from 'axios'
import router from '../router'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000
})

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

// Response interceptor
api.interceptors.response.use(
  response => {
    const payload = response.data
    if (payload?.data?.pagination && payload.data.total === undefined) {
      payload.data.total = payload.data.pagination.total || 0
    }
    return payload
  },
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('userInfo')
      router.push('/login')
    }
    return Promise.reject(error)
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
  getPaymentMethods: () => api.get('/sales/payment-methods'),
  getProductPns: (storeId, productId) => api.get(`/sales/product-pns/${storeId}/${productId}`),
  getProductSns: (storeId, productId, pnCode) => api.get(`/sales/product-sns/${storeId}/${productId}`, { params: { pnCode } }),

  // Inventory
  getInventoryList: (params) => api.get('/inventory/list', { params }),
  getSnList: (params) => api.get('/inventory/sn-list', { params }),
  updateSn: (snId, data) => api.put(`/inventory/sn/${snId}`, data),
  snTrace: (snCode) => api.get(`/inventory/sn-trace/${encodeURIComponent(snCode)}`),
  getInboundList: (params) => api.get('/inventory/inbound-list', { params }),
  getInboundDetail: (inboundId) => api.get(`/inventory/inbound-detail/${inboundId}`),
  executeInbound: (data) => api.post('/inventory/execute-inbound', data),
  executeReturn: (data) => api.post('/inventory/execute-return', data),
  getLocationsByStore: (storeId) => api.get(`/inventory/locations/${storeId}`),
  inbound: (data) => api.post('/inventory/inbound', data),
  outbound: (data) => api.post('/inventory/outbound', data),
  transfer: (data) => api.post('/inventory/transfer', data),
  getTransferList: (params) => api.get('/inventory/transfer-list', { params }),
  confirmTransferOut: (data) => api.post('/inventory/transfer/confirm-out', data),
  confirmTransferIn: (data) => api.post('/inventory/transfer/confirm-in', data),

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

  // Finance
  getDailyDetails: (params) => api.get('/finance/daily-details', { params }),
  getDailyStatement: (params) => api.get('/finance/daily-statement', { params }),
  getDailyStatementDetail: (id) => api.get(`/finance/daily-statement/${id}`),
  getSettlementSummary: (params) => api.get('/finance/settlement-summary', { params }),
  batchSettle: (data) => api.post('/finance/batch-settle', data),
  createExpense: (data) => api.post('/finance/expense', data),
  getExpenseList: (params) => api.get('/finance/expense-list', { params }),
  submitExpense: (id) => api.put(`/finance/expense/submit/${id}`),
  payExpense: (id, data) => api.put(`/finance/expense/pay/${id}`, data),
  getPayableList: (params) => api.get('/finance/payable-list', { params }),
  getUnpaidBySupplier: (params) => api.get('/finance/unpaid-by-supplier', { params }),
  createSettlement: (data) => api.post('/finance/create-settlement', data),
  getSettlementList: (params) => api.get('/finance/settlement-list', { params }),
  confirmPayment: (data) => api.post('/finance/confirm-payment', data),
  getSettlementAccountsBalance: (params) => api.get('/finance/settlement-accounts/balance', { params }),
  getAccountTransactions: (accountId, params) => api.get(`/finance/settlement-account/${accountId}/transactions`, { params }),
  addAccountTransaction: (data) => api.post('/finance/settlement-account/transaction', data),
  addRebate: (data) => api.post('/finance/add-rebate', data),
  getRebateList: (params) => api.get('/finance/rebate-list', { params }),
  getRebateBalance: (params) => api.get('/finance/rebate-balance', { params }),

  // Product
  getProductList: (params) => api.get('/product/list', { params }),
  searchProduct: (params) => api.get('/product/search', { params }),
  createProduct: (data) => api.post('/product/create', data),
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
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      // 从响应头中获取文件名
      let fileName = `商品导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const contentDisposition = response.headers['content-disposition'];
      if (contentDisposition) {
        const fileNameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (fileNameMatch && fileNameMatch[1]) {
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
  // 分类字段配置
  getCategoryFields: (categoryId) => api.get('/product/category/fields', { params: { categoryId } }),
  saveCategoryFields: (data) => api.post('/product/category/fields', data),
  getCategoryFieldConfig: (categoryId) => api.get('/product/category/field-config', { params: { categoryId } }),
  // 商品价格
  getPriceList: (params) => api.get('/product/price/list', { params }),
  setPrice: (data) => api.post('/product/price/set', data),
  refreshCostPrice: (productId) => api.post(`/product/price/refresh-cost/${productId}`),
  batchRefreshCost: (data) => api.post('/product/price/batch-refresh-cost', data),
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
