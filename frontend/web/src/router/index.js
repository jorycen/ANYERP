import { createRouter, createWebHistory } from 'vue-router'
import { isSalesQueryOnly } from '../utils/user'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  { path: '/store', redirect: '/stores' },
  { path: '/store/:pathMatch(.*)*', redirect: '/stores' },
  { path: '/product', redirect: '/products/product' },
  { path: '/product/:pathMatch(.*)*', redirect: '/products/product' },
  { path: '/sales', redirect: '/sales/order' },
  { path: '/purchase', redirect: '/purchase/request' },
  { path: '/finance', redirect: '/finance/daily' },
  { path: '/finance/report', redirect: '/reports' },
  { path: '/payment-management/:pathMatch(.*)*', redirect: '/finance/payment' },
  { path: '/inventory', redirect: '/inventory/summary' },
  { path: '/system', redirect: '/system/users' },
  { path: '/products', redirect: '/products/product' },
  { path: '/reports', redirect: '/reports/dashboard' },
  { path: '/approval', redirect: '/approval/tasks' },
  {
    path: '/',
    component: () => import('../views/Layout.vue'),
    children: [
      {
        path: '',
        name: 'Dashboard',
        component: () => import('../views/Dashboard.vue')
      },
      {
        path: 'sales/order',
        name: 'Sales',
        component: () => import('../views/Sales.vue'),
        meta: { tab: 'order' }
      },
      {
        path: 'sales/subsidy-photos',
        name: 'SubsidyPhotos',
        component: () => import('../views/SubsidyPhotos.vue'),
        meta: { roles: ['finance', 'manager', 'store_manager', 'admin', 'boss'], tab: 'subsidy-photos' }
      },
      {
        path: 'sales/monthly-tasks',
        name: 'MonthlyTasks',
        component: () => import('../views/MonthlyTasks.vue'),
        meta: { roles: ['manager', 'store_manager', 'admin', 'boss'], tab: 'monthly-tasks' }
      },
      {
        path: 'inventory/summary',
        name: 'Inventory',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'summary' }
      },
      {
        path: 'inventory/sn-inventory',
        name: 'InventorySnInventory',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'sn-inventory' }
      },
      {
        path: 'inventory/batch-maintenance',
        name: 'InventoryBatchMaintenance',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'batch-maintenance' }
      },
      {
        path: 'inventory/inbound',
        name: 'InventoryInbound',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'inbound' }
      },
      {
        path: 'inventory/sn-trace',
        name: 'InventorySnTrace',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'sn-trace' }
      },
      {
        path: 'inventory/resource-rights',
        name: 'InventoryResourceRights',
        component: () => import('../views/Inventory.vue'),
        meta: { roles: ['finance', 'manager', 'admin', 'boss'], tab: 'resource-rights' }
      },
      {
        path: 'inventory/transfer',
        name: 'InventoryTransfer',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'transfer' }
      },
      {
        path: 'inventory/conversion',
        name: 'InventoryConversion',
        component: () => import('../views/Inventory.vue'),
        meta: { tab: 'conversion' }
      },
      {
        path: 'purchase/request',
        name: 'Purchase',
        component: () => import('../views/Purchase.vue'),
        meta: {
          roles: ['purchaser', 'admin', 'boss'],
          traceRoles: '*',
          tab: 'request'
        }
      },
      {
        path: 'purchase/supplier',
        name: 'PurchaseSupplier',
        component: () => import('../views/Purchase.vue'),
        meta: {
          roles: ['purchaser', 'admin', 'boss'],
          tab: 'supplier'
        }
      },
      {
        path: 'finance/daily',
        name: 'Finance',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'daily' }
      },
      {
        path: 'finance/product-settlement',
        name: 'FinanceProductSettlement',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'product-settlement' }
      },
      {
        path: 'finance/subsidy-receivable',
        name: 'FinanceSubsidyReceivable',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'nationalSubsidyReceivable' }
      },
      {
        path: 'finance/rebate-settlement',
        name: 'FinanceRebateSettlement',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'rebate-settlement' }
      },
      {
        path: 'finance/expense',
        name: 'FinanceExpense',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'expense' }
      },
      {
        path: 'finance/payable',
        name: 'FinancePayable',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'payable' }
      },
      {
        path: 'finance/reimbursement',
        name: 'FinanceReimbursement',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'reimbursement' }
      },
      {
        path: 'finance/payment',
        name: 'FinancePayment',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'payment' }
      },
      {
        path: 'finance/rebate',
        name: 'FinanceRebate',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'rebate' }
      },
      {
        path: 'finance/resource-rights',
        name: 'FinanceResourceRights',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'resource-rights' }
      },
      {
        path: 'finance/account',
        name: 'FinanceAccount',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'], tab: 'account' }
      },
      {
        path: 'finance/settlement',
        name: 'FinanceSettlement',
        component: () => import('../views/PayableSettlementManagement.vue'),
        meta: { roles: ['finance', 'admin', 'boss'] }
      },
      {
        path: 'finance/freight',
        name: 'FinanceFreight',
        component: () => import('../views/Freight.vue'),
        meta: { roles: ['finance', 'admin', 'boss'] }
      },
      {
        path: 'products/product',
        name: 'Products',
        component: () => import('../views/Products.vue'),
        meta: { tab: 'product' }
      },
      {
        path: 'products/category',
        name: 'ProductsCategory',
        component: () => import('../views/Products.vue'),
        meta: { tab: 'category' }
      },
      {
        path: 'products/price',
        name: 'ProductsPrice',
        component: () => import('../views/Products.vue'),
        meta: { tab: 'price' }
      },
      {
        path: 'products/approval',
        name: 'ProductsApproval',
        component: () => import('../views/Products.vue'),
        meta: { tab: 'approval' }
      },
      {
        path: 'stores',
        name: 'Stores',
        component: () => import('../views/Stores.vue')
      },
      {
        path: 'reports/dashboard',
        name: 'Reports',
        component: () => import('../views/Reports.vue'),
        meta: { tab: 'dashboard' }
      },
      {
        path: 'reports/sales',
        name: 'ReportsSales',
        component: () => import('../views/Reports.vue'),
        meta: { tab: 'sales' }
      },
      {
        path: 'reports/inventory',
        name: 'ReportsInventory',
        component: () => import('../views/Reports.vue'),
        meta: { tab: 'inventory' }
      },
      {
        path: 'reports/employee',
        name: 'ReportsEmployee',
        component: () => import('../views/Reports.vue'),
        meta: { tab: 'employee' }
      },
      {
        path: 'reports/achievement',
        name: 'ReportsAchievement',
        component: () => import('../views/Reports.vue'),
        meta: { tab: 'achievement' }
      },
      {
        path: 'approval/tasks',
        name: 'Approval',
        component: () => import('../views/Approval.vue'),
        meta: { tab: 'tasks' }
      },
      {
        path: 'approval/instances',
        name: 'ApprovalInstances',
        component: () => import('../views/Approval.vue'),
        meta: { tab: 'instances' }
      },
      {
        path: 'approval/flows',
        name: 'ApprovalFlows',
        component: () => import('../views/Approval.vue'),
        meta: { tab: 'flows' }
      },
      {
        path: 'system/users',
        name: 'System',
        component: () => import('../views/System.vue'),
        meta: { roles: ['admin', 'boss'], tab: 'users' }
      },
      {
        path: 'system/roles', name: 'SystemRoles', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'roles' }
      },
      {
        path: 'system/menus', name: 'SystemMenus', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'menus' }
      },
      {
        path: 'system/locations', name: 'SystemLocations', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'locations' }
      },
      {
        path: 'system/resource-categories', name: 'SystemResourceCategories', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'resourceCategories' }
      },
      {
        path: 'system/customer-source', name: 'SystemCustomerSource', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'customerSource' }
      },
      {
        path: 'system/payment-method', name: 'SystemPaymentMethod', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'paymentMethod' }
      },
      {
        path: 'system/supplement-item', name: 'SystemSupplementItem', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'supplementItem' }
      },
      {
        path: 'system/expense-type', name: 'SystemExpenseType', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'expenseType' }
      },
      {
        path: 'system/category-field', name: 'SystemCategoryField', component: () => import('../views/System.vue'), meta: { roles: ['admin', 'boss'], tab: 'categoryField' }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

const queryMirrorPaths = new Set([
  '/', '/sales/order', '/sales/subsidy-photos', '/sales/monthly-tasks',
  '/inventory/summary', '/inventory/sn-inventory', '/inventory/batch-maintenance',
  '/inventory/inbound', '/inventory/sn-trace', '/inventory/resource-rights',
  '/inventory/transfer', '/inventory/conversion',
  '/products/product', '/products/category', '/products/price', '/products/approval',
  '/stores', '/reports/dashboard', '/reports/sales', '/reports/inventory',
  '/reports/employee', '/reports/achievement', '/approval/tasks', '/approval/instances',
  '/system/users'
])

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
  const userRoles = Array.isArray(userInfo.roles) && userInfo.roles.length
    ? userInfo.roles
    : String(userInfo.roleCode || '').split(',').map(role => role.trim()).filter(Boolean)

  if (to.path !== '/login' && !token) {
    next('/login')
    return
  }

  if (to.path === '/login' && token) {
    next('/')
    return
  }

  if (token && isSalesQueryOnly(userInfo)) {
    next(queryMirrorPaths.has(to.path) ? undefined : '/sales/order')
    return
  }

  const isTraceRoute = String(to.query.trace || '') === '1' && Boolean(to.query.requestId)
  const routeRoles = isTraceRoute ? to.meta.traceRoles : to.meta.roles
  if (routeRoles && routeRoles !== '*' && !userRoles.some(role => routeRoles.includes(role))) {
    next('/')
    return
  }

  next()
})

export default router
