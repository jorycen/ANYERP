<template>
  <div class="system-page">
    <el-card>
      <template #header>
        <span>系统设置</span>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs" @tab-change="onSysTabChange">
        <el-tab-pane label="用户管理" name="users">
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddUser">新增用户</el-button>
          </div>

          <el-table :data="userData" stripe border>
            <el-table-column prop="staff_id" label="ID" width="80" />
            <el-table-column prop="name" label="姓名" width="120" />
            <el-table-column prop="phone" label="手机号" width="130" />
            <el-table-column label="角色" min-width="160">
              <template #default="{ row }">
                <el-tag v-for="roleName in row.role_names" :key="roleName" class="mr-1">{{ roleName }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="supervisor_name" label="直属上级" width="120" />
            <el-table-column label="所属经销商" min-width="180">
              <template #default="{ row }">
                <el-tag v-for="item in (row.distributor_names || [])" :key="item" class="mr-1">{{ item }}</el-tag>
                <span v-if="!(row.distributor_names || []).length">未配置</span>
              </template>
            </el-table-column>
            <el-table-column prop="region_name" label="所属区域" width="180" />
            <el-table-column prop="store_name" label="门店" min-width="180" show-overflow-tooltip />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="310">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditUser(row)">编辑</el-button>
                <el-button v-if="!row.is_boss && !row.region_scoped" link type="primary" @click="handleAssignScope(row)">分配区域及门店</el-button>
                <el-button link type="warning" @click="handleResetPassword(row)">重置密码</el-button>
                <el-button
                  link
                  :type="row.status === 1 ? 'danger' : 'success'"
                  @click="handleToggleUserStatus(row)"
                >
                  {{ row.status === 1 ? '停用' : '启用' }}
                </el-button>
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
          <div class="filter-bar menu-toolbar">
            <span class="menu-help">拖动菜单可调整顺序和层级，保存后对所有用户生效。</span>
            <div>
              <el-button @click="reloadMenus" :disabled="menuReorderSaving">重新加载</el-button>
              <el-button type="primary" :disabled="!menuReorderDirty" :loading="menuReorderSaving" @click="saveMenuOrder">
                保存排序
              </el-button>
            </div>
          </div>
          <el-alert
            title="允许将菜单拖到其他菜单下，也可以拖回一级菜单；菜单权限和访问路径不会被修改。"
            type="info"
            :closable="false"
            class="menu-order-alert"
          />
          <el-tree
            :data="menuData"
            :props="{ label: 'name', children: 'children' }"
            node-key="menuId"
            default-expand-all
            draggable
            :allow-drop="allowMenuDrop"
            :expand-on-click-node="false"
            @node-drop="handleMenuDrop"
          >
            <template #default="{ data }">
              <span class="menu-tree-label">
                <span>{{ data.name }} ({{ data.menuCode }})</span>
                <el-tag v-if="data.status === 0" size="small" type="info">停用</el-tag>
                <span v-if="data.path" class="menu-tree-path">{{ data.path }}</span>
              </span>
            </template>
          </el-tree>
        </el-tab-pane>

        <el-tab-pane label="库位管理" name="locations">
          <div class="filter-bar">
            <el-select v-model="locationQuery.storeId" placeholder="查看门店覆盖" clearable filterable style="width: 220px" @change="loadLocations">
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-input v-model="locationQuery.keyword" placeholder="库位类型/名称" clearable style="width: 220px" @keyup.enter="loadLocations" />
            <el-select v-model="locationQuery.status" placeholder="状态" style="width: 120px" @change="loadLocations">
              <el-option label="启用" :value="1" />
              <el-option label="停用" :value="0" />
              <el-option label="全部" value="" />
            </el-select>
            <el-button @click="loadLocations">查询</el-button>
            <el-button type="primary" @click="openLocationDialog()">配置标准库位</el-button>
          </div>
          <el-table :data="locationData" stripe border v-loading="locationLoading">
            <el-table-column prop="type" label="库位类型" width="140" />
            <el-table-column prop="name" label="库位名称" min-width="160" />
            <el-table-column label="覆盖门店" width="120">
              <template #default="{ row }">{{ row.store_count || 0 }}</template>
            </el-table-column>
            <el-table-column label="启用门店" width="120">
              <template #default="{ row }">{{ row.enabled_store_count || 0 }}</template>
            </el-table-column>
            <el-table-column label="可销售" width="90">
              <template #default="{ row }">{{ row.is_sellable ? '是' : '否' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openLocationDialog(row)">编辑</el-button>
                <el-button v-if="row.status" link type="danger" @click="disableLocation(row)">停用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="货型配置" name="resourceCategories">
          <el-alert title="货型是采购时快速勾选资源子内容的模板；每项资源仍在SN维度独立记录、核销和下账。" type="info" :closable="false" style="margin-bottom:12px" />
          <div class="config-section-title">
            <strong>货型</strong>
            <el-button type="primary" @click="openGoodsType()">新增货型</el-button>
          </div>
          <el-table :data="goodsTypeData" stripe border style="margin-bottom:24px">
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="货型名称" min-width="180" />
            <el-table-column label="包含的资源子内容" min-width="360">
              <template #default="{row}">
                <el-tag v-for="item in row.ResourceCategories" :key="item.category_id" class="mr-1">{{ item.name }}</el-tag>
                <span v-if="!row.ResourceCategories?.length" class="text-muted">未配置</span>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="180" />
            <el-table-column label="状态" width="90"><template #default="{row}"><el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="140"><template #default="{row}"><el-button link type="primary" @click="openGoodsType(row)">编辑</el-button><el-button link type="danger" @click="removeGoodsType(row)">删除</el-button></template></el-table-column>
          </el-table>

          <div class="config-section-title">
            <strong>资源子内容</strong>
            <div><el-button type="primary" @click="openResourceCategory()">新增子内容</el-button><el-button @click="openSaMgmtDialog">账户管理</el-button></div>
          </div>
          <el-alert title="资源子内容会用于货型组合，并自动应用到商品资源成本定义等权益下拉框。删除只停止新业务使用，历史记录保留。" type="info" :closable="false" style="margin-bottom:12px" />
          <el-table :data="resourceCategoryData" stripe border>
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="子内容名称" min-width="150" />
            <el-table-column prop="short_name" label="简称" width="110" />
            <el-table-column label="权益类型" width="120"><template #default="{row}">{{ resourceKindText(row.resource_kind) }}</template></el-table-column>
            <el-table-column label="采购可选" width="90"><template #default="{row}">{{ row.supports_purchase_select ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="销售使用" width="90"><template #default="{row}">{{ row.supports_sale_use ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="销售触发" width="90"><template #default="{row}">{{ row.trigger_on_sale ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="公司套回" width="90"><template #default="{row}">{{ row.supports_company_claim ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="产生可用金" width="100"><template #default="{row}">{{ row.generates_staff_care_credit ? '是' : '否' }}</template></el-table-column>
            <el-table-column label="默认到账账户" min-width="160"><template #default="{row}">{{ row.DefaultAccount?.account_name || '未配置' }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{row}"><el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="140"><template #default="{row}"><el-button link type="primary" @click="openResourceCategory(row)">编辑</el-button><el-button link type="danger" @click="removeResourceCategory(row)">删除</el-button></template></el-table-column>
          </el-table>
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
          <div class="config-section-title">
            <strong>国补实际到账账户（按区域）</strong>
            <el-button @click="loadSubsidyAccountRoutes">刷新</el-button>
          </div>
          <el-alert title="区域账户用于银行实际到账登记；政策补贴应收账户仍用于记录待回款资产。未配置区域不得跨区域自动下账。" type="info" :closable="false" style="margin-bottom:12px" />
          <el-table :data="subsidyAccountRoutes" stripe border style="margin-bottom:24px">
            <el-table-column prop="region_name" label="区域" width="180" />
            <el-table-column label="默认对公资金账户" min-width="280">
              <template #default="{ row }">
                <el-select v-model="row.account_id" clearable filterable placeholder="暂不配置" style="width:100%" @change="saveSubsidyAccountRoute(row)">
                  <el-option v-for="account in fundAccounts" :key="account.account_id" :label="account.account_name" :value="account.account_id" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column prop="update_user" label="更新人" width="120" />
            <el-table-column prop="update_time" label="更新时间" width="180" />
          </el-table>
          <div class="filter-bar">
            <el-button type="primary" @click="openPaymentMethodDialog()">新增收款方式</el-button>
          </div>
          <el-table :data="paymentMethodData" stripe border>
            <el-table-column prop="sort_order" label="排序" width="70" />
            <el-table-column prop="name" label="名称" width="160" />
            <el-table-column label="默认税率" width="110">
              <template #default="{ row }">{{ Number(row.default_tax_rate || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') }}%</template>
            </el-table-column>
            <el-table-column label="配置范围" width="120">
              <template #default="{ row }">
                <el-tag :type="row.is_global === 1 || row.is_global === true ? 'success' : 'warning'" size="small">
                  {{ row.is_global === 1 || row.is_global === true ? '全局' : '按门店' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="下账账户" min-width="300">
              <template #default="{ row }">
                <span v-if="row.is_global === 1 || row.is_global === true">
                  <span>客户实收：</span>
                  <span v-if="row.SettlementAccount">{{ row.SettlementAccount.account_name }}</span>
                  <span v-else class="text-muted">未绑定</span>
                  <template v-if="isGuobuPaymentMethod(row.name)">
                    <span>；政策补贴应收：</span>
                    <span v-if="row.ReceivableSettlementAccount">{{ row.ReceivableSettlementAccount.account_name }}</span>
                    <span v-else class="text-muted">未绑定</span>
                  </template>
                </span>
                <span v-else>
                  <el-tag v-for="s in (row.Stores || [])" :key="s.store_id" size="small" class="mr-1 mb-1">
                    {{ s.name }}：实收→{{ s.PaymentMethodStore?.SettlementAccount?.account_name || '未绑定' }}
                    <template v-if="isGuobuPaymentMethod(row.name)">
                      ；补贴应收→{{ s.PaymentMethodStore?.ReceivableSettlementAccount?.account_name || '未绑定' }}
                    </template>
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
            <el-table-column label="毛利方向" width="100">
              <template #default="{ row }">
                <el-tag :type="row.amount_type === 'decrease' ? 'danger' : 'success'">
                  {{ row.amount_type === 'decrease' ? '减少' : '增加' }}
                </el-tag>
              </template>
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

        <el-tab-pane label="报销类型管理" name="expenseType">
          <div class="filter-bar">
            <el-button type="primary" @click="openExpenseTypeDialog()">新增类型</el-button>
          </div>
          <el-table :data="expenseTypeData" stripe border>
            <el-table-column prop="sort_order" label="排序" width="80" />
            <el-table-column prop="name" label="类型名称" min-width="200" />
            <el-table-column prop="remark" label="备注" min-width="200" show-overflow-tooltip />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="Number(row.status) === 1 ? 'success' : 'info'">
                  {{ Number(row.status) === 1 ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160">
              <template #default="{ row }">
                <el-button link type="primary" @click="openExpenseTypeDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteExpenseType(row)">删除</el-button>
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
          <el-select v-model="userForm.roleIds" placeholder="请选择岗位角色" style="width: 100%">
            <el-option v-for="r in roleData" :key="r.role_id" :label="r.name" :value="r.role_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="直属上级">
          <el-select v-model="userForm.supervisorStaffId" clearable filterable placeholder="可选，审批流程可引用" style="width: 100%">
            <el-option v-for="u in userData.filter(item => String(item.staff_id) !== String(userForm.staffId))" :key="u.staff_id" :label="`${u.name}（${u.staff_id}）`" :value="u.staff_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="所属经销商" required>
          <el-select v-model="userForm.distributorIds" multiple filterable style="width: 100%" :disabled="!isOperatorBoss" placeholder="请选择所属经销商">
            <el-option v-for="item in distributorOptions" :key="item.distributor_id" :label="item.name" :value="item.distributor_id" />
          </el-select>
          <div class="form-tip">店长/店员只能选择一个经销商；采购、会计、出纳、BOSS等中台账号可选择多个。库存可跨区域查看，但采购、应付、结算和付款账户仍按经销商隔离。</div>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="userForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button v-if="!userForm.staffId" type="info" @click="saveSystemDraft('user-create', userForm)">保存草稿</el-button>
        <el-button type="primary" @click="handleUserSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="goodsTypeDialog" :title="goodsTypeForm.goodsTypeId ? '编辑货型' : '新增货型'" width="560px">
      <el-form :model="goodsTypeForm" label-width="110px">
        <el-form-item label="货型名称" required><el-input v-model="goodsTypeForm.name" placeholder="如：服务商全资源货" /></el-form-item>
        <el-form-item label="资源子内容">
          <el-select v-model="goodsTypeForm.resourceCategoryIds" multiple filterable clearable style="width:100%" placeholder="选择该货型包含的资源">
            <el-option v-for="item in resourceCategoryData" :key="item.category_id" :label="item.status ? item.name : `${item.name}（已停用）`" :value="item.category_id" :disabled="!item.status" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序"><el-input-number v-model="goodsTypeForm.sortOrder" :min="0" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="goodsTypeForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="goodsTypeForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="goodsTypeDialog=false">取消</el-button><el-button type="primary" :loading="submitLoading" @click="saveGoodsType">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="resourceCategoryDialog" :title="resourceCategoryForm.categoryId ? '编辑资源子内容' : '新增资源子内容'" width="560px">
      <el-form :model="resourceCategoryForm" label-width="120px">
        <el-form-item label="类别名称" required><el-input v-model="resourceCategoryForm.name" /></el-form-item>
        <el-form-item label="简称"><el-input v-model="resourceCategoryForm.shortName" /></el-form-item>
        <el-form-item label="权益类型">
          <el-select v-model="resourceCategoryForm.resourceKind" style="width:100%">
            <el-option label="销售使用型" value="SALE_USE" />
            <el-option label="内部标记型" value="INTERNAL_MARKER" />
            <el-option label="PO奖励型" value="PO_REWARD" />
            <el-option label="Care可用金型" value="CARE_CREDIT" />
            <el-option label="返利/下账型" value="REBATE" />
            <el-option label="其他" value="OTHER" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认到账账户" required><el-select v-model="resourceCategoryForm.defaultAccountId" filterable clearable style="width:100%"><el-option v-for="a in resourceAccountOptions" :key="a.account_id" :label="`${a.account_name}（${accountTypeText(a.account_type)}）`" :value="a.account_id" /></el-select></el-form-item>
        <el-form-item label="适用场景">
          <el-checkbox v-model="resourceCategoryForm.supportsPurchaseSelect">采购可选</el-checkbox>
          <el-checkbox v-model="resourceCategoryForm.supportsSaleUse">销售使用</el-checkbox>
          <el-checkbox v-model="resourceCategoryForm.supportsCompanyClaim">公司套回</el-checkbox>
          <el-checkbox v-model="resourceCategoryForm.triggerOnSale">销售归档触发</el-checkbox>
        </el-form-item>
        <el-form-item label="触发结果">
          <el-checkbox v-model="resourceCategoryForm.generatesSettlement">生成待下账</el-checkbox>
          <el-checkbox v-model="resourceCategoryForm.generatesStaffCareCredit">生成销售个人Care可用金</el-checkbox>
          <el-checkbox v-model="resourceCategoryForm.affectsPerformanceProfit">计入销售者毛利</el-checkbox>
        </el-form-item>
        <el-form-item label="计入比例">
          <el-input-number v-model="resourceCategoryForm.performanceProfitRatio" :min="0" :max="100" :precision="2" />
          <span style="margin-left:8px;color:#909399">%</span>
        </el-form-item>
        <el-form-item label="排序"><el-input-number v-model="resourceCategoryForm.sortOrder" :min="0" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="resourceCategoryForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="resourceCategoryForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="resourceCategoryDialog=false">取消</el-button><el-button type="primary" :loading="submitLoading" @click="saveResourceCategory">保存</el-button></template>
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
        <el-button v-if="!editingCsId" type="info" @click="saveSystemDraft('customer-source-create', csForm)">保存草稿</el-button>
        <el-button type="primary" @click="handleCsSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="paymentMethodDialogVisible" :title="pmDialogTitle" width="900px" @close="resetPmForm">
      <el-form :model="pmForm" label-width="130px">
        <el-form-item label="名称" required>
          <el-input v-model="pmForm.name" placeholder="请输入收款方式名称" />
        </el-form-item>
        <el-form-item label="默认税率" required>
          <el-input-number v-model="pmForm.defaultTaxRate" :min="0" :max="100" :precision="4" :step="0.1" />
          <span style="margin-left:8px;color:#909399">%（例如 0.6 表示应收分配额的 0.6%）</span>
        </el-form-item>
        <el-form-item label="配置范围">
          <el-radio-group v-model="pmForm.isGlobal" @change="onPmIsGlobalChange">
            <el-radio :value="true">全局配置（所有门店共用默认结算账号）</el-radio>
            <el-radio :value="false">按门店配置（每个门店单独设置结算账号）</el-radio>
          </el-radio-group>
        </el-form-item>

        <template v-if="pmForm.isGlobal">
          <el-form-item :label="isGuobuPaymentMethod(pmForm.name) ? '客户实收账户' : '默认结算账户'">
            <div style="display: flex; align-items: center; gap: 8px; width: 100%">
              <el-select v-model="pmForm.settlementAccountId" placeholder="选择结算账号" clearable style="flex: 1">
                <el-option v-for="acc in fundAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
              </el-select>
              <el-button link type="primary" @click="openSaMgmtDialog">管理结算账号</el-button>
            </div>
          </el-form-item>
          <el-form-item v-if="isGuobuPaymentMethod(pmForm.name)" label="政策补贴应收账户">
            <el-select v-model="pmForm.receivableSettlementAccountId" placeholder="选择政策补贴应收账户" clearable style="width: 100%">
              <el-option v-for="acc in policyReceivableAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
            </el-select>
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
                <el-table-column :label="isGuobuPaymentMethod(pmForm.name) ? '客户实收账户' : '结算账户'" min-width="200">
                  <template #default="{ row }">
                    <el-select v-model="row.accountId" placeholder="选择结算账号" clearable size="small" style="width: 100%" :disabled="!row.checked">
                      <el-option v-for="acc in fundAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column v-if="isGuobuPaymentMethod(pmForm.name)" label="政策补贴应收账户" min-width="220">
                  <template #default="{ row }">
                    <el-select v-model="row.receivableAccountId" placeholder="选择应收账户" clearable size="small" style="width: 100%" :disabled="!row.checked">
                      <el-option v-for="acc in policyReceivableAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
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
        <el-button v-if="!editingPmId" type="info" @click="savePaymentMethodDraft">保存草稿</el-button>
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
        <el-table-column label="账户类型" width="120"><template #default="{row}">{{ accountTypeText(row.account_type) }}</template></el-table-column>
        <el-table-column label="所属经销商" width="130"><template #default="{row}">{{ distributorOptions.find(item => String(item.distributor_id) === String(row.distributor_id))?.name || '共享/系统级' }}</template></el-table-column>
        <el-table-column label="所属区域" width="110"><template #default="{row}">{{ row.Region?.name || '公司级' }}</template></el-table-column>
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
          <el-form-item label="账户类型" required>
            <el-select v-model="saForm.accountType" style="width:100%"><el-option label="资金账户" value="FUND" /><el-option label="政策补贴应收" value="POLICY_RECEIVABLE" /><el-option label="Care可用金" value="CARE_CREDIT" /></el-select>
          </el-form-item>
          <el-form-item label="所属经销商" :required="saForm.accountType === 'FUND'">
            <el-select v-model="saForm.distributorId" clearable filterable style="width:100%" placeholder="资金账户必须选择经销商；其他账户可共享">
              <el-option v-for="item in distributorOptions" :key="item.distributor_id" :label="item.name" :value="item.distributor_id" />
            </el-select>
          </el-form-item>
          <el-form-item label="所属区域">
            <el-select v-model="saForm.regionId" clearable style="width:100%" placeholder="不选表示公司级账户">
              <el-option v-for="region in regions" :key="region.region_id" :label="String(region.name || '').replace('区域', '')" :value="region.region_id" />
            </el-select>
          </el-form-item>
          <el-form-item label="开户行">
            <el-input v-model="saForm.bankName" placeholder="请输入开户行" />
          </el-form-item>
          <el-form-item label="账号">
            <el-input v-model="saForm.accountNumber" placeholder="请输入账号" />
          </el-form-item>
          <el-form-item label="用途限制"><el-input v-model="saForm.usageNote" type="textarea" placeholder="如：仅用于购买延保商品" /></el-form-item>
          <el-form-item label="排序">
            <el-input v-model="saForm.sortOrder" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="saFormDialogVisible = false">取消</el-button>
          <el-button v-if="!editingSaId" type="info" @click="saveSystemDraft('settlement-account-create', saForm)">保存草稿</el-button>
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
        <el-form-item label="毛利方向" required>
          <el-radio-group v-model="siForm.amountType">
            <el-radio value="increase">增加毛利</el-radio>
            <el-radio value="decrease">减少毛利</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model="siForm.sortOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="supplementItemDialogVisible = false">取消</el-button>
        <el-button v-if="!editingSiId" type="info" @click="saveSystemDraft('supplement-item-create', siForm)">保存草稿</el-button>
        <el-button type="primary" @click="handleSiSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="expenseTypeDialogVisible" :title="etDialogTitle" width="520px" @close="resetEtForm">
      <el-form :model="etForm" label-width="90px">
        <el-form-item label="类型名称" required>
          <el-input v-model="etForm.name" placeholder="如：差旅费、办公费、招待费" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="etForm.sortOrder" :min="0" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="etForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="etForm.remark" type="textarea" rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expenseTypeDialogVisible = false">取消</el-button>
        <el-button v-if="!editingEtId" type="info" @click="saveSystemDraft('expense-type-create', etForm)">保存草稿</el-button>
        <el-button type="primary" @click="handleEtSubmit" :loading="submitLoading">确定</el-button>
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
        <el-button type="info" @click="saveCategoryFieldDraft">保存草稿</el-button>
        <el-button type="primary" @click="cfConfirmField">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="locationDialogVisible" :title="locationDialogTitle" width="520px" @close="resetLocationForm">
      <el-form :model="locationForm" label-width="90px">
        <el-form-item label="库位类型" required>
          <el-select v-model="locationForm.type" :disabled="!!editingLocationId" style="width: 100%" @change="handleLocationTypeChange">
            <el-option v-for="item in locationTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="库位名称" required>
          <el-input v-model="locationForm.name" disabled />
        </el-form-item>
        <el-form-item label="适用门店" required>
          <el-select v-model="locationForm.storeIds" multiple filterable collapse-tags collapse-tags-tooltip style="width: 100%" placeholder="请选择适用门店">
            <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="可销售">
          <el-switch v-model="locationForm.isSellable" :active-value="1" :inactive-value="0" disabled />
          <span style="margin-left: 8px; color: #909399">由标准库位类型固定</span>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="locationForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="locationDialogVisible = false">取消</el-button>
        <el-button v-if="!editingLocationId" type="info" @click="saveSystemDraft('location-create', locationForm)">保存草稿</el-button>
        <el-button type="primary" @click="handleLocationSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 分配门店/区域对话框 -->
    <el-dialog v-model="storeDialogVisible" title="分配区域及门店" width="560px">
      <el-form label-width="100px">
        <el-form-item label="用户">{{ currentUser?.name }}</el-form-item>
        <el-form-item label="可管理区域">
          <div class="store-permission-selector">
            <div class="store-select-all">
              <el-checkbox
                :indeterminate="regionDialogIndeterminate"
                :model-value="regionDialogCheckAll"
                @change="handleRegionDialogCheckAll"
              >
                全选
              </el-checkbox>
              <span class="store-selected-count">已选 {{ dialogRegionIds.length }}/{{ assignableRegions.length }}</span>
            </div>
            <el-checkbox-group v-if="assignableRegions.length" v-model="dialogRegionIds" class="store-checkbox-list">
              <el-checkbox v-for="region in assignableRegions" :key="region.region_id" :label="region.region_id">
                {{ region.name }}
              </el-checkbox>
            </el-checkbox-group>
            <el-empty v-else description="暂无可分配区域" :image-size="60" />
          </div>
        </el-form-item>
        <el-form-item label="可访问门店">
          <div class="store-permission-selector">
            <div class="store-select-all">
              <el-checkbox
                :indeterminate="storeDialogIndeterminate"
                :model-value="storeDialogCheckAll"
                @change="handleStoreDialogCheckAll"
              >
                全选
              </el-checkbox>
              <span class="store-selected-count">已选 {{ dialogStoreIds.length }}/{{ filteredAssignableStores.length }}</span>
            </div>
            <el-checkbox-group v-if="filteredAssignableStores.length" v-model="dialogStoreIds" class="store-checkbox-list">
              <el-checkbox v-for="s in filteredAssignableStores" :key="s.store_id" :label="s.store_id">
                {{ s.name }}
              </el-checkbox>
            </el-checkbox-group>
            <el-empty v-else description="暂无可分配门店" :image-size="60" />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="storeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleScopeDialogSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleDialogVisible" :title="roleDialogTitle" width="500px" @close="resetRoleForm">
      <el-form :model="roleForm" label-width="100px">
        <el-form-item label="角色名称" required>
          <el-input v-model="roleForm.name" placeholder="请输入角色名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleForm.description" type="textarea" :rows="3" placeholder="请输入角色说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialogVisible = false">取消</el-button>
        <el-button v-if="!roleForm.roleId" type="info" @click="saveSystemDraft('role-create', roleForm)">保存草稿</el-button>
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
            node-key="menuId"
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
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'
import { getUserInfo } from '../utils/user'

const route = useRoute()
const activeTab = ref('users')
const syncTabFromRoute = () => {
  const tab = String(route.meta.tab || 'users')
  if (activeTab.value !== tab) activeTab.value = tab
  onSysTabChange(tab)
}
const userData = ref([])
const roleData = ref([])
const menuData = ref([])
const menuReorderDirty = ref(false)
const menuReorderSaving = ref(false)
const stores = ref([])
const regions = ref([])
const distributorOptions = ref([])
const locationData = ref([])
const locationLoading = ref(false)
const assignableStores = ref([])
const assignableRegions = ref([])
const goodsTypeData = ref([])
const goodsTypeDialog = ref(false)
const goodsTypeForm = reactive({
  goodsTypeId:'', name:'', resourceCategoryIds:[], sortOrder:0, status:1, remark:''
})
const resourceCategoryData = ref([])
const resourceAccountOptions = ref([])
const resourceCategoryDialog = ref(false)
const resourceCategoryForm = reactive({
  categoryId:'', name:'', shortName:'', resourceKind:'SALE_USE', defaultAccountId:'',
  supportsPurchaseSelect:true, supportsSaleUse:true, supportsCompanyClaim:true, triggerOnSale:false,
  generatesSettlement:true, generatesStaffCareCredit:false, affectsPerformanceProfit:false,
  performanceProfitRatio:100, sortOrder:0, status:1, remark:''
})
const resourceKindText = value => ({
  SALE_USE:'销售使用型', INTERNAL_MARKER:'内部标记型', PO_REWARD:'PO奖励型',
  CARE_CREDIT:'Care可用金型', REBATE:'返利/下账型', OTHER:'其他'
}[value] || value || '销售使用型')

const userDialogVisible = ref(false)
const storeDialogVisible = ref(false)
const menuDialogVisible = ref(false)
const roleDialogVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新增用户')
const roleDialogTitle = ref('新增角色')
const currentUser = ref(null)
const operatorUser = getUserInfo()
const isOperatorBoss = computed(() => {
  const roles = Array.isArray(operatorUser.roles) ? operatorUser.roles : [operatorUser.roleCode]
  return roles.includes('boss')
})
const currentRole = ref(null)
const dialogStoreIds = ref([])
const dialogRegionIds = ref([])
const dialogScopeType = ref('combined')
const menuTreeRef = ref(null)
const locationDialogVisible = ref(false)
const locationDialogTitle = ref('新增库位')
const editingLocationId = ref(null)
const locationQuery = reactive({ storeId: '', keyword: '', status: 1 })
const locationForm = reactive({
  name: '',
  type: 'normal_qty',
  storeIds: [],
  isSellable: 1,
  status: 1
})
const locationTypeOptions = [
  { value: 'normal_qty', label: '销售仓', isSellable: 1 },
  { value: 'demo_qty', label: '样品仓', isSellable: 1 },
  { value: 'display_qty', label: '铺货仓', isSellable: 1 },
  { value: 'unsellable_qty', label: '不可售仓', isSellable: 0 },
  { value: 'pending_qty', label: '占用仓', isSellable: 0 },
  { value: 'rental_demo_qty', label: '租赁样机仓', isSellable: 0 }
]
const saveSystemDraft = (key, data) => {
  saveDraft(`system:${key}`, cloneDraft(data))
  ElMessage.success('草稿已保存')
}

const restoreSystemDraft = (key, target) => {
  const draft = loadDraft(`system:${key}`)
  if (!draft) return
  Object.assign(target, draft)
  ElMessage.success('已恢复上次草稿')
}

const clearSystemDraft = (key) => clearDraft(`system:${key}`)

const userForm = reactive({
  staffId: null,
  name: '',
  phone: '',
  password: '',
  roleIds: '',
  distributorIds: [],
  supervisorStaffId: null,
  status: 1
})

const roleForm = reactive({
  roleId: null,
  name: '',
  description: ''
})

const storeDialogIndeterminate = computed(() => {
  const len = dialogStoreIds.value.length
  return len > 0 && len < filteredAssignableStores.value.length
})
const storeDialogCheckAll = computed(() => {
  return filteredAssignableStores.value.length > 0 && dialogStoreIds.value.length === filteredAssignableStores.value.length
})

const filteredAssignableStores = computed(() => {
  const selectedRegionIds = new Set(dialogRegionIds.value.map(String))
  if (selectedRegionIds.size === 0) return []
  return assignableStores.value.filter(store => selectedRegionIds.has(String(store.region_id || '')))
})

watch([dialogRegionIds, assignableStores], () => {
  const allowedStoreIds = new Set(filteredAssignableStores.value.map(store => String(store.store_id)))
  dialogStoreIds.value = dialogStoreIds.value.filter(storeId => allowedStoreIds.has(String(storeId)))
})

const regionDialogIndeterminate = computed(() => {
  const len = dialogRegionIds.value.length
  return len > 0 && len < assignableRegions.value.length
})
const regionDialogCheckAll = computed(() => {
  return assignableRegions.value.length > 0 && dialogRegionIds.value.length === assignableRegions.value.length
})

function handleStoreDialogCheckAll(checked) {
  const visibleStoreIds = filteredAssignableStores.value.map(s => s.store_id)
  const visibleStoreIdSet = new Set(visibleStoreIds.map(String))
  const retainedStoreIds = dialogStoreIds.value.filter(storeId => !visibleStoreIdSet.has(String(storeId)))
  dialogStoreIds.value = checked ? [...retainedStoreIds, ...visibleStoreIds] : retainedStoreIds
}

function handleRegionDialogCheckAll(checked) {
  dialogRegionIds.value = checked ? assignableRegions.value.map(region => region.region_id) : []
}

onMounted(() => {
  syncTabFromRoute()
  loadUsers()
  loadUserDistributors()
  loadRoles()
  loadMenus()
  loadStores()
  loadRegions()
  loadCustomerSources()
  loadResourceCategories()
  loadGoodsTypes()
  loadExpenseTypes()
})

watch(() => route.path, syncTabFromRoute)

const loadResourceCategories = async () => {
  try { const res = await api.getResourceCategories({}); resourceCategoryData.value = res.data || [] } catch (err) { ElMessage.error('加载资源类别失败') }
}
const loadGoodsTypes = async () => {
  try { const res = await api.getGoodsTypes({}); goodsTypeData.value = res.data || [] } catch (err) { ElMessage.error('加载货型失败') }
}
const openGoodsType = (row = null) => {
  Object.assign(goodsTypeForm, row ? {
    goodsTypeId:row.goods_type_id,
    name:row.name,
    resourceCategoryIds:(row.ResourceCategories || []).map(item => item.category_id),
    sortOrder:Number(row.sort_order || 0),
    status:Number(row.status),
    remark:row.remark || ''
  } : {
    goodsTypeId:'', name:'', resourceCategoryIds:[], sortOrder:0, status:1, remark:''
  })
  goodsTypeDialog.value = true
}
const saveGoodsType = async () => {
  if (!goodsTypeForm.name.trim()) return ElMessage.warning('请输入货型名称')
  submitLoading.value = true
  try {
    await api.saveGoodsType(goodsTypeForm)
    ElMessage.success('货型已保存')
    goodsTypeDialog.value = false
    await loadGoodsTypes()
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存失败')
  } finally {
    submitLoading.value = false
  }
}
const removeGoodsType = async row => {
  try {
    await ElMessageBox.confirm(`确认删除货型“${row.name}”？历史采购记录不会被删除。`, '删除确认', { type:'warning' })
    await api.deleteGoodsType(row.goods_type_id)
    ElMessage.success('货型已删除')
    await loadGoodsTypes()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.response?.data?.message || '删除失败')
  }
}
const openResourceCategory = async (row = null) => {
  const accounts = await api.getAllSettlementAccounts(); resourceAccountOptions.value = accounts.data || []
  Object.assign(resourceCategoryForm, row ? {
    categoryId:row.category_id,name:row.name,shortName:row.short_name||'',defaultAccountId:row.default_account_id||'',
    resourceKind:row.resource_kind||'SALE_USE',
    supportsPurchaseSelect:row.supports_purchase_select !== 0,
    supportsSaleUse:!!row.supports_sale_use,supportsCompanyClaim:!!row.supports_company_claim,
    triggerOnSale:!!row.trigger_on_sale,generatesSettlement:row.generates_settlement !== 0,
    generatesStaffCareCredit:!!row.generates_staff_care_credit,
    affectsPerformanceProfit:!!row.affects_performance_profit,
    performanceProfitRatio:Number(row.performance_profit_ratio ?? 100),
    sortOrder:Number(row.sort_order||0),status:Number(row.status),remark:row.remark||''
  } : {
    categoryId:'',name:'',shortName:'',resourceKind:'SALE_USE',defaultAccountId:'',
    supportsPurchaseSelect:true,supportsSaleUse:true,supportsCompanyClaim:true,triggerOnSale:false,
    generatesSettlement:true,generatesStaffCareCredit:false,affectsPerformanceProfit:false,
    performanceProfitRatio:100,sortOrder:0,status:1,remark:''
  })
  resourceCategoryDialog.value = true
}
const saveResourceCategory = async () => {
  if (!resourceCategoryForm.name.trim()) return ElMessage.warning('请输入类别名称')
  if (resourceCategoryForm.generatesSettlement && !resourceCategoryForm.defaultAccountId) return ElMessage.warning('请选择默认到账账户')
  submitLoading.value=true
  try { await api.saveResourceCategory(resourceCategoryForm); ElMessage.success('资源子内容已保存'); resourceCategoryDialog.value=false; await Promise.all([loadResourceCategories(), loadGoodsTypes()]) }
  catch(err){ ElMessage.error(err.response?.data?.message||'保存失败') } finally { submitLoading.value=false }
}
const removeResourceCategory = async row => {
  try {
    await ElMessageBox.confirm(`确认删除资源子内容“${row.name}”？它会从货型和新业务下拉框中移除，历史记录继续保留。`, '删除确认', { type:'warning' })
    await api.deleteResourceCategory(row.category_id)
    ElMessage.success('资源子内容已删除')
    await Promise.all([loadResourceCategories(), loadGoodsTypes()])
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.response?.data?.message || '删除失败')
  }
}

const onSysTabChange = (tabName) => {
  if (tabName === 'resourceCategories') {
    loadResourceCategories()
    loadGoodsTypes()
  }
  if (tabName === 'customerSource' && customerSourceData.value.length === 0) loadCustomerSources()
  if (tabName === 'paymentMethod') {
    if (paymentMethodData.value.length === 0) loadPaymentMethods()
    loadSubsidyAccountRoutes()
  }
  if (tabName === 'locations' && locationData.value.length === 0) loadLocations()
  if (tabName === 'supplementItem' && supplementItemData.value.length === 0) loadSupplementItems()
  if (tabName === 'expenseType' && expenseTypeData.value.length === 0) loadExpenseTypes()
  if (tabName === 'categoryField' && cfCategoryTree.value.length === 0) cfLoadCategoryTree()
}

const loadUsers = async () => {
  try {
    const res = await api.getUsers({ page: 1, pageSize: 100 })
    if (res.code === 0) userData.value = res.data?.list || []
  } catch (err) { ElMessage.error('加载用户失败') }
}

const loadUserDistributors = async () => {
  try {
    const res = await api.getUserDistributors()
    if (res.code === 0) distributorOptions.value = res.data || []
  } catch (err) { ElMessage.error('加载经销商列表失败') }
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
  restoreSystemDraft('role-create', roleForm)
  roleDialogVisible.value = true
}

const handleEditRole = (row) => {
  if (row.is_system) return
  roleDialogTitle.value = '编辑角色'
  roleForm.roleId = row.role_id
  roleForm.name = row.name || ''
  roleForm.description = row.description || ''
  roleDialogVisible.value = true
}

const handleRoleSubmit = async () => {
  if (!roleForm.name.trim()) { ElMessage.warning('请输入角色名称'); return }

  submitLoading.value = true
  try {
    const data = {
      name: roleForm.name.trim(),
      description: roleForm.description.trim()
    }
    const res = roleForm.roleId
      ? await api.updateRole(roleForm.roleId, data)
      : await api.createRole(data)

    if (res.code === 0) {
      ElMessage.success(roleForm.roleId ? '更新成功' : '创建成功')
      if (!roleForm.roleId) clearSystemDraft('role-create')
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
  roleForm.description = ''
}

const loadMenus = async () => {
  try {
    const res = await api.getMenus()
    if (res.code === 0) {
      menuData.value = res.data || []
      menuReorderDirty.value = false
    }
  } catch (err) { ElMessage.error('加载菜单失败') }
}

const reloadMenus = async () => {
  if (menuReorderDirty.value) {
    try {
      await ElMessageBox.confirm('当前有未保存的菜单调整，重新加载会放弃这些调整。确定继续吗？', '提示', {
        confirmButtonText: '放弃调整',
        cancelButtonText: '继续编辑',
        type: 'warning'
      })
    } catch {
      return
    }
  }
  await loadMenus()
}

const isMenuDescendant = (menu, targetMenuId) => {
  return (menu.children || []).some(child => {
    return String(child.menuId) === String(targetMenuId) || isMenuDescendant(child, targetMenuId)
  })
}

const allowMenuDrop = (draggingNode, dropNode) => {
  if (!draggingNode || !dropNode || draggingNode === dropNode) return false
  return !isMenuDescendant(draggingNode.data, dropNode.data.menuId)
}

const handleMenuDrop = () => {
  menuReorderDirty.value = true
}

const flattenMenuTree = (menus, parentId = null, result = []) => {
  menus.forEach((menu, index) => {
    result.push({
      menuId: menu.menuId,
      parentId,
      sortOrder: index
    })
    flattenMenuTree(menu.children || [], menu.menuId, result)
  })
  return result
}

const saveMenuOrder = async () => {
  if (!menuReorderDirty.value) return
  menuReorderSaving.value = true
  try {
    await api.reorderMenus({ items: flattenMenuTree(menuData.value) })
    ElMessage.success('菜单排序已保存')
    await loadMenus()
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '菜单排序保存失败')
  } finally {
    menuReorderSaving.value = false
  }
}

const loadStores = async () => {
  try {
    const res = await api.getStoreList({ page: 1, pageSize: 100 })
    if (res.code === 0) stores.value = res.data?.list || res.data || []
  } catch (err) { console.error('Failed to load stores') }
}

const loadRegions = async () => {
  try {
    const res = await api.getRegionList()
    if (res.code === 0) regions.value = res.data || []
  } catch (err) { console.error('Failed to load regions') }
}

const loadLocations = async () => {
  locationLoading.value = true
  try {
    const res = await api.getSystemLocations(locationQuery)
    if (res.code === 0) locationData.value = res.data || []
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载库位失败')
  } finally {
    locationLoading.value = false
  }
}

const openLocationDialog = async (row = null) => {
  if (stores.value.length === 0) await loadStores()
  if (row) {
    locationDialogTitle.value = '编辑库位'
    editingLocationId.value = row.type
    const detailRes = await api.getSystemLocations({ keyword: row.type, status: '' })
    const detail = detailRes.code === 0
      ? (detailRes.data || []).find(item => item.type === row.type)
      : row
    locationForm.name = detail?.name || row.name || ''
    locationForm.type = detail?.type || row.type || 'normal_qty'
    locationForm.storeIds = (detail?.stores || row.stores || [])
      .filter(store => Number(store.status) === 1)
      .map(store => store.store_id)
    locationForm.isSellable = Number(detail?.is_sellable ?? row.is_sellable ?? 1)
    locationForm.status = Number(detail?.status ?? row.status ?? 1)
  } else {
    locationDialogTitle.value = '配置库位'
    resetLocationForm()
    locationForm.storeIds = stores.value.map(store => store.store_id)
    restoreSystemDraft('location-create', locationForm)
    handleLocationTypeChange(locationForm.type)
  }
  locationDialogVisible.value = true
}

const handleLocationSubmit = async () => {
  if (!locationForm.type) return ElMessage.warning('请选择库位类型')
  if (!locationForm.name.trim()) return ElMessage.warning('请输入库位名称')
  if (Number(locationForm.status) === 1 && (!Array.isArray(locationForm.storeIds) || locationForm.storeIds.length === 0)) {
    return ElMessage.warning('启用库位时至少选择一个适用门店')
  }

  submitLoading.value = true
  try {
    const data = {
      name: locationForm.name.trim(),
      type: locationForm.type,
      storeIds: locationForm.storeIds,
      isSellable: locationForm.isSellable,
      status: locationForm.status
    }
    const res = editingLocationId.value
      ? await api.updateSystemLocation(editingLocationId.value, data)
      : await api.createSystemLocation(data)

    if (res.code === 0) {
      ElMessage.success(editingLocationId.value ? '库位已更新' : '库位已保存')
      if (!editingLocationId.value) clearSystemDraft('location-create')
      locationDialogVisible.value = false
      await loadLocations()
    } else {
      ElMessage.error(res.message || '保存仓位失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存仓位失败')
  } finally {
    submitLoading.value = false
  }
}

const disableLocation = async row => {
  try {
    await ElMessageBox.confirm(`确认停用库位"${row.name}"？系统会停用当前管理范围内的门店库位；如仍有库存将无法停用。`, '停用库位', { type: 'warning' })
    const res = await api.deleteSystemLocation(row.type)
    if (res.code === 0) {
      ElMessage.success('库位已停用')
      await loadLocations()
    } else {
      ElMessage.error(res.message || '停用仓位失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '停用仓位失败')
  }
}

const handleLocationTypeChange = value => {
  const option = locationTypeOptions.find(item => item.value === value)
  if (!option) return
  if (!locationForm.name || !editingLocationId.value) locationForm.name = option.label
  locationForm.isSellable = option.isSellable
}

const resetLocationForm = () => {
  editingLocationId.value = null
  locationForm.type = 'normal_qty'
  locationForm.name = '销售仓'
  locationForm.storeIds = []
  locationForm.isSellable = 1
  locationForm.status = 1
}

const handleAddUser = () => {
  dialogTitle.value = '新增用户'
  resetUserForm()
  restoreSystemDraft('user-create', userForm)
  userDialogVisible.value = true
}

const handleEditUser = async (row) => {
  dialogTitle.value = '编辑用户'
  currentUser.value = row
  userForm.staffId = row.staff_id
  userForm.name = row.name
  userForm.phone = row.phone
  userForm.password = ''
  userForm.roleIds = (row.role_ids || [])[0] || ''
  userForm.distributorIds = (row.distributor_ids || (row.distributor_id ? [row.distributor_id] : [])).map(String)
  userForm.supervisorStaffId = row.supervisor_staff_id || null
  userForm.status = row.status

  userDialogVisible.value = true
}

const handleAssignScope = async (row) => {
  currentUser.value = row
  dialogStoreIds.value = []
  dialogRegionIds.value = []
  assignableStores.value = []
  assignableRegions.value = []
  dialogScopeType.value = 'combined'
  try {
    const res = await api.getUserRegions(row.staff_id)
    if (res.code === 0) {
      dialogRegionIds.value = res.data?.regionIds || []
      assignableRegions.value = res.data?.regions || (await api.getRegionList()).data || []
      assignableStores.value = res.data?.availableStores || []
      dialogStoreIds.value = (res.data?.storeIds || []).filter(storeId =>
        assignableStores.value.some(store => String(store.store_id) === String(storeId))
      )
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载门店范围失败')
    return
  }
  storeDialogVisible.value = true
}

const handleRoleMenus = async (row) => {
  currentRole.value = row
  menuDialogVisible.value = true
  await nextTick()
  // 对话框复用同一个树实例，切换角色前先清空上一个角色的选中状态。
  menuTreeRef.value?.setCheckedKeys([])
  try {
    const res = await api.getRoleMenus(row.role_id)
    const menuIds = Array.isArray(res)
      ? res
      : (Array.isArray(res?.data) ? res.data : [])
    menuTreeRef.value?.setCheckedKeys(menuIds.map(menuId => String(menuId)))
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载角色权限失败')
  }
}

const handleUserSubmit = async () => {
  if (!userForm.name) { ElMessage.warning('请输入姓名'); return }
  if (!userForm.phone) { ElMessage.warning('请输入手机号'); return }
  if (!userForm.staffId && !userForm.password) { ElMessage.warning('请输入初始密码'); return }
  if (!userForm.roleIds) { ElMessage.warning('请选择岗位角色'); return }

  submitLoading.value = true
  try {
    const data = {
      name: userForm.name,
      phone: userForm.phone,
      roleIds: [userForm.roleIds],
      distributorIds: userForm.distributorIds,
      supervisorStaffId: userForm.supervisorStaffId || null,
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
      if (!userForm.staffId) clearSystemDraft('user-create')
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

const handleToggleUserStatus = async (row) => {
  const nextStatus = row.status === 1 ? 0 : 1
  const actionText = nextStatus === 1 ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(
      `确认${actionText}账号"${row.name}"？${nextStatus === 0 ? '停用后该账号将无法登录，已登录状态也会在下次请求时失效。' : ''}`,
      `确认${actionText}`,
      { type: nextStatus === 1 ? 'warning' : 'error' }
    )
    const res = await api.updateUser(row.staff_id, { status: nextStatus })
    if (res.code === 0) {
      ElMessage.success(`${actionText}成功`)
      await loadUsers()
    } else {
      ElMessage.error(res.message || `${actionText}失败`)
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || err.message || `${actionText}失败`)
    }
  }
}

const handleResetPassword = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将账号"${row.name}"的密码重置为手机号后6位？`,
      '确认重置密码',
      { type: 'warning' }
    )
    const res = await api.resetUserPassword(row.staff_id)
    if (res.code === 0) {
      const defaultPassword = res.data?.defaultPassword || ''
      ElMessage.success(defaultPassword ? `密码已重置，默认密码：${defaultPassword}` : '密码已重置')
    } else {
      ElMessage.error(res.message || '重置密码失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || err.message || '重置密码失败')
    }
  }
}

const handleScopeDialogSubmit = async () => {
  submitLoading.value = true
  try {
    if (dialogRegionIds.value.length > 0 && dialogStoreIds.value.length === 0) {
      ElMessage.warning('选择区域后至少选择一家门店')
      return
    }
    const allowedStoreIds = new Set(filteredAssignableStores.value.map(store => String(store.store_id)))
    if (dialogStoreIds.value.some(storeId => !allowedStoreIds.has(String(storeId)))) {
      ElMessage.warning('只能选择所选区域内的门店')
      return
    }
    const payload = { regionIds: dialogRegionIds.value, storeIds: dialogStoreIds.value }
    const res = await api.assignUserRegions(currentUser.value.staff_id, payload)
    if (res.code === 0) {
      ElMessage.success('区域及门店分配成功')
      storeDialogVisible.value = false
      await loadUsers()
    } else {
      ElMessage.error(res.message || '分配失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '分配失败')
  } finally {
    submitLoading.value = false
  }
}

const handleMenuSubmit = async () => {
  const checkedKeys = [...new Set([
    ...(menuTreeRef.value?.getCheckedKeys(false) || []),
    ...(menuTreeRef.value?.getHalfCheckedKeys() || [])
  ].map(menuId => String(menuId)))]
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
  userForm.roleIds = ''
  userForm.distributorIds = operatorUser.distributorIds || operatorUser.accessibleDistributorIds || (operatorUser.distributorId ? [operatorUser.distributorId] : [distributorOptions.value[0]?.distributor_id].filter(Boolean))
  userForm.supervisorStaffId = null
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
    restoreSystemDraft('customer-source-create', csForm)
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
      if (!editingCsId.value) clearSystemDraft('customer-source-create')
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
const pmForm = reactive({ name: '', defaultTaxRate: 0, settlementAccountId: '', receivableSettlementAccountId: '', isGlobal: true, sortOrder: 0 })
const pmStoreConfigRows = ref([])
const settlementAccounts = ref([])
const policyReceivableAccounts = computed(() => settlementAccounts.value.filter(a => a.account_type === 'POLICY_RECEIVABLE'))
const fundAccounts = computed(() => settlementAccounts.value.filter(a => a.account_type === 'FUND'))
const subsidyAccountRoutes = ref([])
const isGuobuPaymentMethod = name => String(name || '').startsWith('国补POS')

const loadSubsidyAccountRoutes = async () => {
  try {
    const [routeRes] = await Promise.all([api.getSubsidyAccountRoutes(), loadSettlementAccounts()])
    subsidyAccountRoutes.value = routeRes.data || []
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载国补到账账户配置失败')
  }
}

const saveSubsidyAccountRoute = async row => {
  try {
    await api.saveSubsidyAccountRoute({ regionId: row.region_id, accountId: row.account_id || '' })
    ElMessage.success('区域到账账户已保存')
    await loadSubsidyAccountRoutes()
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存失败')
  }
}

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
  pmStoreConfigRows.value = (stores.value || []).map(s => ({
    store_id: s.store_id,
    name: s.name,
    checked: false,
    accountId: '',
    receivableAccountId: ''
  }))

  if (row) {
    pmDialogTitle.value = '编辑收款方式'
    editingPmId.value = row.method_id
    pmForm.name = row.name
    pmForm.defaultTaxRate = Number(row.default_tax_rate || 0)
    pmForm.settlementAccountId = row.settlement_account_id || ''
    pmForm.receivableSettlementAccountId = row.receivable_settlement_account_id || ''
    pmForm.isGlobal = row.is_global === 1 || row.is_global === true
    pmForm.sortOrder = row.sort_order || 0
    if (row.Stores && row.Stores.length > 0) {
      pmForm.isGlobal = false
      const storeMap = new Map()
      row.Stores.forEach(s => {
        storeMap.set(s.store_id, {
          accountId: s.PaymentMethodStore?.settlement_account_id || '',
          receivableAccountId: s.PaymentMethodStore?.receivable_settlement_account_id || ''
        })
      })
      pmStoreConfigRows.value.forEach(r => {
        if (storeMap.has(r.store_id)) {
          r.checked = true
          r.accountId = storeMap.get(r.store_id).accountId
          r.receivableAccountId = storeMap.get(r.store_id).receivableAccountId
        }
      })
    }
  } else {
    pmDialogTitle.value = '新增收款方式'
    editingPmId.value = null
    pmForm.name = ''
    pmForm.defaultTaxRate = 0
    pmForm.settlementAccountId = ''
    pmForm.receivableSettlementAccountId = ''
    pmForm.isGlobal = true
    pmForm.sortOrder = (paymentMethodData.value.length || 0) + 1
    restorePaymentMethodDraft()
  }
  paymentMethodDialogVisible.value = true
}

const onPmIsGlobalChange = () => {
  if (pmForm.isGlobal) {
    pmStoreConfigRows.value.forEach(r => { r.checked = false; r.accountId = ''; r.receivableAccountId = '' })
  }
}

const onPmStoreChecked = (row) => {
  if (!row.checked) {
    row.accountId = ''
    row.receivableAccountId = ''
  }
}

const savePaymentMethodDraft = () => {
  saveDraft('system:payment-method-create', {
    pmForm: cloneDraft(pmForm),
    pmStoreConfigRows: cloneDraft(pmStoreConfigRows.value)
  })
  ElMessage.success('草稿已保存')
}

const restorePaymentMethodDraft = () => {
  const draft = loadDraft('system:payment-method-create')
  if (!draft) return
  Object.assign(pmForm, draft.pmForm || {})
  if (Array.isArray(draft.pmStoreConfigRows)) {
    pmStoreConfigRows.value = draft.pmStoreConfigRows
  }
  ElMessage.success('已恢复上次草稿')
}

const handlePmSubmit = async () => {
  if (!pmForm.name) { ElMessage.warning('请输入名称'); return }
  submitLoading.value = true
  try {
    let res
    const checkedRows = pmStoreConfigRows.value.filter(r => r.checked)
    const storeConfigs = checkedRows.map(r => ({
      storeId: r.store_id,
      settlementAccountId: r.accountId || null,
      receivableSettlementAccountId: isGuobuPaymentMethod(pmForm.name) ? r.receivableAccountId || null : null
    }))
    const data = {
      name: pmForm.name,
      defaultTaxRate: Number(pmForm.defaultTaxRate || 0),
      isGlobal: pmForm.isGlobal,
      settlementAccountId: pmForm.isGlobal ? pmForm.settlementAccountId : null,
      receivableSettlementAccountId: pmForm.isGlobal && isGuobuPaymentMethod(pmForm.name)
        ? pmForm.receivableSettlementAccountId
        : null,
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
      if (!editingPmId.value) clearSystemDraft('payment-method-create')
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
  pmForm.defaultTaxRate = 0
  pmForm.settlementAccountId = ''
  pmForm.receivableSettlementAccountId = ''
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
const saForm = reactive({ accountName: '', accountType: 'FUND', distributorId: '', regionId: '', bankName: '', accountNumber: '', usageNote: '', sortOrder: 0 })
const accountTypeText = value => ({ FUND:'资金账户', POLICY_RECEIVABLE:'政策补贴应收', CARE_CREDIT:'Care可用金' }[value] || '资金账户')

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
    saForm.accountType = row.account_type || 'FUND'
    saForm.distributorId = row.distributor_id || ''
    saForm.regionId = row.region_id || row.Region?.region_id || ''
    saForm.usageNote = row.usage_note || ''
    saForm.sortOrder = row.sort_order || 0
  } else {
    saDialogTitle.value = '新增结算账号'
    editingSaId.value = null
    saForm.accountName = ''
    saForm.bankName = ''
    saForm.accountNumber = ''
    saForm.accountType = 'FUND'
    saForm.distributorId = ''
    saForm.regionId = ''
    saForm.usageNote = ''
    saForm.sortOrder = 0
    restoreSystemDraft('settlement-account-create', saForm)
  }
  saFormDialogVisible.value = true
}

const handleSaSubmit = async () => {
  if (!saForm.accountName) { ElMessage.warning('请输入账号名称'); return }
  submitLoading.value = true
  try {
    let res
    const data = { accountName: saForm.accountName, accountType: saForm.accountType, distributorId: saForm.distributorId || null, regionId: saForm.regionId || null, bankName: saForm.bankName, accountNumber: saForm.accountNumber, usageNote: saForm.usageNote, sortOrder: saForm.sortOrder }
    if (editingSaId.value) {
      res = await api.updateSettlementAccount(editingSaId.value, data)
    } else {
      res = await api.createSettlementAccount(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingSaId.value ? '更新成功' : '创建成功')
      if (!editingSaId.value) clearSystemDraft('settlement-account-create')
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
  saForm.accountType = 'FUND'
  saForm.distributorId = ''
  saForm.regionId = ''
  saForm.bankName = ''
  saForm.accountNumber = ''
  saForm.usageNote = ''
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
const siForm = reactive({ name: '', amount: 0, amountType: 'increase', sortOrder: 0 })

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
    siForm.amountType = row.amount_type === 'decrease' ? 'decrease' : 'increase'
    siForm.sortOrder = row.sort_order || 0
  } else {
    siDialogTitle.value = '新增项目'
    editingSiId.value = null
    siForm.name = ''
    siForm.amount = 0
    siForm.amountType = 'increase'
    siForm.sortOrder = (supplementItemData.value.length || 0) + 1
    restoreSystemDraft('supplement-item-create', siForm)
  }
  supplementItemDialogVisible.value = true
}

const handleSiSubmit = async () => {
  if (!siForm.name) { ElMessage.warning('请输入名称'); return }
  submitLoading.value = true
  try {
    let res
    const data = { name: siForm.name, amount: siForm.amount, amountType: siForm.amountType, sortOrder: siForm.sortOrder }
    if (editingSiId.value) {
      res = await api.updateSupplementItem(editingSiId.value, data)
    } else {
      res = await api.createSupplementItem(data)
    }
    if (res.code === 0) {
      ElMessage.success(editingSiId.value ? '更新成功' : '创建成功')
      if (!editingSiId.value) clearSystemDraft('supplement-item-create')
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
  siForm.amountType = 'increase'
  siForm.sortOrder = 0
  editingSiId.value = null
}

// ==============================================
// 字典管理 - 报销类型
// ==============================================
const expenseTypeData = ref([])
const expenseTypeDialogVisible = ref(false)
const etDialogTitle = ref('新增报销类型')
const editingEtId = ref(null)
const etForm = reactive({ name: '', sortOrder: 0, status: 1, remark: '' })

const loadExpenseTypes = async () => {
  try {
    const res = await api.getExpenseTypes({ activeOnly: false })
    if (res.code === 0) expenseTypeData.value = res.data || []
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '加载报销类型失败')
  }
}

const openExpenseTypeDialog = (row = null) => {
  if (row) {
    etDialogTitle.value = '编辑报销类型'
    editingEtId.value = row.type_id
    etForm.name = row.name || ''
    etForm.sortOrder = Number(row.sort_order || 0)
    etForm.status = Number(row.status) === 0 ? 0 : 1
    etForm.remark = row.remark || ''
  } else {
    etDialogTitle.value = '新增报销类型'
    editingEtId.value = null
    etForm.name = ''
    etForm.sortOrder = (expenseTypeData.value.length || 0) + 1
    etForm.status = 1
    etForm.remark = ''
    restoreSystemDraft('expense-type-create', etForm)
  }
  expenseTypeDialogVisible.value = true
}

const handleEtSubmit = async () => {
  if (!etForm.name.trim()) {
    ElMessage.warning('请输入报销类型名称')
    return
  }
  submitLoading.value = true
  try {
    const data = {
      name: etForm.name.trim(),
      sortOrder: Number(etForm.sortOrder || 0),
      status: Number(etForm.status) === 0 ? 0 : 1,
      remark: etForm.remark || ''
    }
    const res = editingEtId.value
      ? await api.updateExpenseType(editingEtId.value, data)
      : await api.createExpenseType(data)
    if (res.code === 0) {
      ElMessage.success(editingEtId.value ? '更新成功' : '创建成功')
      if (!editingEtId.value) clearSystemDraft('expense-type-create')
      expenseTypeDialogVisible.value = false
      await loadExpenseTypes()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '保存失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDeleteExpenseType = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除报销类型"${row.name}"？`, '确认删除', { type: 'warning' })
    const res = await api.deleteExpenseType(row.type_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      await loadExpenseTypes()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err?.response?.data?.message || err?.message || '删除失败')
    }
  }
}

const resetEtForm = () => {
  etForm.name = ''
  etForm.sortOrder = 0
  etForm.status = 1
  etForm.remark = ''
  editingEtId.value = null
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
  restoreCategoryFieldDraft()
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
    clearDraft('system:category-field-create')
  }
  cfDialogVisible.value = false
}

const saveCategoryFieldDraft = () => {
  saveDraft('system:category-field-create', {
    cfFieldForm: cloneDraft(cfFieldForm),
    cfOptionInput: cfOptionInput.value
  })
  ElMessage.success('草稿已保存')
}

const restoreCategoryFieldDraft = () => {
  const draft = loadDraft('system:category-field-create')
  if (!draft?.cfFieldForm) return
  Object.assign(cfFieldForm, draft.cfFieldForm)
  cfFieldForm.options = Array.isArray(draft.cfFieldForm.options) ? draft.cfFieldForm.options : []
  cfOptionInput.value = draft.cfOptionInput || ''
  ElMessage.success('已恢复上次草稿')
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
.module-tabs :deep(.el-tabs__header) {
  display: none;
}

.filter-bar {
  margin-bottom: 16px;
}

.menu-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.menu-help,
.menu-tree-path {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.menu-order-alert {
  margin-bottom: 16px;
}

.menu-tree-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.config-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 12px;
}

.store-permission-selector {
  width: 100%;
  min-width: 0;
}

.store-select-all {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.store-selected-count {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.store-checkbox-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  padding-top: 12px;
}

.store-checkbox-list :deep(.el-checkbox) {
  min-width: 0;
  margin-right: 0;
}

.store-checkbox-list :deep(.el-checkbox__label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
