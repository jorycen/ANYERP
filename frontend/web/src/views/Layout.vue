<template>
  <el-container class="layout-container" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
    <el-aside :width="sidebarWidth" class="sidebar">
      <div class="logo">
        <span class="logo-mark">A</span>
        <div v-if="!sidebarCollapsed" class="logo-copy">
          <strong>ANY-ERP</strong>
          <span>连锁经营管理</span>
        </div>
      </div>
      <el-menu
        :default-active="activeMenu"
        :default-openeds="openedMenus"
        class="sidebar-menu"
        :collapse="sidebarCollapsed"
        :collapse-transition="false"
        :router="true"
      >
        <SidebarMenuItem
          v-for="menu in menuTree"
          :key="menu.menuCode"
          :menu="menu"
          :icon-map="iconMap"
        />
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <button class="sidebar-toggle" type="button" :aria-label="sidebarCollapsed ? '展开菜单' : '收起菜单'" @click="sidebarCollapsed = !sidebarCollapsed">
            <el-icon><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
          </button>
          <div class="title-stack">
            <span class="title-context">ANY-ERP / 工作台</span>
            <span class="page-title">{{ pageTitle }}</span>
          </div>
        </div>
        <div class="header-right">
          <span class="role-tag">
            <el-tag size="small" effect="plain">{{ roleName }}</el-tag>
          </span>
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <span class="user-avatar">{{ userInitial }}</span>
              <span class="user-copy">
                <strong>{{ userName }}</strong>
                <small>账号设置</small>
              </span>
              <el-icon class="user-chevron"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="changePassword">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main-content">
        <router-view v-if="!queryOnly || route.path === '/sales/order'" />
      </el-main>
    </el-container>

    <el-dialog
      v-model="passwordDialogVisible"
      title="修改密码"
      width="420px"
      destroy-on-close
      @closed="resetPasswordForm"
    >
      <el-form
        ref="passwordFormRef"
        :model="passwordForm"
        :rules="passwordRules"
        label-width="90px"
        @submit.prevent="submitPasswordChange"
      >
        <el-form-item label="旧密码" prop="oldPassword">
          <el-input
            v-model="passwordForm.oldPassword"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入旧密码"
            @keyup.enter="submitPasswordChange"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="passwordForm.newPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="请输入至少 6 位的新密码"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="passwordForm.confirmPassword"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="请再次输入新密码"
            @keyup.enter="submitPasswordChange"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="passwordSubmitting" @click="submitPasswordChange">
          保存
        </el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import SidebarMenuItem from '../components/SidebarMenuItem.vue'
import { isSalesQueryOnly } from '../utils/user'
import {
  House, Sell, Box, ShoppingCart, Money, Goods,
  Shop, DataAnalysis, Setting, User, Checked, Fold, Expand, ArrowDown
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const queryOnly = isSalesQueryOnly()

const userName = ref('')
const roleName = ref('')
const menuTree = ref([])
const sidebarCollapsed = ref(false)
const passwordDialogVisible = ref(false)
const passwordSubmitting = ref(false)
const passwordFormRef = ref(null)
const passwordForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const validateConfirmPassword = (rule, value, callback) => {
  if (!value) return callback(new Error('请再次输入新密码'))
  if (value !== passwordForm.newPassword) return callback(new Error('两次输入的新密码不一致'))
  callback()
}

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入旧密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码至少 6 位', trigger: 'blur' }
  ],
  confirmPassword: [{ validator: validateConfirmPassword, trigger: 'blur' }]
}

const iconMap = {
  House, Sell, Box, ShoppingCart, Money, Goods, Shop, DataAnalysis, Setting, User, Checked
}

const activeMenu = computed(() => route.path)
const routeMatchesMenu = (menu) => {
  if (menu.path && (route.path === menu.path || route.path.startsWith(`${menu.path}/`))) return true
  return (menu.children || []).some(routeMatchesMenu)
}

const openedMenus = computed(() => {
  const opened = []
  const visit = (menus) => {
    menus.forEach(menu => {
      if (menu.children?.length && menu.children.some(routeMatchesMenu)) opened.push(menu.menuCode)
      if (menu.children?.length) visit(menu.children)
    })
  }
  visit(menuTree.value)
  return opened
})

