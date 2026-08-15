import axios from 'axios'
import router from '../router'

function normalizeApiBaseUrl(value) {
  const raw = String(value || '/api/v1').trim()
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '')
  }
  const pathValue = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  return `/${pathValue || 'api/v1'}`
}

const configuredApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = normalizeApiBaseUrl(configuredApiBaseUrl || '/api/v1')
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
      const isLoginRequest = error.config?.url?.endsWith('/auth/login')
      if (error.response?.status === 401 && !isLoginRequest) {
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

function buildNativeDownloadUrl(pathname, params = {}) {
  const baseUrl = /^https?:\/\//i.test(API_BASE_URL)
    ? API_BASE_URL
    : `${window.location.origin}${API_BASE_URL}`
  const url = new URL(`${baseUrl}${pathname}`, window.location.origin)
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, value)
    }
  })
  return url.toString()
}

function downloadBlobWithProgress(pathname, params = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', buildNativeDownloadUrl(pathname, params), true)
    xhr.responseType = 'blob'
    xhr.onprogress = event => {
      onProgress?.(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null)
    }
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve({ data: xhr.response, headers: { 'content-disposition': xhr.getResponseHeader('Content-Disposition') || '' } })
        return
      }
      let message = `下载失败（HTTP ${xhr.status}）`
      try {
        const payload = JSON.parse(await xhr.response.text())
        message = payload?.message || message
      } catch (_) {
        // 保留通用错误提示
      }
      reject(Object.assign(new Error(message), { response: { data: xhr.response, status: xhr.status } }))
    }
    xhr.onerror = () => reject(new Error('下载请求失败，请检查网络连接'))
    xhr.onabort = () => reject(new Error('下载已取消'))
    xhr.send()
  })
}

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

export const apiBaseUrl = API_BASE_URL

