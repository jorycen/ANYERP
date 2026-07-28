<template>
  <el-container class="layout-container">
    <el-aside width="200px" class="sidebar">
      <div class="logo">
        <h2>ANY-ERP</h2>
      </div>
      <el-menu
        :default-active="activeMenu"
        class="sidebar-menu"
        :router="true"
      >
        <template v-for="menu in menuTree" :key="menu.menuCode">
          <el-sub-menu v-if="menu.children && menu.children.length" :index="menu.menuCode">
            <template #title>
              <el-icon><component :is="iconMap[menu.icon] || House" /></el-icon>
              <span>{{ menu.name }}</span>
            </template>
            <el-menu-item
              v-for="child in menu.children"
              :key="child.menuCode"
              :index="child.path"
            >
              <span>{{ child.name }}</span>
            </el-menu-item>
          </el-sub-menu>
          <el-menu-item v-else :index="menu.path">
            <el-icon><component :is="iconMap[menu.icon] || House" /></el-icon>
            <span>{{ menu.name }}</span>
          </el-menu-item>
        </template>
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
        <router-view />
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
import {
  House, Sell, Box, ShoppingCart, Money, Goods,
  Shop, DataAnalysis, Setting, User, Checked
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()

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

const activeMenu = computed(() => {
  if (route.path.startsWith('/finance')) return '/finance'
  return route.path
})

const pageTitles = {
  '/': '首页',
  '/sales': '销售管理',
  '/sales/subsidy-photos': '国补照片',
  '/inventory': '库存管理',
  '/purchase': '采购管理',
  '/finance': '财务管理',
  '/finance/payment': '付款管理',
  '/finance/settlement': '应付结算单管理',
  '/products': '商品管理',
  '/stores': '门店管理',
  '/reports': '报表统计',
  '/system': '系统设置'
}

const pageTitle = computed(() => route.path === '/approval' ? '审批中心' : (pageTitles[route.path] || ''))

const validPaths = ['/', '/sales', '/sales/subsidy-photos', '/inventory', '/purchase', '/finance', '/finance/payment', '/finance/settlement', '/payment-management', '/products', '/stores', '/reports', '/system', '/approval']

onMounted(() => {
  const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
  const menus = userInfo.menus || []
  const hasValidMenu = menus.length > 0 && menus.every(m => validPaths.includes(m.path || ''))

  if (!hasValidMenu) {
    localStorage.removeItem('token')
    localStorage.removeItem('userInfo')
    window.location.href = '/login'
    return
  }
  userName.value = userInfo.name || '管理员'
  roleName.value = userInfo.roleName || ''
  menuTree.value = stripPaymentManagementMenu(buildMenuTree(menus))
})

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

function stripPaymentManagementMenu(menus) {
  return menus
    .filter(menu => menu.path !== '/payment-management' && menu.path !== '/finance/payment' && menu.menuCode !== 'paymentManagement')
    .map(menu => ({
      ...menu,
      children: stripPaymentManagementMenu(menu.children || [])
    }))
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