const pageTitles = {
  '/': '首页',
  '/sales/order': '销售订单',
  '/sales/subsidy-photos': '国补照片',
  '/inventory/summary': '库存汇总',
  '/inventory/sn-inventory': 'SN库存清单',
  '/inventory/batch-maintenance': '批量维护',
  '/inventory/inbound': '入库单管理',
  '/inventory/sn-trace': 'SN追踪',
  '/inventory/resource-rights': '库存资源权益',
  '/inventory/transfer': '调拨管理',
  '/inventory/conversion': '拆装管理',
  '/purchase/request': '采购申请',
  '/purchase/supplier': '供应商管理',
  '/finance/daily': '日结单',
  '/finance/subsidy-receivable': '国补应收单',
  '/finance/rebate-settlement': '返利下账',
  '/finance/expense': '费用管理',
  '/finance/payable': '应付管理',
  '/finance/reimbursement': '报销结算',
  '/finance/payment': '付款管理',
  '/finance/settlement': '应付结算单管理',
  '/finance/freight': '运费管理',
  '/finance/rebate': '返利管理',
  '/finance/resource-rights': '资源权益核销与成本调整',
  '/finance/account': '账户中心',
  '/products/product': '商品管理',
  '/products/category': '分类管理',
  '/products/price': '价格管理',
  '/products/approval': '新建商品审批',
  '/stores': '门店管理',
  '/reports/dashboard': '经营数据看板',
  '/reports/sales': '销售报表',
  '/reports/inventory': '库存报表',
  '/reports/employee': '员工业绩统计',
  '/reports/achievement': '业务达成',
  '/sales/monthly-tasks': '月度任务',
  '/approval/tasks': '待我审批',
  '/approval/instances': '我的申请',
  '/approval/flows': '流程配置',
  '/system/users': '用户管理',
  '/system/roles': '角色管理',
  '/system/menus': '菜单管理',
  '/system/locations': '库位管理',
  '/system/resource-categories': '货型配置',
  '/system/customer-source': '客户来源管理',
  '/system/payment-method': '收款方式管理',
  '/system/supplement-item': '金额补录项目管理',
  '/system/expense-type': '报销类型管理',
  '/system/category-field': '商品字段管理'
}

const pageTitle = computed(() => pageTitles[route.path] || '')
const sidebarWidth = computed(() => sidebarCollapsed.value ? '72px' : '224px')
const userInitial = computed(() => String(userName.value || 'A').trim().slice(0, 1).toUpperCase())

onMounted(async () => {
  let userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')

  // 菜单权限在登录响应中会缓存；菜单结构发生迁移后，进入布局时主动刷新一次，
  // 避免用户继续使用旧的一级菜单缓存。
  if (localStorage.getItem('token')) {
    try {
      const response = await api.getUserInfo()
      if (response?.code === 0 && response.data) {
        userInfo = response.data
        localStorage.setItem('userInfo', JSON.stringify(userInfo))
      }
    } catch (error) {
      // 保留缓存作为离线/接口暂时不可用时的兜底；401 会由 API 拦截器跳转登录。
      console.warn('刷新菜单权限失败，继续使用本地缓存', error)
    }
  }

  const menus = userInfo.menus || []
  const hasValidMenu = menus.length > 0

  if (!hasValidMenu) {
    localStorage.removeItem('token')
    localStorage.removeItem('userInfo')
    window.location.href = '/login'
    return
  }
  userName.value = isSalesQueryOnly(userInfo) ? String(userInfo.name || '用户').replace(/[（(]商场查询[）)]/g, '') : (userInfo.name || '管理员')
  roleName.value = isSalesQueryOnly(userInfo) ? '门店查询' : (userInfo.roleName || '')
  menuTree.value = isSalesQueryOnly(userInfo)
    ? getManagerMirrorMenus()
    : buildMenuTree(menus)
})

