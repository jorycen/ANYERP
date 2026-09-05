<template>
  <el-container class="layout-container">
    <el-aside width="200px" class="sidebar">
      <div class="logo">
        <h2>ANY-ERP</h2>
      </div>
      <el-menu
        :default-active="activeMenu"
        :default-openeds="openedMenus"
        class="sidebar-menu"
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
          <span class="page-title">{{ pageTitle }}</span>
        </div>
        <div class="header-right">
          <span class="role-tag">
            <el-tag size="small" effect="plain">{{ roleName }}</el-tag>
          </span>
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <el-icon><User /></el-icon>
              {{ userName }}
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
            type="text"
            autocomplete="current-password"
            placeholder="请输入旧密码"
            @keyup.enter="submitPasswordChange"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="passwordForm.newPassword"
            type="text"
            autocomplete="new-password"
            placeholder="请输入至少 6 位的新密码"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="passwordForm.confirmPassword"
            type="text"
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
  Shop, DataAnalysis, Setting, User, Checked
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const queryOnly = isSalesQueryOnly()

const userName = ref('')
const roleName = ref('')
const menuTree = ref([])
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
}

.layout-container > .el-container {
  min-width: 0;
}

.sidebar {
  background: #304156;
  overflow-y: auto;
}

.sidebar-menu {
  border-right: none !important;
}

.sidebar-menu:not(.el-menu--collapse) {
  width: 200px;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #243444;
}

.logo h2 {
  color: #fff;
  font-size: 18px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.main-content {
  min-width: 0;
  overflow: auto;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.role-tag {
  font-size: 12px;
}

.page-title {
  font-size: 16px;
  font-weight: 500;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.main-content {
  background: #f5f7fa;
  padding: 20px;
}
</style>

<style>
.sidebar-menu {
  background-color: #304156 !important;
}

.sidebar-menu .el-menu-item {
  color: #bfcbd9;
  background-color: #304156 !important;
}

.sidebar-menu .el-menu-item:hover {
  background-color: #263445 !important;
  color: #409eff !important;
}

.sidebar-menu .el-menu-item.is-active {
  background-color: #263445 !important;
  color: #409eff !important;
}

.sidebar-menu .el-sub-menu__title {
  color: #bfcbd9 !important;
  background-color: #304156 !important;
}

.sidebar-menu .el-sub-menu__title:hover {
  background-color: #263445 !important;
  color: #409eff !important;
}
</style>
