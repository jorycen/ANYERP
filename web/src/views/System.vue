<template>
  <div class="system-page">
    <el-card>
      <template #header>
        <span>系统设置</span>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="用户管理" name="users">
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddUser">新增用户</el-button>
          </div>

          <el-table :data="userData" stripe border>
            <el-table-column prop="staff_id" label="ID" width="80" />
            <el-table-column prop="name" label="姓名" width="120" />
            <el-table-column prop="phone" label="手机号" width="130" />
            <el-table-column prop="role_code" label="角色" width="100">
              <template #default="{ row }">
                <el-tag>{{ row.role_code }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditUser(row)">编辑</el-button>
                <el-button link type="primary" @click="handleAssignRegion(row)">分配区域</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="角色管理" name="roles">
          <el-table :data="roleData" stripe border>
            <el-table-column prop="role_id" label="ID" width="80" />
            <el-table-column prop="name" label="角色名称" width="120" />
            <el-table-column prop="role_code" label="角色代码" width="120" />
            <el-table-column prop="description" label="描述" min-width="150" />
            <el-table-column prop="is_system" label="系统角色" width="100">
              <template #default="{ row }">
                <el-tag :type="row.is_system ? 'warning' : 'info'">{{ row.is_system ? '是' : '否' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleRoleMenus(row)">菜单权限</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="菜单管理" name="menus">
          <el-tree :data="menuData" :props="{ label: 'name', children: 'children' }" default-expand-all>
            <template #default="{ data }">
              <span>{{ data.name }} ({{ data.menu_code }})</span>
            </template>
          </el-tree>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('users')
const userData = ref([])
const roleData = ref([])
const menuData = ref([])

onMounted(() => {
  loadUsers()
  loadRoles()
  loadMenus()
})

const loadUsers = async () => {
  try {
    const res = await api.getUsers()
    if (res.code === 0) userData.value = res.data || []
  } catch (err) { ElMessage.error('加载用户失败') }
}

const loadRoles = async () => {
  try {
    const res = await api.getRoles()
    if (res.code === 0) roleData.value = res.data || []
  } catch (err) { ElMessage.error('加载角色失败') }
}

const loadMenus = async () => {
  try {
    const res = await api.getMenus()
    if (res.code === 0) menuData.value = res.data || []
  } catch (err) { ElMessage.error('加载菜单失败') }
}

const handleAddUser = () => ElMessage.info('新增用户功能开发中')
const handleEditUser = (row) => ElMessage.info('编辑用户: ' + row.name)
const handleAssignRegion = (row) => ElMessage.info('分配区域: ' + row.name)
const handleRoleMenus = (row) => ElMessage.info('菜单权限: ' + row.name)
</script>

<style scoped>
.filter-bar {
  margin-bottom: 16px;
}
</style>
