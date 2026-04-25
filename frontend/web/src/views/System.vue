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

    <!-- 编辑用户对话框 -->
    <el-dialog v-model="userDialogVisible" :title="dialogTitle" width="500px" @close="handleDialogClose">
      <el-form :model="userForm" label-width="100px">
        <el-form-item label="姓名" required>
          <el-input v-model="userForm.name" placeholder="请输入姓名" />
        </el-form-item>
        <el-form-item label="手机号" required>
          <el-input v-model="userForm.phone" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-select v-model="userForm.roleCode" placeholder="请选择角色" style="width: 100%">
            <el-option v-for="r in roleData" :key="r.role_id" :label="r.name" :value="r.role_code" />
          </el-select>
        </el-form-item>
        <el-form-item label="门店">
          <el-select v-model="userForm.storeId" placeholder="请选择门店" clearable style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="userForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleUserSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 分配区域对话框 -->
    <el-dialog v-model="regionDialogVisible" title="分配区域" width="500px">
      <el-form label-width="100px">
        <el-form-item label="用户">{{ currentUser?.name }}</el-form-item>
        <el-form-item label="可访问门店">
          <el-checkbox-group v-model="selectedStores">
            <el-checkbox v-for="s in stores" :key="s.store_id" :label="s.store_id">{{ s.name }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="regionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleRegionSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 角色菜单权限对话框 -->
    <el-dialog v-model="menuDialogVisible" title="菜单权限" width="400px">
      <el-form label-width="100px">
        <el-form-item label="角色">{{ currentRole?.name }}</el-form-item>
        <el-form-item label="菜单权限">
          <el-tree
            ref="menuTreeRef"
            :data="menuData"
            :props="{ label: 'name', children: 'children' }"
            show-checkbox
            node-key="menu_id"
            default-expand-all
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="menuDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleMenuSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('users')
const userData = ref([])
const roleData = ref([])
const menuData = ref([])
const stores = ref([])

const userDialogVisible = ref(false)
const regionDialogVisible = ref(false)
const menuDialogVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新增用户')
const currentUser = ref(null)
const currentRole = ref(null)
const selectedStores = ref([])
const menuTreeRef = ref(null)

const userForm = reactive({
  staffId: null,
  name: '',
  phone: '',
  roleCode: '',
  storeId: '',
  status: 1
})

onMounted(() => {
  loadUsers()
  loadRoles()
  loadMenus()
  loadStores()
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

const loadStores = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) stores.value = res.data || []
  } catch (err) { console.error('Failed to load stores') }
}

const handleAddUser = () => {
  dialogTitle.value = '新增用户'
  resetUserForm()
  userDialogVisible.value = true
}

const handleEditUser = (row) => {
  dialogTitle.value = '编辑用户'
  currentUser.value = row
  userForm.staffId = row.staff_id
  userForm.name = row.name
  userForm.phone = row.phone
  userForm.roleCode = row.role_code
  userForm.storeId = row.store_id || ''
  userForm.status = row.status
  userDialogVisible.value = true
}

const handleAssignRegion = async (row) => {
  currentUser.value = row
  selectedStores.value = []
  try {
    const res = await api.getUserRegions(row.staff_id)
    if (res.code === 0) {
      selectedStores.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load user regions')
  }
  regionDialogVisible.value = true
}

const handleRoleMenus = async (row) => {
  currentRole.value = row
  try {
    const res = await api.getRoleMenus(row.role_id)
    if (res.code === 0) {
      const menuIds = res.data || []
      menuTreeRef.value?.setCheckedKeys(menuIds)
    }
  } catch (err) {
    console.error('Failed to load role menus')
  }
  menuDialogVisible.value = true
}

const handleUserSubmit = async () => {
  if (!userForm.name) {
    ElMessage.warning('请输入姓名')
    return
  }
  if (!userForm.phone) {
    ElMessage.warning('请输入手机号')
    return
  }
  if (!userForm.roleCode) {
    ElMessage.warning('请选择角色')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      name: userForm.name,
      phone: userForm.phone,
      roleCode: userForm.roleCode,
      storeId: userForm.storeId,
      status: userForm.status
    }
    const res = await api.updateUserRoles(userForm.staffId, data)
    if (res.code === 0) {
      ElMessage.success('保存成功')
      userDialogVisible.value = false
      loadUsers()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败')
  } finally {
    submitLoading.value = false
  }
}

const handleRegionSubmit = async () => {
  submitLoading.value = true
  try {
    const res = await api.assignUserRegions(currentUser.value.staff_id, {
      storeIds: selectedStores.value
    })
    if (res.code === 0) {
      ElMessage.success('分配成功')
      regionDialogVisible.value = false
    } else {
      ElMessage.error(res.message || '分配失败')
    }
  } catch (err) {
    ElMessage.error('分配失败')
  } finally {
    submitLoading.value = false
  }
}

const handleMenuSubmit = async () => {
  const checkedKeys = menuTreeRef.value?.getCheckedKeys() || []
  submitLoading.value = true
  try {
    const res = await api.assignMenus(currentRole.value.role_id, {
      menuIds: checkedKeys
    })
    if (res.code === 0) {
      ElMessage.success('分配成功')
      menuDialogVisible.value = false
    } else {
      ElMessage.error(res.message || '分配失败')
    }
  } catch (err) {
    ElMessage.error('分配失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetUserForm()
}

const resetUserForm = () => {
  userForm.staffId = null
  userForm.name = ''
  userForm.phone = ''
  userForm.roleCode = ''
  userForm.storeId = ''
  userForm.status = 1
}
</script>

<style scoped>
.filter-bar {
  margin-bottom: 16px;
}
</style>
