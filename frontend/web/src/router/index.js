import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  { path: '/store', redirect: '/stores' },
  { path: '/store/:pathMatch(.*)*', redirect: '/stores' },
  { path: '/product', redirect: '/products' },
  { path: '/product/:pathMatch(.*)*', redirect: '/products' },
  { path: '/purchase/:pathMatch(.*)*', redirect: '/purchase' },
  { path: '/sales/:pathMatch(.*)*', redirect: '/sales' },
  { path: '/finance/daily', redirect: '/finance' },
  { path: '/finance/expense', redirect: '/finance' },
  { path: '/finance/report', redirect: '/finance' },
  { path: '/payment-management/:pathMatch(.*)*', redirect: '/finance/payment' },
  { path: '/inventory/:pathMatch(.*)*', redirect: '/inventory' },
  { path: '/system/:pathMatch(.*)*', redirect: '/system' },
  { path: '/reports/:pathMatch(.*)*', redirect: '/reports' },
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
        path: 'sales',
        name: 'Sales',
        component: () => import('../views/Sales.vue')
      },
      {
        path: 'inventory',
        name: 'Inventory',
        component: () => import('../views/Inventory.vue')
      },
      {
        path: 'purchase',
        name: 'Purchase',
        component: () => import('../views/Purchase.vue'),
        meta: { roles: ['purchaser', 'admin', 'boss'] }
      },
      {
        path: 'finance',
        name: 'Finance',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'] }
      },
      {
        path: 'finance/payment',
        name: 'FinancePayment',
        component: () => import('../views/Finance.vue'),
        meta: { roles: ['finance', 'admin', 'boss'] }
      },
      {
        path: 'products',
        name: 'Products',
        component: () => import('../views/Products.vue')
      },
      {
        path: 'stores',
        name: 'Stores',
        component: () => import('../views/Stores.vue')
      },
      {
        path: 'reports',
        name: 'Reports',
        component: () => import('../views/Reports.vue')
      },
      {
        path: 'system',
        name: 'System',
        component: () => import('../views/System.vue'),
        meta: { roles: ['manager', 'admin', 'boss'] }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
  const roleCode = userInfo.roleCode || ''

  if (to.path !== '/login' && !token) {
    next('/login')
    return
  }

  if (to.path === '/login' && token) {
    next('/')
    return
  }

  if (to.meta.roles && !to.meta.roles.includes(roleCode)) {
    next('/')
    return
  }

  next()
})

export default router
