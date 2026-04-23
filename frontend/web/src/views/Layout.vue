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
        <el-menu-item index="/">
          <el-icon><House /></el-icon>
          <span>首页</span>
        </el-menu-item>
        <el-menu-item index="/sales">
          <el-icon><Sell /></el-icon>
          <span>销售管理</span>
        </el-menu-item>
        <el-menu-item index="/inventory">
          <el-icon><Box /></el-icon>
          <span>库存管理</span>
        </el-menu-item>
        <el-menu-item index="/purchase">
          <el-icon><ShoppingCart /></el-icon>
          <span>采购管理</span>
        </el-menu-item>
        <el-menu-item index="/finance">
          <el-icon><Money /></el-icon>
          <span>财务管理</span>
        </el-menu-item>
        <el-menu-item index="/products">
          <el-icon><Goods /></el-icon>
          <span>商品管理</span>
        </el-menu-item>
        <el-menu-item index="/stores">
          <el-icon><Shop /></el-icon>
          <span>门店管理</span>
        </el-menu-item>
        <el-menu-item index="/reports">
          <el-icon><DataAnalysis /></el-icon>
          <span>报表统计</span>
        </el-menu-item>
        <el-menu-item index="/system">
          <el-icon><Setting /></el-icon>
          <span>系统设置</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <span class="page-title">{{ pageTitle }}</span>
        </div>
        <div class="header-right">
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
  </el-container>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  House, Sell, Box, ShoppingCart, Money, Goods,
  Shop, DataAnalysis, Setting, User
} from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()

const userName = ref('')

const activeMenu = computed(() => route.path)

const pageTitles = {
  '/': '首页',
  '/sales': '销售管理',
  '/inventory': '库存管理',
  '/purchase': '采购管理',
  '/finance': '财务管理',
  '/products': '商品管理',
  '/stores': '门店管理',
  '/reports': '报表统计',
  '/system': '系统设置'
}

const pageTitle = computed(() => pageTitles[route.path] || '')

onMounted(() => {
  const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
  userName.value = userInfo.name || '管理员'
})

const handleCommand = (command) => {
  if (command === 'logout') {
    ElMessageBox.confirm('确定退出登录吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      localStorage.removeItem('token')
      localStorage.removeItem('userInfo')
      router.push('/login')
    }).catch(() => {})
  } else if (command === 'changePassword') {
    ElMessage.info('修改密码功能开发中')
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
}

.sidebar {
  background: #304156;
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

.sidebar-menu {
  border-right: none;
  background: transparent;
}

.sidebar-menu .el-menu-item {
  color: #bfcbd9;
}

.sidebar-menu .el-menu-item:hover,
.sidebar-menu .el-menu-item.is-active {
  background: #263445;
  color: #409eff;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
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
