import axios from 'axios'

const api = axios.create({
  baseURL: 'https://cloud1-249791-6-1410946266.sh.run.tcloudbase.com/api/v1',
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
  response => response.data,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('userInfo')
      window.location.href = '/login'
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
  createSupplier: (data) => api.post('/purchase/supplier', data),
  updateSupplier: (id, data) => api.put(`/purchase/supplier/${id}`, data),

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