function exportExcel(url, params, fallbackFileName) {
  return exportApi.get(url, {
    params,
    responseType: 'blob'
  }).then(response => {
    const blob = new Blob([response.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    const downloadUrl = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl

    const contentDisposition = response.headers?.['content-disposition'] || ''
    const encodedFileName = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
    const plainFileName = contentDisposition.match(/filename=([^;]+)/i)
    let fileName = fallbackFileName
    if (encodedFileName?.[1]) {
      fileName = decodeURIComponent(encodedFileName[1])
    } else if (plainFileName?.[1]) {
      fileName = plainFileName[1].replace(/["']/g, '')
    }

    link.setAttribute('download', fileName)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(downloadUrl)
    return response
  })
}

export default {
  // Auth
  login: (data) => api.post('/auth/login', data),
  getUserInfo: () => api.get('/auth/userinfo'),
  changePassword: (data) => api.post('/auth/changepassword', data),

  // Sales
  getSalesList: (params) => api.get('/sales/list', { params }),
  exportSales: (params) => exportExcel('/sales/export', params, `销售订单导出_${new Date().toISOString().slice(0, 10)}.xlsx`),
  getSubsidyPhotos: (params) => api.get('/sales/subsidy-photos', { params }),
  createSubsidyPhotosDownloadTicket: (params) => api.get('/sales/subsidy-photos/batch-download-ticket', { params }),
  getSubsidyPhotosDownloadUrl: (ticket, params) => buildNativeDownloadUrl('/sales/subsidy-photos/batch-download', {
    ...params,
    downloadToken: ticket
  }),
  downloadSubsidyPhotosArchiveWithProgress: (ticket, params, onProgress) => downloadBlobWithProgress(
    '/sales/subsidy-photos/batch-download',
    { ...params, downloadToken: ticket },
    onProgress
  ),
  resolveCloudFileUrls: (fileIds) => api.post('/storage/file-urls', { fileIds }),
  replaceSubsidyPhotos: (orderId, data) => api.post(`/sales/subsidy-photos/${orderId}`, data, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }),
  getSubsidyPhotoFile: (orderId, photoId) => exportApi.get(`/sales/subsidy-photos/${orderId}/files/${encodeURIComponent(photoId)}`, {
    responseType: 'blob'
  }),
  downloadSubsidyPhotosArchive: (orderId) => exportApi.get(`/sales/subsidy-photos/${orderId}/download`, {
    responseType: 'blob'
  }),
  downloadAllSubsidyPhotosArchive: (params) => exportApi.get('/sales/subsidy-photos/batch-download', {
    params,
    responseType: 'blob'
  }),
  createSales: (data) => api.post('/sales/create', data),
  saveSalesDraft: (data) => api.post('/sales/draft', data),
  updateSalesDraft: (id, data) => api.put(`/sales/draft/${id}`, data),
  submitSalesDraft: (id) => api.post(`/sales/draft/${id}/submit`),
  deleteSalesDraft: (id) => api.delete(`/sales/draft/${id}`),
  getSalesDetail: (id, params) => api.get(`/sales/${id}`, { params }),
  getAuxiliaryStaff: () => api.get('/sales/auxiliary-staff'),
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
  exportInventoryList: (params) => exportExcel('/inventory/list/export', params, `库存汇总_${new Date().toISOString().slice(0, 10)}.xlsx`),
  getSnInventoryList: (params) => api.get('/inventory/sn-inventory-list', { params }),
  exportSnInventoryList: (params) => exportExcel('/inventory/sn-inventory-list/export', params, `SN库存清单_${new Date().toISOString().slice(0, 10)}.xlsx`),
  setSnSpecialPrice: (snId, data) => api.put(`/inventory/sn/${snId}/special-price`, data),
  cancelSnSpecialPrice: (snId, data = {}) => api.delete(`/inventory/sn/${snId}/special-price`, { data }),
  getSnSpecialPriceHistory: (snId) => api.get(`/inventory/sn/${snId}/special-price-history`),
  getSnList: (params) => api.get('/inventory/sn-list', { params }),
  submitSnChangeApplication: (data) => api.post('/inventory/sn-change-applications', data),
  adjustSnLocation: (snId, data) => api.post(`/inventory/sn/${snId}/location-adjust`, data),
  snTrace: (snCode, params) => api.get(`/inventory/sn-trace/${encodeURIComponent(snCode)}`, { params }),
  getSnTraceInboundDetail: (inboundId) => api.get(`/inventory/sn-trace-inbound/${encodeURIComponent(inboundId)}`),
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
  createManualRebateSettlement: (data) => api.post('/inventory/resource-settlements/manual-rebate', data),
  settleResource: (settlementId, data = {}) => api.post(`/inventory/resource-settlements/${settlementId}/settle`, data),
  cancelResourceSettlement: (settlementId, data) => api.post(`/inventory/resource-settlements/${settlementId}/cancel`, data),
  reverseResourceSettlement: (settlementId, data) => api.post(`/inventory/resource-settlements/${settlementId}/reverse`, data),
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
  getTransferDetail: (id, params) => api.get(`/inventory/transfer/${id}`, { params }),
  confirmTransferOut: (data) => api.post('/inventory/transfer/confirm-out', data),
  confirmTransferIn: (data) => api.post('/inventory/transfer/confirm-in', data),
  returnTransfer: (data) => api.post('/inventory/transfer/return', data),
  revokeTransfer: (data) => api.post('/inventory/transfer/revoke', data),
  rejectTransfer: (data) => api.post('/inventory/transfer/reject', data),
  getConversionList: (params) => api.get('/inventory/conversion-list', { params }),
  getConversionDetail: (id) => api.get(`/inventory/conversion/${id}`),
  createConversion: (data) => api.post('/inventory/conversion', data),
  voidConversion: (id, data) => api.post(`/inventory/conversion/${id}/void`, data),
  getInventoryBatchApplications: (params) => api.get('/inventory/batch-maintenance', { params }),
  getInventoryBatchApplicationDetail: (id) => api.get(`/inventory/batch-maintenance/${id}`),
  importInventoryBatchApplication: (file, data) => {
    const formData = new FormData();
    formData.append('file', file);
    Object.entries(data || {}).forEach(([key, value]) => formData.append(key, value));
    return api.post('/inventory/batch-maintenance/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 180000
    });
  },
  reviewInventoryBatchApplication: (id, data) => api.post(`/inventory/batch-maintenance/${id}/review`, data),

  // Purchase
  getPurchaseRequestList: (params) => api.get('/purchase/request-list', { params }),
  getPurchaseRequestDetail: (id, params) => api.get(`/purchase/request-detail/${id}`, { params }),
  createPurchaseRequest: (data) => api.post('/purchase/create-request', data),
  savePurchaseRequestDraft: (data) => api.post('/purchase/request-draft', data),
  updatePurchaseRequestDraft: (id, data) => api.put(`/purchase/request-draft/${id}`, data),
  submitPurchaseRequestDraft: (id) => api.post(`/purchase/request-draft/${id}/submit`),
  deletePurchaseRequestDraft: (id) => api.delete(`/purchase/request-draft/${id}`),
  approvePurchaseRequest: (id, data) => api.post(`/purchase/approve-request/${id}`, data),
  revokePurchaseRequest: (id, data) => api.post(`/purchase/revoke-request/${id}`, data),
  getPurchaseAdjustmentPreview: (id) => api.get(`/purchase/adjustment-preview/${id}`),
  createPurchaseAdjustment: (data) => api.post('/purchase/create-adjustment', data),
  getSupplierList: (params) => api.get('/purchase/supplier-list', { params }),
  getAllSuppliers: () => api.get('/purchase/supplier-all'),
  createSupplier: (data) => api.post('/purchase/supplier', data),
  updateSupplier: (id, data) => api.put(`/purchase/supplier/${id}`, data),
  deleteSupplier: (id) => api.delete(`/purchase/supplier/${id}`),
  sortSuppliers: (data) => api.post('/purchase/supplier/sort', data),

  // Finance
  getFreightPlatforms: (params) => api.get('/finance/freight/platforms', { params }),
  createFreightPlatform: (data) => api.post('/finance/freight/platforms', data),
  updateFreightPlatform: (id, data) => api.put(`/finance/freight/platforms/${id}`, data),
  deleteFreightPlatform: (id) => api.delete(`/finance/freight/platforms/${id}`),
  getFreightRecords: (params) => api.get('/finance/freight/records', { params }),
  exportFreightRecords: (params) => exportExcel('/finance/freight/records/export', params, `运费记录_${new Date().toISOString().slice(0, 10)}.xlsx`),
  getDailyDetails: (params) => api.get('/finance/daily-details', { params }),
  getNationalSubsidyReceivables: (params) => api.get('/finance/national-subsidy-receivables', { params }),
  getSubsidyAccountRoutes: () => api.get('/finance/national-subsidy-account-routes'),
  saveSubsidyAccountRoute: (data) => api.put('/finance/national-subsidy-account-routes', data),
  getSubsidyReceipts: (params) => api.get('/finance/national-subsidy-receipts', { params }),
  createSubsidyReceipt: (data) => api.post('/finance/national-subsidy-receipts', data),
  allocateSubsidyReceipt: (id, data) => api.post(`/finance/national-subsidy-receipts/${id}/allocate`, data),
  refundSubsidyReceipt: (id, data) => api.post(`/finance/national-subsidy-receipts/${id}/refund`, data),
  reverseSubsidyReceipt: (id, data) => api.post(`/finance/national-subsidy-receipts/${id}/reverse`, data),
  getSubsidyAdjustments: (params) => api.get('/finance/national-subsidy-adjustments', { params }),
  submitSubsidyAdjustment: (data) => api.post('/finance/national-subsidy-adjustments', data),
  reviewSubsidyAdjustment: (id, data) => api.post(`/finance/national-subsidy-adjustments/${id}/review`, data),
  reverseSubsidyAdjustment: (id, data) => api.post(`/finance/national-subsidy-adjustments/${id}/reverse`, data),
  getDailyStatement: (params) => api.get('/finance/daily-statement', { params }),
  getDailyStatementDetail: (id) => api.get(`/finance/daily-statement/${id}`),
  getSettlementSummary: (params) => api.get('/finance/settlement-summary', { params }),
  batchSettle: (data) => api.post('/finance/batch-settle', data),
  settleNationalSubsidyReceivables: (data) => api.post('/finance/national-subsidy-receivables/settle', data),
  createExpense: (data) => api.post('/finance/expense', data),
  saveExpenseDraft: (data) => api.post('/finance/expense-draft', data),
  updateExpenseDraft: (id, data) => api.put(`/finance/expense-draft/${id}`, data),
  deleteExpenseDraft: (id) => api.delete(`/finance/expense-draft/${id}`),
  submitExpenseDraft: (id) => api.put(`/finance/expense-draft/${id}/submit`),
  getExpenseList: (params) => api.get('/finance/expense-list', { params }),
  reviewExpense: (id, data) => api.post(`/finance/expense/${id}/review`, data),
  submitExpense: (id) => api.put(`/finance/expense/submit/${id}`),
  payExpense: (id, data) => api.put(`/finance/expense/pay/${id}`, data),
  getPayableList: (params) => api.get('/finance/payable-list', { params }),
  getUnpaidBySupplier: (params) => api.get('/finance/unpaid-by-supplier', { params }),
  getPayableSettlementItems: (params) => api.get('/finance/payable-settlement-items', { params }),
  createSettlement: (data) => api.post('/finance/create-settlement', data),
  createExpenseSettlement: (data) => api.post('/finance/create-expense-settlement', data),
  getSettlementList: (params) => api.get('/finance/settlement-list', { params }),
  getSettlementDetail: (id) => api.get(`/finance/settlement/${id}`),
  deleteSettlementDraft: (id) => api.delete(`/finance/settlement/${id}`),
  submitSettlement: (data) => api.post('/finance/settlement/submit', data),
  confirmSettlement: (data) => api.post('/finance/settlement/confirm', data),
  rejectSettlement: (data) => api.post('/finance/settlement/reject', data),
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
  getRebateList: (params) => api.get('/finance/rebate-list', { params }),
  getRebateBalance: (params) => api.get('/finance/rebate-balance', { params }),
  getRebateSummary: () => api.get('/finance/rebate-summary'),
  addRebate: (data) => api.post('/finance/add-rebate', data),
  getRebatePostingOrders: (params) => api.get('/finance/rebate-posting-orders', { params }),
  reverseRebatePostingOrder: (id, data) => api.post(`/finance/rebate-posting-orders/${id}/reverse`, data),
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
  batchDeleteProducts: (data) => api.post('/product/batch-delete', data),
  togglePause: (id) => api.post(`/product/toggle-pause/${id}`),
  importProducts: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/product/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000
    });
  },
  getProductImportTask: (taskId) => api.get(`/product/import/task/${taskId}`),
  exportProducts: (params) => exportExcel('/product/export', params, `商品导出_${new Date().toISOString().slice(0, 10)}.xlsx`),
  exportCostPrices: (params) => exportExcel('/product/export', { ...(params || {}), exportType: 'price' }, `商品成本导出_${new Date().toISOString().slice(0, 10)}.xlsx`),
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
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000
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
  getTransferStores: () => api.get('/store/transfer-options'),
  createStore: (data) => api.post('/store/create', data),
  updateStore: (id, data) => api.put(`/store/update/${id}`, data),
  deleteStore: (id) => api.delete(`/store/delete/${id}`),
  getRegionList: () => api.get('/store/regions'),

  // Report
  getSalesReport: (params) => api.get('/report/sales', { params }),
  getInventoryReport: (params) => api.get('/report/inventory', { params }),
  getDashboardFilters: () => api.get('/report/dashboard/filters'),
  getDashboardOverview: (params) => api.get('/report/dashboard/overview', { params }),
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
  getUserDistributors: () => api.get('/system/user-distributors'),
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
  getSystemLocations: (params) => api.get('/system/locations', { params }),
  createSystemLocation: (data) => api.post('/system/locations', data),
  updateSystemLocation: (id, data) => api.put(`/system/locations/${id}`, data),
  deleteSystemLocation: (id) => api.delete(`/system/locations/${id}`),
  setStoreManager: (storeId, data) => api.put(`/system/stores/${storeId}/manager`, data),

  // Approval center
  getApprovalFlows: (params) => api.get('/approval/flows', { params }),
  getApprovalFlow: (id) => api.get(`/approval/flows/${id}`),
  createApprovalFlow: (data) => api.post('/approval/flows', data),
  updateApprovalFlow: (id, data) => api.put(`/approval/flows/${id}`, data),
  publishApprovalFlow: (id) => api.post(`/approval/flows/${id}/publish`),
  disableApprovalFlow: (id) => api.post(`/approval/flows/${id}/disable`),
  getApprovalAssigneeOptions: () => api.get('/approval/assignee-options'),
  getApprovalTasks: (params) => api.get('/approval/tasks', { params }),
  getApprovalInstances: (params) => api.get('/approval/instances', { params }),
  getApprovalInstance: (id) => api.get(`/approval/instances/${id}`),
  submitApproval: (data) => api.post('/approval/instances', data),
  actionApproval: (id, data) => api.post(`/approval/instances/${id}/action`, data),
  resubmitApproval: (id, data) => api.post(`/approval/instances/${id}/resubmit`, data),

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
  sortSupplementItems: (data) => api.post('/dict/supplement-item/sort', data),

  // Dict - Expense Type
  getExpenseTypes: (params = {}) => api.get('/dict/expense-type/all', { params }),
  createExpenseType: (data) => api.post('/dict/expense-type/create', data),
  updateExpenseType: (id, data) => api.put(`/dict/expense-type/update/${id}`, data),
  deleteExpenseType: (id) => api.delete(`/dict/expense-type/delete/${id}`)
}