function getManagerMirrorMenus() {
  return [
    { menuCode: 'home', name: '首页', path: '/', icon: 'House' },
    { menuCode: 'sales', name: '销售管理', icon: 'Sell', children: [
      { menuCode: 'sales_order', name: '业绩查询', path: '/sales/order' },
      { menuCode: 'sales_subsidy_photos', name: '国补照片', path: '/sales/subsidy-photos' },
      { menuCode: 'sales_monthly_tasks', name: '月度任务', path: '/sales/monthly-tasks' }
    ] },
    { menuCode: 'inventory', name: '库存管理', icon: 'Box', children: [
      { menuCode: 'inventory_summary', name: '库存汇总', path: '/inventory/summary' },
      { menuCode: 'inventory_sn_inventory', name: 'SN库存清单', path: '/inventory/sn-inventory' },
      { menuCode: 'inventory_batch_maintenance', name: '批量维护', path: '/inventory/batch-maintenance' },
      { menuCode: 'inventory_inbound', name: '入库单管理', path: '/inventory/inbound' },
      { menuCode: 'inventory_sn_trace', name: 'SN追踪', path: '/inventory/sn-trace' },
      { menuCode: 'inventory_resource_rights', name: '库存资源权益', path: '/inventory/resource-rights' },
      { menuCode: 'inventory_transfer', name: '调拨管理', path: '/inventory/transfer' },
      { menuCode: 'inventory_conversion', name: '拆装管理', path: '/inventory/conversion' }
    ] },
    { menuCode: 'products', name: '商品管理', icon: 'Goods', children: [
      { menuCode: 'product_product', name: '商品管理', path: '/products/product' },
      { menuCode: 'product_category', name: '分类管理', path: '/products/category' },
      { menuCode: 'product_price', name: '价格管理', path: '/products/price' },
      { menuCode: 'product_approval', name: '新建商品审批', path: '/products/approval' }
    ] },
    { menuCode: 'stores', name: '门店管理', path: '/stores', icon: 'Shop' },
    { menuCode: 'reports', name: '报表统计', icon: 'DataAnalysis', children: [
      { menuCode: 'reports_dashboard', name: '经营数据看板', path: '/reports/dashboard' },
      { menuCode: 'reports_sales', name: '销售报表', path: '/reports/sales' },
      { menuCode: 'reports_inventory', name: '库存报表', path: '/reports/inventory' },
      { menuCode: 'reports_employee', name: '员工业绩统计', path: '/reports/employee' },
      { menuCode: 'reports_achievement', name: '业务达成', path: '/reports/achievement' }
    ] },
    { menuCode: 'approval', name: '审批中心', icon: 'Checked', children: [
      { menuCode: 'approval_tasks', name: '待我审批', path: '/approval/tasks' },
      { menuCode: 'approval_instances', name: '我的申请', path: '/approval/instances' }
    ] },
    { menuCode: 'system', name: '系统管理', path: '/system/users', icon: 'Setting' }
  ]
}

function getDefaultMenus() {
  return [
    { menuCode: 'home', name: '首页', path: '/', icon: 'House' },
    { menuCode: 'sales', name: '销售管理', path: '/sales', icon: 'Sell' },
    { menuCode: 'inventory', name: '库存管理', path: '/inventory', icon: 'Box' },
    { menuCode: 'finance', name: '财务管理', path: '/finance', icon: 'Money' },
    { menuCode: 'reports', name: '报表统计', path: '/reports', icon: 'DataAnalysis' }
  ]
}

function buildMenuTree(menus) {
  const stringFields = ['menuCode', 'name', 'path', 'icon', 'menuType']
  const flat = menus.map(m => {
    const item = {}
    // Handle both camelCase (from DB) and original format
    item.menuId = m.menu_id || m.menuId || ''
    item.menuCode = m.menu_code || m.menuCode || ''
    item.name = m.name || ''
    item.path = m.path || ''
    item.icon = m.icon || ''
    item.menuType = m.menu_type || m.menuType || ''
    item.children = m.children ? buildMenuTree(m.children) : []
    return item
  })
  return flat
}

const handleCommand = async (command) => {
  if (command === 'logout') {
    try {
      await ElMessageBox.confirm('确定退出登录吗？', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      })
      localStorage.removeItem('token')
      localStorage.removeItem('userInfo')
      router.push('/login')
    } catch {}
  } else if (command === 'changePassword') {
    passwordDialogVisible.value = true
  }
}

function resetPasswordForm() {
  passwordFormRef.value?.resetFields()
  passwordForm.oldPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
}

async function submitPasswordChange() {
  if (passwordSubmitting.value) return

  try {
    await passwordFormRef.value.validate()
  } catch {
    return
  }

  if (passwordForm.oldPassword === passwordForm.newPassword) {
    ElMessage.warning('新密码不能与旧密码相同')
    return
  }

  passwordSubmitting.value = true
  try {
    const res = await api.changePassword({
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword
    })
    ElMessage.success(res.message || '密码修改成功')
    passwordDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '密码修改失败')
  } finally {
    passwordSubmitting.value = false
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
  min-width: 1024px;
  background: var(--erp-canvas);
}

