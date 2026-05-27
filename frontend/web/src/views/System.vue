<template>
  <div class="system-page">
    <el-card>
      <template #header>
        <span>系统设置</span>
      </template>

      <el-tabs v-model="activeTab" @tab-change="onSysTabChange">
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
                <el-button link type="primary" @click="handleAssignStore(row)">分配门店</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="角色管理" name="roles">
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddRole">新增角色</el-button>
          </div>
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
            <el-table-column label="操作" width="220">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleRoleMenus(row)">菜单权限</el-button>
                <el-button link type="primary" :disabled="!!row.is_system" @click="handleEditRole(row)">编辑</el-button>
                <el-button link type="danger" :disabled="!!row.is_system" @click="handleDeleteRole(row)">删除</el-button>
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

        <el-tab-pane label="客户来源管理" name="customerSource">
          <div class="filter-bar">
            <el-button type="primary" @click="openCustomerSourceDialog()">新增一级来源</el-button>
          </div>
          <el-table :data="customerSourceData" stripe border row-key="source_id" v-loading="csLoading">
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="一级来源" min-width="180" />
            <el-table-column label="二级来源" min-width="300">
              <template #default="{ row }">
                <el-tag v-for="child in row.children" :key="child.source_id" class="mr-1 mb-1">
                  {{ child.sort_order }}. {{ child.name }}
                </el-tag>
                <el-button link type="primary" size="small" @click="openCustomerSourceDialog(null, row.source_id)" class="ml-1">
                  + 添加二级
                </el-button>
                <span v-if="!row.children || row.children.length === 0" class="text-muted">暂无</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220">
              <template #default="{ row, $index }">
                <el-button link type="primary" @click="moveUpCustomerSource($index)" :disabled="$index === 0">上移</el-button>
                <el-button link type="primary" @click="moveDownCustomerSource($index)" :disabled="$index === customerSourceData.length - 1">下移</el-button>
                <el-button link type="primary" @click="openCustomerSourceDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteCustomerSource(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-dialog v-model="csChildrenDialog" :title="`${csCurrentParent?.name || ''} 的二级来源`" width="600px">
            <el-table :data="csCurrentChildren" stripe border size="small">
              <el-table-column prop="sort_order" label="排序" width="60" />
              <el-table-column prop="name" label="名称" min-width="200" />
              <el-table-column label="操作" width="180">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openCustomerSourceDialog(row)">编辑</el-button>
                  <el-button link type="danger" @click="handleDeleteCustomerSource(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-dialog>
        </el-tab-pane>

        <el-tab-pane label="收款方式管理" name="paymentMethod">
          <div class="filter-bar">
            <el-button type="primary" @click="openPaymentMethodDialog()">新增收款方式</el-button>
          </div>
          <el-table :data="paymentMethodData" stripe border>
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="名称" width="160" />
            <el-table-column label="配置范围" width="120">
              <template #default="{ row }">
                <el-tag :type="row.is_global === 1 || row.is_global === true ? 'success' : 'warning'" size="small">
                  {{ row.is_global === 1 || row.is_global === true ? '全局' : '按门店' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="结算账号" min-width="200">
              <template #default="{ row }">
                <span v-if="row.is_global === 1 || row.is_global === true">
                  <span v-if="row.SettlementAccount">{{ row.SettlementAccount.account_name }}</span>
                  <span v-else class="text-muted">未绑定</span>
                </span>
                <span v-else>
                  <el-tag v-for="s in (row.Stores || [])" :key="s.store_id" size="small" class="mr-1 mb-1">
                    {{ s.name }}{{ s.PaymentMethodStore?.settlement_account_id ? '→' + (s.PaymentMethodStore?.SettlementAccount?.account_name || '?') : '' }}
                  </el-tag>
                  <span v-if="!row.Stores || row.Stores.length === 0" class="text-muted">未配置门店</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row, $index }">
                <el-button link type="primary" @click="moveUpPaymentMethod($index)" :disabled="$index === 0">上移</el-button>
                <el-button link type="primary" @click="moveDownPaymentMethod($index)" :disabled="$index === paymentMethodData.length - 1">下移</el-button>
                <el-button link type="primary" @click="openPaymentMethodDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeletePaymentMethod(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="金额补录项目管理" name="supplementItem">
          <div class="filter-bar">
            <el-button type="primary" @click="openSupplementItemDialog()">新增项目</el-button>
          </div>
          <el-table :data="supplementItemData" stripe border>
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="名称" min-width="200" />
            <el-table-column prop="amount" label="默认金额" width="120">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{ row, $index }">
                <el-button link type="primary" @click="moveUpSupplementItem($index)" :disabled="$index === 0">上移</el-button>
                <el-button link type="primary" @click="moveDownSupplementItem($index)" :disabled="$index === supplementItemData.length - 1">下移</el-button>
                <el-button link type="primary" @click="openSupplementItemDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteSupplementItem(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 商品字段管理 -->
        <el-tab-pane label="商品字段管理" name="categoryField">
          <div style="display: flex; gap: 20px;">
            <div style="width: 220px; flex-shrink: 0;">
              <el-input v-model="cfSearch" placeholder="搜索分类" size="small" clearable style="margin-bottom: 8px;" />
              <el-tree :data="cfCategoryTree" :props="{ label: 'name', children: 'children' }"
                node-key="category_id" highlight-current :filter-node-method="cfFilterNode"
                ref="cfTreeRef" @node-click="cfNodeClick" style="max-height: 500px; overflow: auto;" />
            </div>
            <div style="flex: 1;">
              <div v-if="cfSelectedCatId" style="margin-bottom: 8px;">
                <strong>当前分类：{{ cfSelectedCatName }}</strong>
                <el-button type="primary" size="small" style="float: right;" @click="cfAddField">新增字段</el-button>
              </div>
              <el-empty v-if="!cfSelectedCatId" description="请先在左侧选择一个分类" />
              <el-table v-else :data="cfFields" stripe border size="small">
                <el-table-column prop="field_label" label="字段名" width="100" />
                <el-table-column prop="field_key" label="标识" width="100" />
                <el-table-column prop="field_type" label="类型" width="80">
                  <template #default="{ row }">{{ row.field_type === 'select' ? '下拉框' : '文本框' }}</template>
                </el-table-column>
                <el-table-column label="选项(下拉框用)" min-width="140">
                  <template #default="{ row }">
                    <span v-if="row.field_type === 'select'">{{ (row.field_options ? JSON.parse(row.field_options) : []).join(', ') }}</span>
                    <span v-else style="color: #ccc;">—</span>
                  </template>
                </el-table-column>
                <el-table-column prop="field_placeholder" label="提示词" min-width="120" show-overflow-tooltip />
                <el-table-column prop="required" label="必填" width="60">
                  <template #default="{ row }">{{ row.required ? '是' : '否' }}</template>
                </el-table-column>
                <el-table-column label="操作" width="160">
                  <template #default="{ row, $index }">
                    <el-button link type="primary" @click="cfMoveField($index, -1)" :disabled="$index === 0">上移</el-button>
                    <el-button link type="primary" @click="cfMoveField($index, 1)" :disabled="$index === cfFields.length - 1">下移</el-button>
                    <el-button link type="primary" @click="cfEditField(row)">编辑</el-button>
                    <el-button link type="danger" @click="cfDeleteField(row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <div v-if="cfSelectedCatId && cfFields.length > 0" style="margin-top: 12px;">
                <el-button type="success" :loading="cfSaving" @click="cfSave">保存配置</el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新增/编辑用户对话框 -->
    <el-dialog v-model="userDialogVisible" :title="dialogTitle" width="600px" @close="resetUserForm">
      <el-form :model="userForm" label-width="100px">
        <el-form-item label="姓名" required>
          <el-input v-model="userForm.name" placeholder="请输入姓名" />
        </el-form-item>
        <el-form-item label="手机号" required>
          <el-input v-model="userForm.phone" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item v-if="!userForm.staffId" label="初始密码" required>
          <el-input v-model="userForm.password" type="password" placeholder="请输入初始密码" />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-select v-model="userForm.roleCode" placeholder="请选择角色" style="width: 100%">
            <el-option v-for="r in roleData" :key="r.role_id" :label="r.name" :value="r.role_code" />
          </el-select>
        </el-form-item>
        <el-form-item label="门店">
          <div style="width: 100%">
            <el-checkbox :indeterminate="storeIndeterminate" :checked="storeCheckAll" @change="handleStoreCheckAll">
              全选
            </el-checkbox>
            <el-checkbox-group v-model="userForm.storeIds" style="margin-top: 8px">
              <el-checkbox v-for="s in stores" :key="s.store_id" :label="s.store_id">{{ s.name }}</el-checkbox>
            </el-checkbox-group>
          </div>
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

    <el-dialog v-model="customerSourceDialogVisible" :title="csDialogTitle" width="500px" @close="resetCsForm">
      <el-form :model="csForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="csForm.name" placeholder="请输入客户来源名称" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model="csForm.sortOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="customerSourceDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleCsSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="paymentMethodDialogVisible" :title="pmDialogTitle" width="700px" @close="resetPmForm">
      <el-form :model="pmForm" label-width="100px">
        <el-form-item label="名称" required>
          <el-input v-model="pmForm.name" placeholder="请输入收款方式名称" />
        </el-form-item>
        <el-form-item label="配置范围">
          <el-radio-group v-model="pmForm.isGlobal" @change="onPmIsGlobalChange">
            <el-radio :value="true">全局配置（所有门店共用默认结算账号）</el-radio>
            <el-radio :value="false">按门店配置（每个门店单独设置结算账号）</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="pmForm.isGlobal">
          <el-form-item label="默认结算账号">
            <div style="display: flex; align-items: center; gap: 8px; width: 100%">
              <el-select v-model="pmForm.settlementAccountId" placeholder="选择结算账号" clearable style="flex: 1">
                <el-option v-for="acc in settlementAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
              </el-select>
              <el-button link type="primary" @click="openSaMgmtDialog">管理结算账号</el-button>
            </div>
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item label="门店配置">
            <div style="width: 100%; max-height: 400px; overflow-y: auto; border: 1px solid #dcdfe6; border-radius: 4px; padding: 8px;">
              <el-table :data="pmStoreConfigRows" stripe border size="small">
                <el-table-column width="50" align="center">
                  <template #default="{ row }">
                    <el-checkbox v-model="row.checked" @change="onPmStoreChecked(row)" />
                  </template>
                </el-table-column>
                <el-table-column label="门店" width="160">
                  <template #default="{ row }">{{ row.name }}</template>
                </el-table-column>
                <el-table-column label="结算账号" min-width="200">
                  <template #default="{ row }">
                    <el-select v-model="row.accountId" placeholder="选择结算账号" clearable size="small" style="width: 100%" :disabled="!row.checked">
                      <el-option v-for="acc in settlementAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
                    </el-select>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-form-item>
        </template>

        <el-form-item label="排序">
          <el-input v-model="pmForm.sortOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="paymentMethodDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handlePmSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="saMgmtDialogVisible" title="结算账号管理" width="700px" @close="handleSaMgmtClose">
      <div style="margin-bottom: 12px">
        <el-button type="primary" @click="openSettlementAccountDialog(null)">新增结算账号</el-button>
      </div>
      <el-table :data="settlementAccountData" stripe border size="small">
        <el-table-column prop="sort_order" label="排序" width="60" />
        <el-table-column prop="account_name" label="账号名称" min-width="160" />
        <el-table-column prop="bank_name" label="开户行" width="140" />
        <el-table-column prop="account_number" label="账号" min-width="180" />
        <el-table-column label="操作" width="180">
          <template #default="{ row, $index }">
            <el-button link type="primary" @click="moveUpSa($index)" :disabled="$index === 0">上移</el-button>
            <el-button link type="primary" @click="moveDownSa($index)" :disabled="$index === settlementAccountData.length - 1">下移</el-button>
            <el-button link type="primary" @click="openSettlementAccountDialog(row)">编辑</el-button>
            <el-button link type="danger" @click="handleDeleteSa(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-dialog v-model="saFormDialogVisible" :title="saDialogTitle" width="500px" append-to-body @close="resetSaForm">
        <el-form :model="saForm" label-width="80px">
          <el-form-item label="账号名称" required>
            <el-input v-model="saForm.accountName" placeholder="请输入账号名称" />
          </el-form-item>
          <el-form-item label="开户行">
            <el-input v-model="saForm.bankName" placeholder="请输入开户行" />
          </el-form-item>
          <el-form-item label="账号">
            <el-input v-model="saForm.accountNumber" placeholder="请输入账号" />
          </el-form-item>
          <el-form-item label="排序">
            <el-input v-model="saForm.sortOrder" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="saFormDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="handleSaSubmit" :loading="submitLoading">确定</el-button>
        </template>
      </el-dialog>
    </el-dialog>

    <el-dialog v-model="supplementItemDialogVisible" :title="siDialogTitle" width="500px" @close="resetSiForm">
      <el-form :model="siForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="siForm.name" placeholder="请输入项目名称" />
        </el-form-item>
        <el-form-item label="默认金额">
          <el-input v-model="siForm.amount" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model="siForm.sortOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="supplementItemDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSiSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 分类字段编辑对话框 -->
    <el-dialog v-model="cfDialogVisible" :title="cfDialogTitle" width="500px" @close="cfResetFieldForm">
      <el-form :model="cfFieldForm" label-width="80px">
        <el-form-item label="字段名" required>
          <el-input v-model="cfFieldForm.field_label" placeholder="如：品牌" />
        </el-form-item>
        <el-form-item label="标识" required>
          <el-input v-model="cfFieldForm.field_key" placeholder="如：brand（拼音小写）" />
        </el-form-item>
        <el-form-item label="类型" required>
          <el-radio-group v-model="cfFieldForm.field_type">
            <el-radio value="text">文本框</el-radio>
            <el-radio value="select">下拉框</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="选项" v-if="cfFieldForm.field_type === 'select'">
          <div style="display: flex; gap: 6px; margin-bottom: 6px;">
            <el-input v-model="cfOptionInput" placeholder="输入选项后按回车" size="small" @keyup.enter="cfAddOption" />
            <el-button size="small" @click="cfAddOption">添加</el-button>
          </div>
          <el-tag v-for="(opt, idx) in cfFieldForm.options" :key="idx" closable @close="cfRemoveOption(idx)" style="margin: 2px;">{{ opt }}</el-tag>
        </el-form-item>
        <el-form-item label="提示词">
          <el-input v-model="cfFieldForm.placeholder" placeholder="如：请输入品牌名称" size="small" />
        </el-form-item>
        <el-form-item label="必填">
          <el-switch v-model="cfFieldForm.required" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cfDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="cfConfirmField">确定</el-button>
      </template>
    </el-dialog>

    <!-- 分配门店对话框 -->
    <el-dialog v-model="storeDialogVisible" title="分配门店" width="500px">
      <el-form label-width="100px">
        <el-form-item label="用户">{{ currentUser?.name }}</el-form-item>
        <el-form-item label="可访问门店">
          <el-checkbox :indeterminate="storeDialogIndeterminate" :checked="storeDialogCheckAll" @change="handleStoreDialogCheckAll">
            全选
          </el-checkbox>
          <el-checkbox-group v-model="dialogStoreIds" style="margin-top: 8px">
            <el-checkbox v-for="s in stores" :key="s.store_id" :label="s.store_id">{{ s.name }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="storeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleStoreDialogSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleDialogVisible" :title="roleDialogTitle" width="500px" @close="resetRoleForm">
      <el-form :model="roleForm" label-width="100px">
        <el-form-item label="角色名称" required>
          <el-input v-model="roleForm.name" placeholder="请输入角色名称" />
        </el-form-item>
        <el-form-item label="角色代码" required>
          <el-input v-model="roleForm.roleCode" placeholder="如：sales_lead" :disabled="!!roleForm.roleId" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleForm.description" type="textarea" :rows="3" placeholder="请输入角色说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleRoleSubmit" :loading="submitLoading">确定</el-button>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('users')
const userData = ref([])
const roleData = ref([])
const menuData = ref([])
const stores = ref([])

const userDialogVisible = ref(false)
const storeDialogVisible = ref(false)
const menuDialogVisible = ref(false)
const roleDialogVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新增用户')
const roleDialogTitle = ref('新增角色')
const currentUser = ref(null)
const currentRole = ref(null)
const dialogStoreIds = ref([])
const menuTreeRef = ref(null)

const userForm = reactive({
  staffId: null,
  name: '',
  phone: '',
  password: '',
  roleCode: '',
  storeIds: [],
  status: 1
})

const roleForm = reactive({
  roleId: null,
  name: '',
  roleCode: '',
  description: ''
})

const storeIndeterminate = computed(() => {
  const len = userForm.storeIds.length
  return len > 0 && len < stores.value.length
})
const storeCheckAll = computed(() => {
  return stores.value.length > 0 && userForm.storeIds.length === stores.value.length
})
const storeDialogIndeterminate = computed(() => {
  const len = dialogStoreIds.value.length
  return len > 0 && len < stores.value.length
})
const storeDialogCheckAll = computed(() => {
  return stores.value.length > 0 && dialogStoreIds.value.length === stores.value.length
})

function handleStoreCheckAll(checked) {
  userForm.storeIds = checked ? stores.value.map(s => s.store_id) : []
}
function handleStoreDialogCheckAll(checked) {
  dialogStoreIds.value = checked ? stores.value.map(s => s.store_id) : []
}

onMounted(() => {
  loadUsers()
  loadRoles()
  loadMenus()
  loadStores()
  loadCustomerSources()
})

const onSysTabChange = (tabName) => {
  if (tabName === 'customerSource' && customerSourceData.value.length === 0) loadCustomerSources()
  if (tabName === 'paymentMethod' && paymentMethodData.value.length === 0) loadPaymentMethods()
  if (tabName === 'supplementItem' && supplementItemData.value.length === 0) loadSupplementItems()
  if (tabName === 'categoryField' && cfCategoryTree.value.length === 0) cfLoadCategoryTree()
}

const loadUsers = async () => {
  try {
    const res = await api.getUsers()
    if (res.code === 0) userData.value = res.data?.list || []
  } catch (err) { ElMessage.error('加载用户失败') }
}

const loadRoles = async () => {
  try {
    const res = await api.getRoles()
    if (res.code === 0) roleData.value = res.data || []
  } catch (err) { ElMessage.error('加载角色失败') }
}

const handleAddRole = () => {
  roleDialogTitle.value = '新增角色'
  resetRoleForm()
  roleDialogVisible.value = true
}

const handleEditRole = (row) => {
  if (row.is_system) return
  roleDialogTitle.value = '编辑角色'
  roleForm.roleId = row.role_id
  roleForm.name = row.name || ''
  roleForm.roleCode = row.role_code || ''
  roleForm.description = row.description || ''
  roleDialogVisible.value = true
}

const handleRoleSubmit = async () => {
  if (!roleForm.name.trim()) { ElMessage.warning('请输入角色名称'); return }
  if (!roleForm.roleCode.trim()) { ElMessage.warning('请输入角色代码'); return }

  submitLoading.value = true
  try {
    const data = {
      name: roleForm.name.trim(),
      roleCode: roleForm.roleCode.trim(),
      description: roleForm.description.trim()
    }
    const res = roleForm.roleId
      ? await api.updateRole(roleForm.roleId, data)
      : await api.createRole(data)

    if (res.code === 0) {
      ElMessage.success(roleForm.roleId ? '更新成功' : '创建成功')
      roleDialogVisible.value = false
      await loadRoles()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '保存失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDeleteRole = async (row) => {
  if (row.is_system) return
  try {
    await ElMessageBox.confirm(`确认删除角色"${row.name}"？`, '确认删除', { type: 'warning' })
    const res = await api.deleteRole(row.role_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      await loadRoles()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || err.message || '删除失败')
    }
  }
}

const resetRoleForm = () => {
  roleForm.roleId = null
  roleForm.name = ''
  roleForm.roleCode = ''
  roleForm.description = ''
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
    if (res.code === 0) stores.value = res.data?.list || res.data || []
  } catch (err) { console.error('Failed to load stores') }
}

const handleAddUser = () => {
  dialogTitle.value = '新增用户'
  resetUserForm()
  userDialogVisible.value = true
}

const handleEditUser = async (row) => {
  dialogTitle.value = '编辑用户'
  currentUser.value = row
  userForm.staffId = row.staff_id
  userForm.name = row.name
  userForm.phone = row.phone
  userForm.password = ''
  userForm.roleCode = row.role_code
  userForm.status = row.status
  userForm.storeIds = []

  try {
    const res = await api.getUserRegions(row.staff_id)
    if (res.code === 0 && res.data?.storeIds) {
      userForm.storeIds = res.data.storeIds
    }
  } catch (err) {}

  userDialogVisible.value = true
}

const handleAssignStore = async (row) => {
  currentUser.value = row
  dialogStoreIds.value = []
  try {
    const res = await api.getUserRegions(row.staff_id)
    if (res.code === 0 && res.data?.storeIds) {
      dialogStoreIds.value = res.data.storeIds
    }
  } catch (err) {}
  storeDialogVisible.value = true
}

const handleRoleMenus = async (row) => {
  currentRole.value = row
  try {
    const res = await api.getRoleMenus(row.role_id)
    if (res.code === 0) {
      menuTreeRef.value?.setCheckedKeys(res.data || [])
    }
  } catch (err) {
    console.error('Failed to load role menus')
  }
  menuDialogVisible.value = true
}

const handleUserSubmit = async () => {
  if (!userForm.name) { ElMessage.warning('请输入姓名'); return }
  if (!userForm.phone) { ElMessage.warning('请输入手机号'); return }
  if (!userForm.staffId && !userForm.password) { ElMessage.warning('请输入初始密码'); return }
  if (!userForm.roleCode) { ElMessage.warning('请选择角色'); return }

  submitLoading.value = true
  try {
    const data = {
      name: userForm.name,
      phone: userForm.phone,
      roleCode: userForm.roleCode,
      storeIds: userForm.storeIds,
      status: userForm.status
    }

    let res
    if (userForm.staffId) {
      res = await api.updateUser(userForm.staffId, data)
    } else {
      data.password = userForm.password
      res = await api.createUser(data)
    }

    if (res.code === 0) {
      ElMessage.success('保存成功')
      userDialogVisible.value = false
      loadUsers()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存失败')
  } finally {
    submitLoading.value = false
  }
}

const handleStoreDialogSubmit = async () => {
  submitLoading.value = true
  try {
    const res = await api.assignUserRegions(currentUser.value.staff_id, {
      storeIds: dialogStoreIds.value
    })
    if (res.code === 0) {
      ElMessage.success('分配成功')
      storeDialogVisible.value = false
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

const resetUserForm = () => {
  userForm.staffId = null
  userForm.name = ''
  userForm.phone = ''
  userForm.password = ''
  userForm.roleCode = ''
  userForm.storeIds = []
  userForm.status = 1
}

// ==============================================
// 字典管理 - 客户来源（一级/二级）
// ==============================================
const customerSourceData = ref([])
const csLoading = ref(false)
const csChildrenDialog = ref(false)
const csCurrentParent = ref(null)
const csCurrentChildren = ref([])
const customerSourceDialogVisible = ref(false)
const csDialogTitle = ref('新增一级来源')
const editingCsId = ref(null)
const editingCsParentId = ref(null)
const csForm = reactive({ name: '', parentId: '', sortOrder: 0 })

const loadCustomerSources = async () => {
  csLoading.value = true
  try {
    const res = await api.getCustomerSourceTree()
    if (res.code === 0) customerSourceData.value = res.data || []
  } catch (err) { ElMessage.error('加载客户来源失败') }
  finally { csLoading.value = false }
}

const openCustomerSourceDialog = (row, parentId) => {
  if (parentId) {
    csDialogTitle.value = '新增二级来源'
    editingCsId.value = null
    editingCsParentId.value = parentId
    csForm.parentId = parentId
    csForm.name = ''
    csForm.sortOrder = 0
  } else if (row) {
    csDialogTitle.value = row.level === 1 ? '编辑一级来源' : '编辑二级来源'
    editingCsId.value = row.source_id
    editingCsParentId.value = row.parent_id || null
    csForm.name = row.name
    csForm.parentId = row.parent_id || ''
    csForm.sortOrder = row.sort_order || 0
  } else {
    csDialogTitle.value = '新增一级来源'
    editingCsId.value = null
    editingCsParentId.value = null
    csForm.name = ''
    csForm.parentId = ''
    csForm.sortOrder = (customerSourceData.value.length || 0) + 1
  }
  customerSourceDialogVisible.value = true
}

const handleCsSubmit = async () => {
  if (!csForm.name) { ElMessage.warning('请输入名称'); return }
  submitLoading.value = true
  try {
    let res
    const data = {
      name: csForm.name,
      parentId: csForm.parentId || null,
      sortOrder: csForm.sortOrder
    }
    if (editingCsId.value) {
      res = await api.updateCustomerSource(editingCsId.value, data)
    } else {
      res = await api.createCustomerSource(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingCsId.value ? '更新成功' : '创建成功')
      customerSourceDialogVisible.value = false
      loadCustomerSources()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    const msg = err?.response?.data?.message || err?.message || '操作失败'
    ElMessage.error(msg)
  } finally { submitLoading.value = false }
}

const handleDeleteCustomerSource = async (row) => {
  const msg = row.level === 1 && row.children?.length
    ? `删除"${row.name}"将同时删除其下所有二级来源，确认删除？`
    : `确认删除"${row.name}"？`
  try {
    await ElMessageBox.confirm(msg, '确认删除', { type: 'warning' })
    const res = await api.deleteCustomerSource(row.source_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadCustomerSources()
    } else { ElMessage.error(res.message || '删除失败') }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err?.response?.data?.message || err?.message || '删除失败'
      ElMessage.error(msg)
    }
  }
}

const moveUpCustomerSource = (index) => {
  if (index <= 0) return
  const list = [...customerSourceData.value]
  ;[list[index - 1], list[index]] = [list[index], list[index - 1]]
  customerSourceData.value = list
  saveCustomerSourceSort()
}

const moveDownCustomerSource = (index) => {
  const list = customerSourceData.value
  if (index >= list.length - 1) return
  const newList = [...list]
  ;[newList[index], newList[index + 1]] = [newList[index + 1], newList[index]]
  customerSourceData.value = newList
  saveCustomerSourceSort()
}

const saveCustomerSourceSort = async () => {
  const items = customerSourceData.value.map((item, idx) => ({ id: item.source_id, sortOrder: idx + 1 }))
  try { await api.sortCustomerSources({ items }) } catch (err) {}
}

const resetCsForm = () => {
  csForm.name = ''
  csForm.parentId = ''
  csForm.sortOrder = 0
  editingCsId.value = null
  editingCsParentId.value = null
}

// ==============================================
// 字典管理 - 收款方式
// ==============================================
const paymentMethodData = ref([])
const paymentMethodDialogVisible = ref(false)
const pmDialogTitle = ref('新增收款方式')
const editingPmId = ref(null)
const pmForm = reactive({ name: '', settlementAccountId: '', isGlobal: true, sortOrder: 0 })
const pmStoreConfigRows = ref([])
const settlementAccounts = ref([])

const loadPaymentMethods = async () => {
  try {
    const res = await api.getAllPaymentMethods()
    if (res.code === 0) paymentMethodData.value = res.data || []
  } catch (err) { ElMessage.error('加载收款方式失败') }
}

const loadSettlementAccounts = async () => {
  try {
    const res = await api.getAllSettlementAccounts()
    if (res.code === 0) settlementAccounts.value = res.data || []
  } catch (err) { console.error('Failed to load settlement accounts') }
}

const openPaymentMethodDialog = (row) => {
  loadSettlementAccounts()
  pmStoreConfigRows.value = (stores.value || []).map(s => ({ store_id: s.store_id, name: s.name, checked: false, accountId: '' }))

  if (row) {
    pmDialogTitle.value = '编辑收款方式'
    editingPmId.value = row.method_id
    pmForm.name = row.name
    pmForm.settlementAccountId = row.settlement_account_id || ''
    pmForm.isGlobal = row.is_global === 1 || row.is_global === true
    pmForm.sortOrder = row.sort_order || 0
    if (row.Stores && row.Stores.length > 0) {
      pmForm.isGlobal = false
      const storeMap = new Map()
      row.Stores.forEach(s => {
        storeMap.set(s.store_id, s.PaymentMethodStore?.settlement_account_id || '')
      })
      pmStoreConfigRows.value.forEach(r => {
        if (storeMap.has(r.store_id)) {
          r.checked = true
          r.accountId = storeMap.get(r.store_id)
        }
      })
    }
  } else {
    pmDialogTitle.value = '新增收款方式'
    editingPmId.value = null
    pmForm.name = ''
    pmForm.settlementAccountId = ''
    pmForm.isGlobal = true
    pmForm.sortOrder = (paymentMethodData.value.length || 0) + 1
  }
  paymentMethodDialogVisible.value = true
}

const onPmIsGlobalChange = () => {
  if (pmForm.isGlobal) {
    pmStoreConfigRows.value.forEach(r => { r.checked = false; r.accountId = '' })
  }
}

const onPmStoreChecked = (row) => {
  if (!row.checked) row.accountId = ''
}

const handlePmSubmit = async () => {
  if (!pmForm.name) { ElMessage.warning('请输入名称'); return }
  submitLoading.value = true
  try {
    let res
    const checkedRows = pmStoreConfigRows.value.filter(r => r.checked)
    const storeConfigs = checkedRows.map(r => ({
      storeId: r.store_id,
      settlementAccountId: r.accountId || null
    }))
    const data = {
      name: pmForm.name,
      isGlobal: pmForm.isGlobal,
      settlementAccountId: pmForm.isGlobal ? pmForm.settlementAccountId : null,
      storeConfigs,
      sortOrder: pmForm.sortOrder
    }
    if (editingPmId.value) {
      res = await api.updatePaymentMethod(editingPmId.value, data)
    } else {
      res = await api.createPaymentMethod(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingPmId.value ? '更新成功' : '创建成功')
      paymentMethodDialogVisible.value = false
      loadPaymentMethods()
    } else { ElMessage.error(res.message || '操作失败') }
  } catch (err) { ElMessage.error(err?.response?.data?.message || err?.message || '操作失败') }
  finally { submitLoading.value = false }
}

const handleDeletePaymentMethod = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除收款方式"${row.name}"？`, '确认删除', { type: 'warning' })
    const res = await api.deletePaymentMethod(row.method_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadPaymentMethods()
    } else { ElMessage.error(res.message || '删除失败') }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err?.response?.data?.message || err?.message || '删除失败')
  }
}

const moveUpPaymentMethod = (index) => {
  if (index <= 0) return
  const list = [...paymentMethodData.value]
  ;[list[index - 1], list[index]] = [list[index], list[index - 1]]
  paymentMethodData.value = list
  savePmSort()
}

const moveDownPaymentMethod = (index) => {
  const list = paymentMethodData.value
  if (index >= list.length - 1) return
  const newList = [...list]
  ;[newList[index], newList[index + 1]] = [newList[index + 1], newList[index]]
  paymentMethodData.value = newList
  savePmSort()
}

const savePmSort = async () => {
  const items = paymentMethodData.value.map((item, idx) => ({ id: item.method_id, sortOrder: idx + 1 }))
  try { await api.sortPaymentMethods({ items }) } catch (err) {}
}

const resetPmForm = () => {
  pmForm.name = ''
  pmForm.settlementAccountId = ''
  pmForm.isGlobal = true
  pmForm.sortOrder = 0
  editingPmId.value = null
  pmStoreConfigRows.value = []
}

// ==============================================
// 结算账号管理
// ==============================================
const settlementAccountDialogVisible = ref(false)
const saMgmtDialogVisible = ref(false)
const saFormDialogVisible = ref(false)
const settlementAccountData = ref([])
const saDialogTitle = ref('新增结算账号')
const editingSaId = ref(null)
const saForm = reactive({ accountName: '', bankName: '', accountNumber: '', sortOrder: 0 })

const openSaMgmtDialog = async () => {
  saMgmtDialogVisible.value = true
  await loadSettlementAccountsForMgmt()
}

const loadSettlementAccountsForMgmt = async () => {
  try {
    const res = await api.getAllSettlementAccounts()
    if (res.code === 0) settlementAccountData.value = res.data || []
  } catch (err) { ElMessage.error('加载结算账号失败') }
}

const handleSaMgmtClose = () => {
  loadSettlementAccounts()
}

const openSettlementAccountDialog = (row) => {
  if (row) {
    saDialogTitle.value = '编辑结算账号'
    editingSaId.value = row.account_id
    saForm.accountName = row.account_name
    saForm.bankName = row.bank_name
    saForm.accountNumber = row.account_number
    saForm.sortOrder = row.sort_order || 0
  } else {
    saDialogTitle.value = '新增结算账号'
    editingSaId.value = null
    saForm.accountName = ''
    saForm.bankName = ''
    saForm.accountNumber = ''
    saForm.sortOrder = 0
  }
  saFormDialogVisible.value = true
}

const handleSaSubmit = async () => {
  if (!saForm.accountName) { ElMessage.warning('请输入账号名称'); return }
  submitLoading.value = true
  try {
    let res
    const data = { accountName: saForm.accountName, bankName: saForm.bankName, accountNumber: saForm.accountNumber, sortOrder: saForm.sortOrder }
    if (editingSaId.value) {
      res = await api.updateSettlementAccount(editingSaId.value, data)
    } else {
      res = await api.createSettlementAccount(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingSaId.value ? '更新成功' : '创建成功')
      saFormDialogVisible.value = false
      loadSettlementAccountsForMgmt()
      loadSettlementAccounts()
    } else { ElMessage.error(res.message || '操作失败') }
  } catch (err) { ElMessage.error(err?.response?.data?.message || err?.message || '操作失败') }
  finally { submitLoading.value = false }
}

const handleDeleteSa = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除结算账号"${row.account_name}"？`, '确认删除', { type: 'warning' })
    const res = await api.deleteSettlementAccount(row.account_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadSettlementAccountsForMgmt()
      loadSettlementAccounts()
    } else { ElMessage.error(res.message || '删除失败') }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err?.response?.data?.message || err?.message || '删除失败')
  }
}

const moveUpSa = (index) => {
  if (index <= 0) return
  const list = [...settlementAccountData.value]
  ;[list[index - 1], list[index]] = [list[index], list[index - 1]]
  settlementAccountData.value = list
  saveSaSort()
}

const moveDownSa = (index) => {
  const list = settlementAccountData.value
  if (index >= list.length - 1) return
  const newList = [...list]
  ;[newList[index], newList[index + 1]] = [newList[index + 1], newList[index]]
  settlementAccountData.value = newList
  saveSaSort()
}

const saveSaSort = async () => {
  const items = settlementAccountData.value.map((item, idx) => ({ id: item.account_id, sortOrder: idx + 1 }))
  try { await api.sortSettlementAccounts({ items }) } catch (err) {}
}

const resetSaForm = () => {
  saForm.accountName = ''
  saForm.bankName = ''
  saForm.accountNumber = ''
  saForm.sortOrder = 0
  editingSaId.value = null
}

// ==============================================
// 字典管理 - 金额补录项目
// ==============================================
const supplementItemData = ref([])
const supplementItemDialogVisible = ref(false)
const siDialogTitle = ref('新增项目')
const editingSiId = ref(null)
const siForm = reactive({ name: '', amount: 0, sortOrder: 0 })

const loadSupplementItems = async () => {
  try {
    const res = await api.getAllSupplementItems()
    if (res.code === 0) supplementItemData.value = res.data || []
  } catch (err) { ElMessage.error('加载金额补录项目失败') }
}

const openSupplementItemDialog = (row) => {
  if (row) {
    siDialogTitle.value = '编辑项目'
    editingSiId.value = row.item_id
    siForm.name = row.name
    siForm.amount = row.amount || 0
    siForm.sortOrder = row.sort_order || 0
  } else {
    siDialogTitle.value = '新增项目'
    editingSiId.value = null
    siForm.name = ''
    siForm.amount = 0
    siForm.sortOrder = (supplementItemData.value.length || 0) + 1
  }
  supplementItemDialogVisible.value = true
}

const handleSiSubmit = async () => {
  if (!siForm.name) { ElMessage.warning('请输入名称'); return }
  submitLoading.value = true
  try {
    let res
    const data = { name: siForm.name, amount: siForm.amount, sortOrder: siForm.sortOrder }
    if (editingSiId.value) {
      res = await api.updateSupplementItem(editingSiId.value, data)
    } else {
      res = await api.createSupplementItem(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingSiId.value ? '更新成功' : '创建成功')
      supplementItemDialogVisible.value = false
      loadSupplementItems()
    } else { ElMessage.error(res.message || '操作失败') }
  } catch (err) { ElMessage.error(err?.response?.data?.message || err?.message || '操作失败') }
  finally { submitLoading.value = false }
}

const handleDeleteSupplementItem = async (row) => {
  try {
    const res = await api.deleteSupplementItem(row.item_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadSupplementItems()
    } else { ElMessage.error(res.message || '删除失败') }
  } catch (err) { ElMessage.error(err?.response?.data?.message || err?.message || '删除失败') }
}

const moveUpSupplementItem = (index) => {
  if (index <= 0) return
  const list = [...supplementItemData.value]
  ;[list[index - 1], list[index]] = [list[index], list[index - 1]]
  supplementItemData.value = list
  saveSiSort()
}

const moveDownSupplementItem = (index) => {
  const list = supplementItemData.value
  if (index >= list.length - 1) return
  const newList = [...list]
  ;[newList[index], newList[index + 1]] = [newList[index + 1], newList[index]]
  supplementItemData.value = newList
  saveSiSort()
}

const saveSiSort = async () => {
  const items = supplementItemData.value.map((item, idx) => ({ id: item.item_id, sortOrder: idx + 1 }))
  try { await api.sortSupplementItems({ items }) } catch (err) {}
}

const resetSiForm = () => {
  siForm.name = ''
  siForm.amount = 0
  siForm.sortOrder = 0
  editingSiId.value = null
}

// ==============================================
// 商品字段管理
// ==============================================
const cfTreeRef = ref(null)
const cfSelectedCatId = ref('')
const cfSelectedCatName = ref('')
const cfSearch = ref('')
const cfCategoryTree = ref([])
const cfFields = ref([])
const cfSaving = ref(false)
const cfDialogVisible = ref(false)
const cfDialogTitle = ref('新增字段')
const cfEditingIndex = ref(-1)
const cfOptionInput = ref('')
const cfFieldForm = reactive({
  field_label: '', field_key: '', field_type: 'text', options: [], placeholder: '', required: false
})

const cfLoadCategoryTree = async () => {
  try {
    const res = await api.getCategoryTree()
    if (res.code === 0) cfCategoryTree.value = res.data || []
  } catch (err) { ElMessage.error('加载分类失败') }
}

const cfFilterNode = (value, data) => {
  if (!value) return true
  return data.name.includes(value)
}

const cfNodeClick = (data) => {
  cfSelectedCatId.value = data.category_id
  cfSelectedCatName.value = data.name
  cfLoadCategoryFields()
}

const cfLoadCategoryFields = async () => {
  if (!cfSelectedCatId.value) return
  try {
    const res = await api.getCategoryFields(cfSelectedCatId.value)
    if (res.code === 0) cfFields.value = res.data || []
  } catch (err) { cfFields.value = [] }
}

const cfAddField = () => {
  cfDialogTitle.value = '新增字段'
  cfEditingIndex.value = -1
  cfFieldForm.field_label = ''
  cfFieldForm.field_key = ''
  cfFieldForm.field_type = 'text'
  cfFieldForm.options = []
  cfFieldForm.placeholder = ''
  cfFieldForm.required = false
  cfOptionInput.value = ''
  cfDialogVisible.value = true
}

const cfEditField = (row) => {
  cfDialogTitle.value = '编辑字段'
  cfEditingIndex.value = cfFields.value.indexOf(row)
  cfFieldForm.field_label = row.field_label
  cfFieldForm.field_key = row.field_key
  cfFieldForm.field_type = row.field_type
  cfFieldForm.options = row.field_options ? JSON.parse(row.field_options) : []
  cfFieldForm.placeholder = row.field_placeholder || ''
  cfFieldForm.required = row.required === 1
  cfOptionInput.value = ''
  cfDialogVisible.value = true
}

const cfConfirmField = () => {
  if (!cfFieldForm.field_label || !cfFieldForm.field_key) {
    ElMessage.warning('请填写字段名和标识')
    return
  }
  const item = {
    field_label: cfFieldForm.field_label,
    field_key: cfFieldForm.field_key,
    field_type: cfFieldForm.field_type,
    options: cfFieldForm.field_type === 'select' ? [...cfFieldForm.options] : [],
    placeholder: cfFieldForm.placeholder,
    required: cfFieldForm.required
  }
  if (cfEditingIndex.value >= 0) {
    cfFields.value[cfEditingIndex.value] = item
  } else {
    cfFields.value.push(item)
  }
  cfDialogVisible.value = false
}

const cfDeleteField = (row) => {
  const idx = cfFields.value.indexOf(row)
  if (idx >= 0) cfFields.value.splice(idx, 1)
}

const cfMoveField = (index, dir) => {
  const newIdx = index + dir
  if (newIdx < 0 || newIdx >= cfFields.value.length) return
  const list = [...cfFields.value]
  ;[list[index], list[newIdx]] = [list[newIdx], list[index]]
  cfFields.value = list
}

const cfSave = async () => {
  if (!cfSelectedCatId.value) return
  cfSaving.value = true
  try {
    const data = {
      categoryId: cfSelectedCatId.value,
      fields: cfFields.value.map((f, i) => ({
        field_label: f.field_label,
        field_key: f.field_key,
        field_type: f.field_type,
        options: f.options || (f.field_options ? JSON.parse(f.field_options) : []),
        placeholder: f.placeholder || f.field_placeholder,
        sort_order: i,
        required: !!f.required
      }))
    }
    const res = await api.saveCategoryFields(data)
    if (res.code === 0) {
      ElMessage.success('保存成功')
      cfLoadCategoryFields()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error('保存失败: ' + (err?.response?.data?.message || err?.message || '未知错误'))
  }
  finally { cfSaving.value = false }
}

const cfAddOption = () => {
  const val = cfOptionInput.value.trim()
  if (!val) return
  if (!cfFieldForm.options.includes(val)) {
    cfFieldForm.options.push(val)
  }
  cfOptionInput.value = ''
}

const cfRemoveOption = (idx) => {
  cfFieldForm.options.splice(idx, 1)
}

const cfResetFieldForm = () => {
  cfFieldForm.field_label = ''
  cfFieldForm.field_key = ''
  cfFieldForm.field_type = 'text'
  cfFieldForm.options = []
  cfFieldForm.placeholder = ''
  cfFieldForm.required = false
  cfOptionInput.value = ''
}
</script>

<style scoped>
.filter-bar {
  margin-bottom: 16px;
}
</style>
