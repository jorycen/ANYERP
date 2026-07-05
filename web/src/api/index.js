import axios from 'axios'

const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options'])
const MAX_RETRY_COUNT = 2
const RETRY_BASE_DELAY = 1000

const api = axios.create({
  baseURL: '/api/v1',
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

api.interceptors.response.use(
  response => response.data,
  async error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('userInfo')
      window.location.href = '/login'
      return Promise.reject(error)
    }

    const config = error.config || {}
    config.__retryCount = config.__retryCount || 0

    if (config.__retryCount < MAX_RETRY_COUNT && isRetryableError(error)) {
      config.__retryCount += 1
      await sleep(RETRY_BASE_DELAY * 2 ** (config.__retryCount - 1))
      return api.request(config)
    }

    return Promise.reject(error)
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
  updateSales: (id, data) => api.put(`/sales/update/${id}`, data),

  // Inventory
  getInventoryList: (params) => api.get('/inventory/list', { params }),
  getSnList: (params) => api.get('/inventory/sn-list', { params }),
  inbound: (data) => api.post('/inventory/inbound', data),
  outbound: (data) => api.post('/inventory/outbound', data),
  transfer: (data) => api.post('/inventory/transfer', data),

  // Purchase
  getPurchaseRequestList: (params) => api.get('/purchase/request-list', { params }),
  createPurchaseRequest: (data) => api.post('/purchase/create-request', data),
  approvePurchaseRequest: (id, data) => api.post(`/purchase/approve-request/${id}`, data),
  getSupplierList: () => api.get('/purchase/supplier-list'),

  // Finance
  getDailyStatement: (params) => api.get('/finance/daily-statement', { params }),
  createExpense: (data) => api.post('/finance/expense', data),
  getExpenseList: (params) => api.get('/finance/expense-list', { params }),

  // Product
  getProductList: (params) => api.get('/product/list', { params }),
  createProduct: (data) => api.post('/product/create', data),
  updateProduct: (id, data) => api.put(`/product/update/${id}`, data),
  getPnList: (params) => api.get('/product/pn-list', { params }),
  addPn: (data) => api.post('/product/pn', data),
  getCategory: () => api.get('/product/category'),

  // Store
  getStoreList: (params) => api.get('/store/list', { params }),
  createStore: (data) => api.post('/store/create', data),
  updateStore: (id, data) => api.put(`/store/update/${id}`, data),

  // Report
  getSalesReport: (params) => api.get('/report/sales', { params }),
  getInventoryReport: (params) => api.get('/report/inventory', { params }),
  getDashboardFilters: () => api.get('/report/dashboard/filters'),
  getDashboardOverview: (params) => api.get('/report/dashboard/overview', { params }),

  // System
  getMenus: () => api.get('/system/menus'),
  getRoles: () => api.get('/system/roles'),
  getRoleMenus: (roleId) => api.get(`/system/role-menus/${roleId}`),
  assignMenus: (roleId, data) => api.post(`/system/assign-menus/${roleId}`, data),
  getUsers: (params) => api.get('/system/users', { params }),
  updateUserRoles: (userId, data) => api.post(`/system/update-user-roles/${userId}`, data),
  getUserRegions: (userId) => api.get(`/system/user-regions/${userId}`),
  assignUserRegions: (userId, data) => api.post(`/system/assign-user-regions/${userId}`, data)
}