.layout-container > .el-container {
  min-width: 0;
}

.sidebar {
  position: relative;
  z-index: 2;
  background: var(--erp-sidebar);
  overflow-y: auto;
  overflow-x: hidden;
  transition: width .2s ease;
}

.sidebar-menu {
  border-right: none !important;
}

.sidebar-menu:not(.el-menu--collapse) {
  width: 224px;
}

.logo {
  position: sticky;
  top: 0;
  z-index: 3;
  height: 72px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 18px;
  background: var(--erp-sidebar);
  border-bottom: 1px solid rgba(255, 255, 255, .08);
}

.logo-mark {
  display: inline-flex;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: #fff;
  background: var(--erp-primary);
  font-size: 18px;
  font-weight: 750;
}

.logo-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  line-height: 1.25;
}

.logo-copy strong { color: #fff; font-size: 16px; letter-spacing: .02em; }
.logo-copy span { margin-top: 4px; color: #98a2b3; font-size: 11px; white-space: nowrap; }

.is-sidebar-collapsed .logo { justify-content: center; padding: 0; }

.header {
  height: 72px;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, .96);
  border-bottom: 1px solid var(--erp-border-soft);
  box-shadow: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.sidebar-toggle {
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  color: #667085;
  background: #fff;
  cursor: pointer;
  transition: .15s ease;
}

.sidebar-toggle:hover { color: var(--erp-primary); border-color: #b9cdfd; background: var(--erp-primary-soft); }

.title-stack { display: flex; flex-direction: column; }
.title-context { color: #98a2b3; font-size: 11px; line-height: 16px; }
.page-title { color: var(--erp-text); font-size: 18px; font-weight: 650; line-height: 26px; }

.main-content {
  min-width: 0;
  padding: 20px 24px 28px;
  overflow: auto;
  background: var(--erp-canvas);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.role-tag {
  font-size: 12px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 126px;
  padding: 6px 9px 6px 7px;
  border-radius: 9px;
  cursor: pointer;
  outline: none;
  transition: background .15s ease;
}

.user-info:hover { background: #f7f9fc; }
.user-avatar { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; border-radius: 9px; color: #fff; background: #344054; font-size: 13px; font-weight: 650; }
.user-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; line-height: 1.2; }
.user-copy strong { max-width: 110px; overflow: hidden; color: #344054; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.user-copy small { margin-top: 3px; color: #98a2b3; font-size: 10px; }
.user-chevron { color: #98a2b3; font-size: 12px; }

@media (max-width: 1280px) {
  .header { padding-inline: 18px; }
  .main-content { padding: 16px 18px 24px; }
  .role-tag { display: none; }
}
</style>

<style>
.sidebar-menu {
  padding: 12px 10px 20px;
  background-color: var(--erp-sidebar) !important;
}

.sidebar-menu.el-menu--collapse { width: 72px; padding-inline: 8px; }
.sidebar-menu.el-menu--collapse .el-menu-item,
.sidebar-menu.el-menu--collapse .el-sub-menu__title { padding: 0 16px !important; }

.sidebar-menu .el-menu-item {
  height: 44px;
  margin: 3px 0;
  border-radius: 8px;
  color: #b7c0ce;
  background-color: transparent !important;
  font-size: 13px;
}

.sidebar-menu .el-menu-item:hover {
  background-color: var(--erp-sidebar-hover) !important;
  color: #fff !important;
}

.sidebar-menu .el-menu-item.is-active {
  background-color: var(--erp-primary) !important;
  color: #fff !important;
  font-weight: 600;
}

.sidebar-menu .el-sub-menu__title {
  height: 44px;
  margin: 3px 0;
  border-radius: 8px;
  color: #b7c0ce !important;
  background-color: transparent !important;
  font-size: 13px;
}

.sidebar-menu .el-sub-menu__title:hover {
  background-color: var(--erp-sidebar-hover) !important;
  color: #fff !important;
}

.sidebar-menu .el-menu { background: transparent !important; }
.sidebar-menu .el-sub-menu .el-menu-item { padding-left: 48px !important; color: #98a2b3; }
.sidebar-menu .el-icon { font-size: 17px; }
</style>
