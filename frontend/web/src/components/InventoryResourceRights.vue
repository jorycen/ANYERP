<template>
  <div class="resource-rights">
    <el-tabs v-model="tab" @tab-change="loadActive">
      <el-tab-pane v-if="!financeOnly" label="首页" name="rights">
        <div v-if="canManageCategories" class="category-management-entry">
          <el-button @click="openCategoryManagement">权益类型管理</el-button>
        </div>
        <div class="filter-bar">
          <el-input v-model="rightsQuery.snCode" placeholder="SN码" clearable style="width:220px" />
          <el-input v-model="rightsQuery.pnCode" placeholder="商品PN" clearable style="width:180px" @keyup.enter="loadRights" />
          <el-select v-model="rightsQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="rightsQuery.status" placeholder="状态" clearable style="width:130px">
            <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button type="primary" @click="loadRights">查询</el-button>
          <el-button :loading="rightsExporting" @click="exportRights">导出</el-button>
          <el-button @click="openBySn">初始化/维护SN权益</el-button>
          <el-button @click="openBatchAdjust">批量调整权益</el-button>
        </div>
        <el-table :data="rights" border stripe v-loading="loading">
          <el-table-column prop="sn_code" label="SN" min-width="170" />
          <el-table-column label="PN" min-width="140"><template #default="{row}">{{ row.ProductSn?.pn_code || '-' }}</template></el-table-column>
          <el-table-column label="商品" min-width="180"><template #default="{row}">{{ row.Product?.name || row.product_id }}</template></el-table-column>
          <el-table-column label="权益" width="120"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="statusType(row.current_status)">{{ statusText(row.current_status) }}</el-tag></template></el-table-column>
          <el-table-column prop="amount" label="确认金额" width="110"><template #default="{row}">¥{{ money(row.amount) }}</template></el-table-column>
          <el-table-column prop="update_time" label="更新时间" width="170" />
          <el-table-column label="操作" width="330" fixed="right"><template #default="{row}">
            <el-button link type="primary" @click="editSn(row.sn_id)">详情/维护</el-button>
            <el-button v-if="row.resource_type === 'EDU_SUBSIDY' && row.current_status === 'AVAILABLE' && row.ProductSn?.status !== 'in_stock'" link type="success" @click="openEducationSupplement(row)">资源补录</el-button>
            <el-button v-if="row.resource_type === 'OTHER_POLICY' && row.current_status === 'AVAILABLE'" link type="success" @click="completeOtherPolicy(row)">已完成</el-button>
            <el-button v-if="row.current_status === 'AVAILABLE' && row.resource_type !== 'OTHER_POLICY'" link type="warning" @click="openClaim(row)">申请套回</el-button>
            <el-button v-if="canReverse(row)" link type="danger" @click="reverseSaleUse(row)">冲销核销</el-button>
          </template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="rightsQuery.page" v-model:page-size="rightsQuery.pageSize" :total="rightsTotal" layout="total, prev, pager, next" @current-change="loadRights" />
      </el-tab-pane>

      <el-tab-pane v-if="!financeOnly" label="教育优惠政策" name="education-policy">
        <div class="filter-bar">
          <el-alert title="上传教育优惠政策表后，系统更新当前有效政策及符合条件的库存 SN 权益；已售商品按销售归档时的政策处理。" type="info" :closable="false" />
        </div>
        <div class="filter-bar">
          <el-input v-model="educationPolicyQuery.pn" placeholder="按商品编号/PN筛选" clearable style="width:210px" @keyup.enter="loadEducationPolicies" />
          <el-button type="primary" @click="loadEducationPolicies">查询/刷新</el-button>
          <el-button type="success" @click="openEducationImport">上传教育优惠表</el-button>
        </div>
        <el-table :data="educationPolicies" border stripe v-loading="educationPolicyLoading">
          <el-table-column prop="pn" label="商品编号/PN" min-width="150" />
          <el-table-column prop="productName" label="商品名称" min-width="180" />
          <el-table-column label="学生优惠" width="125" align="right"><template #default="{row}">¥{{ money(row.studentDiscount) }}</template></el-table-column>
          <el-table-column label="资源回算金额" width="140" align="right"><template #default="{row}">¥{{ money(row.resourceRecalculationAmount) }}</template></el-table-column>
          <el-table-column label="有效期" min-width="190"><template #default="{row}">{{ dateText(row.promotionStart) }} 至 {{ dateText(row.promotionEnd) }}</template></el-table-column>
          <el-table-column prop="sourceSheet" label="来源工作表" min-width="140" show-overflow-tooltip />
          <el-table-column prop="update_time" label="导入时间" width="170" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane v-if="!financeOnly" label="产品运作政策" name="nb-policy">
        <div class="filter-bar">
          <el-alert title="按PN维护商品结算价及SO、PO、其他政策；SO政策用于采购提醒，PO政策用于销售归档审批，其他政策用于销售后资源跟进。" type="info" :closable="false" />
        </div>
        <div class="filter-bar">
          <el-input v-model="nbPolicyQuery.pn" placeholder="PN" clearable style="width:180px" @keyup.enter="loadNbPolicies" />
          <el-button @click="loadNbPolicies">查询</el-button>
          <el-button type="primary" @click="openNbPolicyImport">上传产品政策表</el-button>
        </div>
        <el-table :data="nbPolicies" border stripe v-loading="nbPolicyLoading">
          <el-table-column prop="pn" label="PN" min-width="140" />
          <el-table-column prop="product_name" label="商品名称" min-width="160" />
        <el-table-column prop="settlement_price" label="结算价" width="110"><template #default="{row}">¥{{ money(row.settlement_price) }}</template></el-table-column>
        <el-table-column prop="so_policy" label="SO政策" min-width="180" show-overflow-tooltip />
        <el-table-column prop="po_policy" label="PO政策" min-width="180" show-overflow-tooltip />
        <el-table-column prop="other_policy" label="其他政策" min-width="180" show-overflow-tooltip />
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
        <el-pagination v-model:current-page="nbPolicyQuery.page" v-model:page-size="nbPolicyQuery.pageSize" :total="nbPolicyTotal" layout="total, prev, pager, next" @current-change="loadNbPolicies" />
      </el-tab-pane>

      <el-tab-pane v-if="!financeOnly" label="销售红包管理" name="sales-cash-rebate" lazy>
        <SalesCashRebateManagement />
      </el-tab-pane>

      <el-tab-pane :label="financeOnly ? '资源套回审批' : '权益变更记录'" name="changes">
        <div class="filter-bar">
          <el-input v-model="changeQuery.snCode" placeholder="SN码" clearable style="width:210px" />
          <el-select v-model="changeQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="changeQuery.approvalStatus" placeholder="审批状态" clearable style="width:140px">
            <el-option label="待财务审批" value="pending_finance" /><el-option label="已通过" value="approved" /><el-option label="已拒绝" value="rejected" />
          </el-select>
          <el-button type="primary" @click="loadChanges">查询</el-button>
        </div>
        <el-table :data="changes" border stripe v-loading="loading">
          <el-table-column prop="change_order_no" label="变更单号" min-width="190" />
          <el-table-column prop="sn_code" label="SN" min-width="160" />
          <el-table-column label="权益" width="110"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="状态变化" width="170"><template #default="{row}">{{ statusText(row.before_status) }} → {{ statusText(row.after_status) }}</template></el-table-column>
          <el-table-column prop="change_amount" label="金额" width="100"><template #default="{row}">¥{{ money(row.change_amount) }}</template></el-table-column>
          <el-table-column label="原因" width="130"><template #default="{row}">{{ reasonText(row.change_reason) }}</template></el-table-column>
          <el-table-column label="凭证" width="90"><template #default="{row}"><el-button v-if="row.attachment_url" link type="primary" @click="openAttachment(row.attachment_url)">查看</el-button><span v-else>—</span></template></el-table-column>
          <el-table-column label="审批" width="110"><template #default="{row}"><el-tag>{{ approvalText(row.approval_status) }}</el-tag></template></el-table-column>
          <el-table-column prop="applicant_name" label="申请人" width="100" />
          <el-table-column prop="reviewer_name" label="审批人" width="100" />
          <el-table-column prop="create_time" label="时间" width="170" />
          <el-table-column v-if="financeOnly" label="操作" width="130" fixed="right"><template #default="{row}">
            <template v-if="row.approval_status === 'pending_finance'">
              <el-button link type="success" @click="review(row, 'approve')">通过</el-button>
              <el-button link type="danger" @click="review(row, 'reject')">拒绝</el-button>
            </template>
          </template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="changeQuery.page" v-model:page-size="changeQuery.pageSize" :total="changeTotal" layout="total, prev, pager, next" @current-change="loadChanges" />
      </el-tab-pane>

      <el-tab-pane label="商品资源成本定义" name="costs">
        <div class="filter-bar">
          <el-select v-model="costForm.productId" filterable remote reserve-keyword placeholder="搜索商品" :remote-method="searchProducts" :loading="productLoading" style="width:300px">
            <el-option v-for="item in products" :key="item.product_id" :label="`${item.name} (${item.pn || ''})`" :value="item.product_id" />
          </el-select>
          <el-select v-model="costForm.resourceType" placeholder="权益类型" style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="costForm.supplierId" filterable clearable placeholder="适用供应商" style="width:180px" @change="onCostSupplierChange">
            <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
          </el-select>
          <el-select v-model="costForm.calculationType" style="width:170px">
            <el-option label="固定金额" value="fixed_amount" />
            <el-option label="按库存成本比例" value="percentage_inventory_cost" />
            <el-option label="按销售金额比例" value="percentage_sale_amount" />
          </el-select>
          <el-input-number v-model="costForm.costAmount" :min="0" :precision="2" />
          <el-date-picker v-model="costForm.effectiveRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="生效日期" end-placeholder="失效日期" style="width:250px" />
          <el-select v-model="costForm.triggerCondition" style="width:180px">
            <el-option label="销售归档即触发" value="sale_archived" />
            <el-option label="入库后限时售出" value="sold_within_days" />
          </el-select>
          <el-input-number v-if="costForm.triggerCondition === 'sold_within_days'" v-model="costForm.saleWithinDays" :min="1" :precision="0" />
          <el-checkbox v-model="costForm.affectsPerformanceProfit">计入销售者毛利</el-checkbox>
          <el-input-number v-model="costForm.performanceProfitRatio" :min="0" :max="100" :precision="2" />
          <el-input v-model="costForm.remark" placeholder="备注" style="width:220px" />
          <el-button type="primary" @click="saveCost">保存定义</el-button>
          <el-button @click="loadCosts">刷新</el-button>
          <el-button @click="batchRefresh">按规则刷新未售SN</el-button>
        </div>
        <el-alert title="该配置用于采购入库生成SN权益、PO奖励、销售个人Care可用金和可选销售者毛利调整；已归档销售单不会被批量刷新改写。" type="info" :closable="false" style="margin-bottom:12px" />
        <el-table :data="costs" border stripe>
          <el-table-column label="商品" min-width="220"><template #default="{row}">{{ row.Product?.name || row.product_id }}</template></el-table-column>
          <el-table-column label="权益类型" width="140"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column prop="supplier_name" label="供应商" min-width="140" />
          <el-table-column label="算法" width="140"><template #default="{row}">{{ calcTypeText(row.calculation_type) }}</template></el-table-column>
          <el-table-column label="定义金额" width="130"><template #default="{row}">¥{{ money(row.cost_amount) }}</template></el-table-column>
          <el-table-column label="有效期" min-width="180"><template #default="{row}">{{ rulePeriodText(row) }}</template></el-table-column>
          <el-table-column label="触发条件" min-width="150"><template #default="{row}">{{ triggerText(row) }}</template></el-table-column>
          <el-table-column label="计入毛利" width="120"><template #default="{row}">{{ row.affects_performance_profit ? `${row.performance_profit_ratio || 100}%` : '否' }}</template></el-table-column>
          <el-table-column prop="remark" label="备注" min-width="180" />
          <el-table-column prop="update_user" label="更新人" width="100" />
          <el-table-column prop="update_time" label="更新时间" width="170" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="产品资源成本流水" name="cost-ledger">
        <div class="filter-bar">
          <el-input v-model="ledgerQuery.snCode" placeholder="SN码" clearable style="width:220px" />
          <el-select v-model="ledgerQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button type="primary" @click="loadLedger">查询</el-button>
        </div>
        <el-table :data="ledger" border stripe>
          <el-table-column prop="sn_code" label="SN" min-width="170" />
          <el-table-column label="权益类型" width="140"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="调整金额" width="120"><template #default="{row}">¥{{ money(row.adjustment_amount) }}</template></el-table-column>
          <el-table-column label="调整前成本" width="130"><template #default="{row}">¥{{ money(row.before_product_cost) }}</template></el-table-column>
          <el-table-column label="调整后成本" width="130"><template #default="{row}">¥{{ money(row.after_product_cost) }}</template></el-table-column>
          <el-table-column label="影响销售成本" width="120"><template #default>否</template></el-table-column>
          <el-table-column prop="source_id" label="来源单ID" min-width="180" />
          <el-table-column prop="operator_name" label="确认人" width="100" />
          <el-table-column prop="create_time" label="确认时间" width="170" />
        </el-table>
        <el-pagination v-model:current-page="ledgerQuery.page" :total="ledgerTotal" layout="total, prev, pager, next" @current-change="loadLedger" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="categoryManagementVisible" title="权益类型管理" width="900px">
      <div class="category-management-header">
        <span class="category-management-hint">配置权益名称、类型及到账账户；例如教育补贴进入返利池，销售红包进入微信账户。</span>
        <el-button type="primary" @click="openCategoryEditor()">添加权益类型</el-button>
      </div>
      <el-table :data="resourceCategories" border stripe v-loading="categoryLoading" style="margin-top:14px">
        <el-table-column prop="name" label="权益名称" min-width="150" />
        <el-table-column label="类型" width="150"><template #default="{row}">{{ categoryKindText(row.resource_kind) }}</template></el-table-column>
        <el-table-column label="到账账户" min-width="180"><template #default="{row}">{{ row.DefaultAccount?.account_name || '未设置' }}</template></el-table-column>
        <el-table-column label="适用场景" min-width="220"><template #default="{row}">{{ categoryScenarioText(row) }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{row}"><el-tag :type="Number(row.status) === 1 ? 'success' : 'info'">{{ Number(row.status) === 1 ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{row}">
            <el-button link type="primary" @click="openCategoryEditor(row)">编辑</el-button>
            <el-button v-if="isCustomCategory(row)" link type="danger" @click="removeCategory(row)">删除</el-button>
            <el-tooltip v-else content="系统权益类型被业务流程引用，不能删除" placement="top"><span class="system-category-label">系统</span></el-tooltip>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无权益类型" /></template>
      </el-table>
    </el-dialog>

    <el-dialog v-model="categoryEditorVisible" :title="categoryForm.categoryId ? '编辑权益类型' : '添加权益类型'" width="600px">
      <el-form label-width="110px">
        <el-form-item label="权益名称" required><el-input v-model="categoryForm.name" maxlength="128" placeholder="如：教育补贴、销售红包" /></el-form-item>
        <el-form-item label="类型" required>
          <el-select v-model="categoryForm.resourceKind" style="width:100%">
            <el-option v-for="item in categoryKindOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="到账账户">
          <el-select v-model="categoryForm.defaultAccountId" clearable filterable placeholder="选择权益到账账户" style="width:100%">
            <el-option v-for="account in settlementAccounts" :key="account.account_id" :label="account.account_name" :value="account.account_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购可选"><el-switch v-model="categoryForm.supportsPurchaseSelect" /></el-form-item>
        <el-form-item label="销售可用"><el-switch v-model="categoryForm.supportsSaleUse" /></el-form-item>
        <el-form-item label="销售触发"><el-switch v-model="categoryForm.triggerOnSale" /></el-form-item>
        <el-form-item label="生成待下账"><el-switch v-model="categoryForm.generatesSettlement" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="categoryForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="categoryForm.remark" type="textarea" maxlength="512" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="categoryEditorVisible=false">取消</el-button><el-button type="primary" :loading="categorySaving" @click="saveCategory">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="snDialog" title="SN资源权益" width="720px">
      <template v-if="snDetail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="SN">{{ snDetail.sn?.sn_code }}</el-descriptions-item>
          <el-descriptions-item label="货品销售标签"><el-tag>{{ snDetail.sales_resource_label }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="可用资源">
            <div>{{ snDetail.available_resource_summary }}</div>
            <el-button v-for="right in (snDetail.rights || []).filter(item => item.resource_type === 'OTHER_POLICY' && item.current_status === 'AVAILABLE')" :key="right.right_id" link type="success" @click="completeOtherPolicy(right)">已完成</el-button>
          </el-descriptions-item>
          <el-descriptions-item label="不可用资源">{{ snDetail.unavailable_resource_summary }}</el-descriptions-item>
        </el-descriptions>
        <el-form label-width="110px" style="margin-top:16px">
          <el-form-item label="税务属性"><el-radio-group v-model="snForm.taxType"><el-radio value="TAX_INCLUDED">含税</el-radio><el-radio value="UNTAXED">未税</el-radio><el-radio value="UNKNOWN">未知</el-radio></el-radio-group></el-form-item>
          <el-form-item label="货源性质"><el-select v-model="snForm.sourceType"><el-option label="正规含税货" value="REGULAR_TAX" /><el-option label="未税货" value="UNTAXED" /><el-option label="渠道资源货" value="CHANNEL_RESOURCE" /><el-option label="活动资源货" value="PROMOTION_RESOURCE" /><el-option label="特价货" value="SPECIAL_PRICE" /><el-option label="其他" value="OTHER" /></el-select></el-form-item>
        </el-form>
        <el-table :data="snForm.rights" border>
          <el-table-column label="权益"><template #default="{row}">{{ resourceText(row.resourceType) }}</template></el-table-column>
          <el-table-column label="状态"><template #default="{row}"><el-select v-model="row.status"><el-option v-for="item in statusOptions.filter(s => s.value !== 'LOCKED')" :key="item.value" :label="item.label" :value="item.value" /></el-select></template></el-table-column>
          <el-table-column label="金额"><template #default="{row}"><el-input-number v-model="row.amount" :min="0" :precision="2" /></template></el-table-column>
          <el-table-column label="备注"><template #default="{row}"><el-input v-model="row.remark" /></template></el-table-column>
        </el-table>
      </template>
      <template #footer><el-button @click="snDialog=false">取消</el-button><el-button type="primary" @click="saveSn">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="claimDialog" title="资源套回申请" width="520px">
      <el-form label-width="110px">
        <el-form-item label="SN">{{ claimForm.snCode }}</el-form-item>
        <el-form-item label="套回资源">{{ resourceText(claimForm.resourceType) }}</el-form-item>
        <el-form-item label="套回金额"><el-input-number v-model="claimForm.amount" :min="0.01" :precision="2" /></el-form-item>
        <el-form-item label="凭证地址"><el-input v-model="claimForm.attachmentUrl" placeholder="附件或凭证地址" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="claimForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="claimDialog=false">取消</el-button><el-button type="primary" @click="submitClaim">提交财务审批</el-button></template>
    </el-dialog>

    <el-dialog v-model="educationSupplementDialog" title="教育优惠资源补录" width="560px">
      <el-alert title="仅限已归档、且归档时未使用教育补贴的商品。确认后供应商待下账按资源回算金额全额增加，员工业绩毛利按学生优惠金额的80%增加。" type="info" :closable="false" style="margin-bottom:14px" />
      <el-form label-width="110px">
        <el-form-item label="商品SN">{{ educationSupplementForm.snCode }}</el-form-item>
        <el-form-item label="销售单号" required><el-input v-model="educationSupplementForm.orderNo" placeholder="请输入已归档销售单号" maxlength="64" /></el-form-item>
        <el-form-item label="优惠凭证" required>
          <input ref="educationProofInput" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style="display:none" @change="onEducationProofChange" />
          <el-button :loading="educationProofUploading" @click="educationProofInput?.click()">上传图片或PDF</el-button>
          <span v-if="educationSupplementForm.attachmentUrl" class="file-name">已上传</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="educationSupplementDialog=false">取消</el-button>
        <el-button type="primary" :loading="educationSupplementSubmitting" :disabled="!educationSupplementForm.orderNo || !educationSupplementForm.attachmentUrl" @click="submitEducationSupplement">确认补录</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="educationImportDialog" title="上传教育优惠表" width="760px" destroy-on-close>
      <el-alert title="选择教育优惠Excel文件后开始导入；完成后可在此查看成功商品、更新库存SN数及失败原因。" type="info" :closable="false" style="margin-bottom:14px" />
      <input ref="educationFileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onEducationFileChange" />
      <el-button :disabled="educationImporting" @click="educationFileInput?.click()">选择Excel文件</el-button>
      <span v-if="educationFile" class="file-name">{{ educationFile.name }}</span>
      <el-button v-if="educationImportResult" link type="primary" @click="educationImportResult=null">清除上次结果</el-button>
      <div v-if="educationImportResult" class="import-result">
        <el-result :icon="educationImportResult.failed ? 'warning' : 'success'" :title="educationImportResult.message" :sub-title="`成功 ${educationImportResult.success} 个商品，过期/未生效跳过 ${educationImportResult.skipped} 个，失败 ${educationImportResult.failed} 条，清理过期权益 ${educationImportResult.clearedRights} 条，更新在库SN ${educationImportResult.affectedSn} 台`" />
        <el-table v-if="educationImportResult.rows.length" :data="educationImportResult.rows" border max-height="300">
          <el-table-column prop="productCode" label="商品编号" min-width="150" />
          <el-table-column prop="sheet" label="工作表" min-width="120" />
          <el-table-column prop="row" label="行号" width="80" />
          <el-table-column label="结果" width="90"><template #default="{row}"><el-tag :type="row.status==='success'?'success':row.status==='skipped'?'info':'danger'">{{ row.status==='success'?'成功':row.status==='skipped'?'已跳过':'失败' }}</el-tag></template></el-table-column>
          <el-table-column label="更新SN" width="100"><template #default="{row}">{{ row.affectedInventory ?? '-' }}</template></el-table-column>
          <el-table-column prop="message" label="说明/失败原因" min-width="220" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="educationImportDialog=false">关闭</el-button>
        <el-button type="primary" :loading="educationImporting" :disabled="!educationFile" @click="submitEducationImport">开始导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="nbPolicyImportDialog" title="上传产品政策表" width="760px" destroy-on-close>
      <el-alert title="模板仅包含 PN、商品名称、结算价、SO政策、PO政策、其他政策、备注；上传后即时生效。" type="info" :closable="false" style="margin-bottom:14px" />
        <div class="filter-bar" style="margin-bottom:14px">
          <el-button type="primary" plain @click="downloadNbPolicyTemplate">下载产品政策表模板</el-button>
          <span class="muted">字段：PN、商品名称、结算价、SO政策、PO政策、其他政策、备注。</span>
        </div>
      <input ref="nbPolicyFileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onNbPolicyFileChange" />
      <el-button :disabled="nbPolicyImporting" @click="nbPolicyFileInput?.click()">选择Excel文件</el-button>
      <span v-if="nbPolicyFile" class="file-name">{{ nbPolicyFile.name }}</span>
      <div v-if="nbPolicyImportResult" class="import-result">
        <el-result :icon="nbPolicyImportResult.failed ? 'warning' : 'success'" :title="nbPolicyImportResult.message" :sub-title="`成功 ${nbPolicyImportResult.success} 条，失败 ${nbPolicyImportResult.failed} 条`" />
        <el-table v-if="nbPolicyImportResult.rows.length" :data="nbPolicyImportResult.rows" border max-height="300">
          <el-table-column prop="pn" label="商品编号/PN" min-width="150" />
          <el-table-column prop="row" label="行号" width="80" />
          <el-table-column label="结果" width="90"><template #default="{row}"><el-tag :type="row.status==='success'?'success':'danger'">{{ row.status==='success'?'成功':'失败' }}</el-tag></template></el-table-column>
          <el-table-column prop="message" label="说明/失败原因" min-width="240" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="nbPolicyImportDialog=false">关闭</el-button>
        <el-button type="primary" :loading="nbPolicyImporting" :disabled="!nbPolicyFile" @click="submitNbPolicyImport">开始导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDialog" title="表格导入批量调整权益" width="640px">
      <el-alert title="仅调整未销售在库SN的权益，已锁定、已核销和已套回权益会跳过，已归档销售单不受影响。" type="warning" :closable="false" style="margin-bottom:12px" />
      <div class="import-help">
        <p>每行一条调整规则：只填 PN 调整该 PN 下全部在库 SN；填写 SN 时按 SN 调整，若 PN、SN 同时填写则 SN 优先。开始时间不填表示立即生效，结束时间不填表示永久有效。</p>
        <p>表头：PN、SN、资源类型、资源金额、状态、开始时间、结束时间、备注。</p>
      </div>
      <el-button @click="downloadBatchTemplate">下载导入模板</el-button>
      <input ref="batchFileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onBatchFileChange" />
      <el-button type="primary" @click="batchFileInput?.click()">选择Excel文件</el-button>
      <span v-if="batchFile" class="file-name">{{ batchFile.name }}</span>
      <template #footer>
        <el-button @click="batchDialog=false">取消</el-button>
        <el-button type="primary" :loading="batchImporting" :disabled="!batchFile" @click="submitBatchImport">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import api from '../api'
import { hasRole } from '../utils/user'
import SalesCashRebateManagement from './SalesCashRebateManagement.vue'

const props = defineProps({ financeOnly: { type: Boolean, default: false } })
const tab = ref(props.financeOnly ? 'changes' : 'rights')
const canManageCategories = hasRole(['boss', 'admin'])
const categoryKindOptions = [
  { label: '销售使用', value: 'SALE_USE' }, { label: '返利', value: 'REBATE' },
  { label: '采购奖励', value: 'PO_REWARD' }, { label: '个人Care', value: 'CARE_CREDIT' },
  { label: '内部标记', value: 'INTERNAL_MARKER' }, { label: '其他', value: 'OTHER' }
]
const resourceCategories = ref([]); const settlementAccounts = ref([]); const categoryLoading = ref(false)
const categoryManagementVisible = ref(false); const categoryEditorVisible = ref(false); const categorySaving = ref(false)
const emptyCategoryForm = () => ({ categoryId:'', name:'', shortName:'', resourceKind:'REBATE', defaultAccountId:'', supportsPurchaseSelect:false, supportsSaleUse:false, supportsCompanyClaim:false, triggerOnSale:false, generatesSettlement:true, generatesStaffCareCredit:false, affectsPerformanceProfit:false, performanceProfitRatio:100, status:1, remark:'' })
const categoryForm = reactive(emptyCategoryForm())
const loading = ref(false)
const resourceOptions = ref([])
const statusOptions = [{label:'可用',value:'AVAILABLE'},{label:'已锁定',value:'LOCKED'},{label:'已核销',value:'USED'},{label:'已套回',value:'CLAIMED_BACK'},{label:'不适用',value:'NOT_APPLICABLE'},{label:'异常',value:'EXCEPTION'}]
const rights = ref([]); const rightsTotal = ref(0)
const rightsQuery = reactive({ snCode:'', pnCode:'', resourceType:'', status:'', page:1, pageSize:20 })
const rightsExporting = ref(false)
const changes = ref([]); const changeTotal = ref(0)
const changeQuery = reactive({ snCode:'', resourceType:'', approvalStatus: props.financeOnly ? 'pending_finance' : '', page:1, pageSize:20 })
const costs = ref([]); const products = ref([]); const productLoading = ref(false)
const suppliers = ref([])
const ledger = ref([]); const ledgerTotal = ref(0); const ledgerQuery = reactive({ snCode:'', resourceType:'', page:1, pageSize:20 })
const costForm = reactive({
  productId:'', resourceType:'GOV_SUBSIDY', supplierId:'', supplierName:'',
  costAmount:0, calculationType:'fixed_amount', affectsPerformanceProfit:false,
  performanceProfitRatio:100, effectiveRange:[], triggerCondition:'sale_archived',
  saleWithinDays:30, remark:''
})
const snDialog = ref(false); const snDetail = ref(null); const currentSnId = ref('')
const snForm = reactive({ taxType:'UNKNOWN', sourceType:'OTHER', rights:[] })
const claimDialog = ref(false); const claimForm = reactive({ snId:'', snCode:'', resourceType:'', amount:0, attachmentUrl:'', remark:'' })
const batchDialog = ref(false)
const batchForm = reactive({ snCodesText:'', productId:'', resourceTypes:[], status:'AVAILABLE', amount:0, remark:'' })
const batchFileInput = ref(null); const batchFile = ref(null); const batchImporting = ref(false)
const educationFileInput = ref(null); const educationImporting = ref(false)
const educationImportDialog = ref(false); const educationFile = ref(null); const educationImportResult = ref(null)
const educationPolicyLoading = ref(false); const educationPolicies = ref([])
const educationPolicyQuery = reactive({ pn: '' })
const nbPolicies = ref([]); const nbPolicyTotal = ref(0); const nbPolicyLoading = ref(false)
const nbPolicyQuery = reactive({ pn:'', page:1, pageSize:20 })
const nbPolicyImportDialog = ref(false); const nbPolicyFileInput = ref(null); const nbPolicyFile = ref(null)
const nbPolicyImporting = ref(false); const nbPolicyImportResult = ref(null)
const educationSupplementDialog = ref(false); const educationProofInput = ref(null)
const educationProofUploading = ref(false); const educationSupplementSubmitting = ref(false)
const educationSupplementForm = reactive({ snId:'', snCode:'', orderNo:'', attachmentUrl:'' })

const payloadList = res => res.data?.list || res.data || []
const payloadTotal = res => res.data?.pagination?.total || res.data?.total || 0
const money = value => Number(value || 0).toFixed(2)
const dateText = value => value ? String(value).slice(0, 10) : '—'
const resourceText = value => value === 'OTHER_POLICY' ? '其他政策待获取' : (resourceOptions.value.find(item => item.value === value)?.label || value)
const categoryKindText = value => categoryKindOptions.find(item => item.value === value)?.label || value || '其他'
const categoryScenarioText = row => [Number(row.supports_purchase_select) === 1 ? '采购选择' : '', Number(row.supports_sale_use) === 1 ? '销售使用' : '', Number(row.trigger_on_sale) === 1 ? '销售归档触发' : '', Number(row.generates_settlement) === 1 ? '生成待下账' : ''].filter(Boolean).join('、') || '未配置'
const isCustomCategory = row => String(row.category_code || '').startsWith('RES_')
const statusText = value => statusOptions.find(item => item.value === value)?.label || value
const statusType = value => ({AVAILABLE:'success',LOCKED:'warning',USED:'info',CLAIMED_BACK:'danger',EXCEPTION:'danger'}[value] || '')
const approvalText = value => ({pending_finance:'待财务审批',approved:'已通过',rejected:'已拒绝'}[value] || value)
const reasonText = value => ({SALE_USED:'销售使用',SALE_USE_REVERSAL:'销售核销冲销',EDU_SUBSIDY_SUPPLEMENT:'教育优惠资源补录',EDU_POLICY_EXPIRED:'教育优惠政策过期',COMPANY_CLAIMED_BACK:'公司套回',ORDER_LOCKED:'订单锁定',ORDER_CANCEL_RELEASE:'订单取消释放',MANUAL_ADJUST:'人工调整',PURCHASE_INBOUND:'采购入库',BATCH_ADJUST:'批量调整',SALE_TRIGGER:'销售触发',SALE_TRIGGER_NOT_ELIGIBLE:'销售未达成条件'}[value] || value)
const calcTypeText = value => ({fixed_amount:'固定金额',percentage_inventory_cost:'库存成本比例',percentage_sale_amount:'销售金额比例'}[value] || value)
const rulePeriodText = row => row.effective_start || row.effective_end ? `${String(row.effective_start || '不限').slice(0,10)} 至 ${String(row.effective_end || '不限').slice(0,10)}` : '长期有效'
const triggerText = row => {
  if(row.trigger_condition !== 'sold_within_days')return '销售归档'
  try{return `入库后 ${JSON.parse(row.rule_config_json || '{}').saleWithinDays || '-'} 天内`}
  catch(e){return '入库后限时售出'}
}

async function loadRights(){ loading.value=true; try{ const res=await api.getResourceRights(rightsQuery); rights.value=payloadList(res); rightsTotal.value=payloadTotal(res) }catch(e){ ElMessage.error(e.response?.data?.message||'加载权益失败') }finally{ loading.value=false } }
async function completeOtherPolicy(row){
  try{ await ElMessageBox.confirm(`确认 SN ${row.sn_code} 的其他政策已获取完成？`, '完成政策资源'); await api.completeOtherPolicyResource(row.sn_id); ElMessage.success('已标记完成'); await loadRights(); const res=await api.getSnResourceRights(row.sn_id); snDetail.value=res.data?.data||res.data }
  catch(e){ if(e!=='cancel') ElMessage.error(e.response?.data?.message||'操作失败') }
}
async function exportRights(){ rightsExporting.value=true; try{ await api.exportResourceRights({snCode:rightsQuery.snCode,pnCode:rightsQuery.pnCode,resourceType:rightsQuery.resourceType,status:rightsQuery.status}); ElMessage.success('导出完成') }catch(e){ ElMessage.error(e.response?.data?.message||'导出失败') }finally{ rightsExporting.value=false } }
async function loadChanges(){ loading.value=true; try{ const res=await api.getResourceRightChanges(changeQuery); changes.value=payloadList(res); changeTotal.value=payloadTotal(res) }catch(e){ ElMessage.error(e.response?.data?.message||'加载变更记录失败') }finally{ loading.value=false } }
async function loadCosts(){ try{ const res=await api.getProductResourceCostConfigs({}); costs.value=res.data || [] }catch(e){ ElMessage.error('加载成本定义失败') } }
async function loadEducationPolicies(){
  educationPolicyLoading.value=true
  try{
    const res=await api.getProductResourceCostConfigs({})
    const configs=Array.isArray(res.data)?res.data:[]
    const pn=String(educationPolicyQuery.pn||'').trim().toLowerCase()
    educationPolicies.value=configs.flatMap(config=>{
      if(config.resource_type!=='EDU_SUBSIDY'||Number(config.status)===0)return []
      let rule={}
      try{rule=typeof config.rule_config_json==='string'?JSON.parse(config.rule_config_json||'{}'):(config.rule_config_json||{})}catch(e){}
      const entries=Array.isArray(rule.educationPolicies)?rule.educationPolicies:[]
      const product=config.Product||{}
      const base={pn:product.product_code||config.product_id,productName:product.name||'-',update_time:config.update_time}
      const rows=entries.length?entries.map(item=>({
        ...base,
        studentDiscount:item.studentDiscount,
        resourceRecalculationAmount:item.resourceRecalculationAmount,
        promotionStart:item.promotionStart,
        promotionEnd:item.promotionEnd,
        sourceSheet:item.sourceSheet||'-'
      })): [{
        ...base,
        studentDiscount:(String(config.remark||'').match(/主表优惠\s*¥?([\d.]+)/)||[])[1]||0,
        resourceRecalculationAmount:config.cost_amount,
        promotionStart:config.effective_start,
        promotionEnd:config.effective_end,
        sourceSheet:'-'
      }]
      return rows
    }).filter(row=>!pn||String(row.pn||'').toLowerCase().includes(pn)||String(row.productName||'').toLowerCase().includes(pn))
  }catch(e){ElMessage.error(e.response?.data?.message||'加载教育优惠政策失败')}
  finally{educationPolicyLoading.value=false}
}
async function loadLedger(){ try{const res=await api.getResourceCostAdjustments(ledgerQuery);ledger.value=payloadList(res);ledgerTotal.value=payloadTotal(res)}catch(e){ElMessage.error('加载成本流水失败')} }
function loadActive(name){ if(name==='rights')loadRights(); else if(name==='education-policy')loadEducationPolicies(); else if(name==='changes')loadChanges(); else if(name==='cost-ledger')loadLedger(); else if(name==='nb-policy')loadNbPolicies(); else if(name==='sales-cash-rebate')return; else loadCosts() }
async function loadCategories(){
  categoryLoading.value=true
  try{
    const res=await api.getResourceCategories()
    const rows=Array.isArray(res.data)?res.data:(res.data?.data||[])
    resourceCategories.value=rows
    resourceOptions.value=rows.filter(row=>Number(row.status)!==0).map(row=>({label:row.name,value:row.category_code}))
  }catch(e){ElMessage.error(e.response?.data?.message||'加载权益类型失败')}
  finally{categoryLoading.value=false}
  if(!resourceOptions.value.some(item=>item.value===costForm.resourceType)){
    costForm.resourceType=resourceOptions.value[0]?.value||''
  }
}
async function loadSettlementAccounts(){
  try{
    const res=await api.getAllSettlementAccounts()
    settlementAccounts.value=Array.isArray(res.data)?res.data:(res.data?.data||[])
  }catch(e){settlementAccounts.value=[]}
}
function suggestedAccountId(categoryCode){
  if(categoryCode==='EDU_SUBSIDY'){
    return settlementAccounts.value.find(account=>String(account.account_name||'').includes('返利池'))?.account_id
      ||settlementAccounts.value.find(account=>String(account.account_name||'').includes('返利'))?.account_id||''
  }
  if(categoryCode==='SALES_CASH_REBATE')return settlementAccounts.value.find(account=>account.account_type==='FUND'&&String(account.account_name||'').includes('微信'))?.account_id||''
  return ''
}
async function openCategoryManagement(){
  if(!canManageCategories)return
  categoryManagementVisible.value=true
  await loadCategories()
}
async function initializeSuggestedResourceAccounts(){
  if(!canManageCategories)return
  let updated=false
  for(const code of ['EDU_SUBSIDY','SALES_CASH_REBATE']){
    const row=resourceCategories.value.find(item=>item.category_code===code&&Number(item.status)!==0)
    if(!row||row.default_account_id)continue
    const accountId=suggestedAccountId(code)
    if(!accountId)continue
    try{
      await api.saveResourceCategory({
        categoryId:row.category_id,name:row.name,shortName:row.short_name||row.name,
        resourceKind:row.resource_kind||'OTHER',defaultAccountId:accountId,
        supportsPurchaseSelect:Number(row.supports_purchase_select)===1,supportsSaleUse:Number(row.supports_sale_use)===1,
        supportsCompanyClaim:Number(row.supports_company_claim)===1,triggerOnSale:Number(row.trigger_on_sale)===1,
        generatesSettlement:Number(row.generates_settlement)===1,generatesStaffCareCredit:Number(row.generates_staff_care_credit)===1,
        affectsPerformanceProfit:Number(row.affects_performance_profit)===1,performanceProfitRatio:Number(row.performance_profit_ratio??100),
        status:Number(row.status),remark:row.remark||'',rule_config_json:row.rule_config_json||null
      })
      updated=true
    }catch(e){ElMessage.warning(`权益类型“${row.name}”的推荐到账账户未能自动保存，请手动设置`)}
  }
  if(updated)await loadCategories()
}
function openCategoryEditor(row=null){
  if(!canManageCategories)return
  Object.assign(categoryForm,emptyCategoryForm(),row?{
    categoryId:row.category_id,name:row.name,shortName:row.short_name||row.name,resourceKind:row.resource_kind||'OTHER',
    defaultAccountId:row.default_account_id||'',supportsPurchaseSelect:Number(row.supports_purchase_select)===1,
    supportsSaleUse:Number(row.supports_sale_use)===1,supportsCompanyClaim:Number(row.supports_company_claim)===1,
    triggerOnSale:Number(row.trigger_on_sale)===1,generatesSettlement:Number(row.generates_settlement)===1,
    generatesStaffCareCredit:Number(row.generates_staff_care_credit)===1,affectsPerformanceProfit:Number(row.affects_performance_profit)===1,
    performanceProfitRatio:Number(row.performance_profit_ratio??100),status:Number(row.status),remark:row.remark||''
  }:{})
  if(!categoryForm.defaultAccountId)categoryForm.defaultAccountId=suggestedAccountId(row?.category_code)
  categoryEditorVisible.value=true
}
async function saveCategory(){
  const name=String(categoryForm.name||'').trim()
  if(!name)return ElMessage.warning('请填写权益名称')
  categorySaving.value=true
  try{
    await api.saveResourceCategory({
      categoryId:categoryForm.categoryId||undefined,name,shortName:String(categoryForm.shortName||name).trim(),
      resourceKind:categoryForm.resourceKind,defaultAccountId:categoryForm.defaultAccountId||null,
      supportsPurchaseSelect:categoryForm.supportsPurchaseSelect,supportsSaleUse:categoryForm.supportsSaleUse,
      supportsCompanyClaim:categoryForm.supportsCompanyClaim,triggerOnSale:categoryForm.triggerOnSale,
      generatesSettlement:categoryForm.generatesSettlement,generatesStaffCareCredit:categoryForm.generatesStaffCareCredit,
      affectsPerformanceProfit:categoryForm.affectsPerformanceProfit,performanceProfitRatio:categoryForm.performanceProfitRatio,
      status:categoryForm.status,remark:categoryForm.remark
    })
    categoryEditorVisible.value=false
    await loadCategories()
    ElMessage.success('权益类型已保存')
  }catch(e){ElMessage.error(e.response?.data?.message||'保存权益类型失败')}
  finally{categorySaving.value=false}
}
async function removeCategory(row){
  try{
    await ElMessageBox.confirm(`删除“${row.name}”后会停用该类型，历史记录会保留。`, '确认删除权益类型', {type:'warning'})
    await api.deleteResourceCategory(row.category_id)
    await loadCategories()
    ElMessage.success('权益类型已停用')
  }catch(e){if(e!=='cancel')ElMessage.error(e.response?.data?.message||'删除权益类型失败')}
}
async function loadSuppliers(){ try{const res=await api.getSupplierList({page:1,pageSize:500}); suppliers.value=res.data?.list || res.data || []}catch(e){} }
async function openBySn(){
  const { value } = await ElMessageBox.prompt('请输入完整SN码', '初始化/维护SN权益', { inputPattern:/\S+/, inputErrorMessage:'请输入SN码' }).catch(()=>({}))
  if(!value)return
  const res=await api.getSnList({ snCode:value, page:1, pageSize:20 })
  const row=payloadList(res).find(item=>item.sn_code===value) || payloadList(res)[0]
  if(!row)return ElMessage.warning('未找到SN')
  editSn(row.sn_id)
}
async function editSn(snId){
  try{
    const res=await api.getSnResourceRights(snId); const data=res.data; currentSnId.value=snId; snDetail.value=data
    snForm.taxType=data.sn?.tax_type||'UNKNOWN'; snForm.sourceType=data.sn?.source_type||'OTHER'
    snForm.rights=(data.rights||[]).map(row=>({resourceType:row.resource_type,status:row.current_status,amount:Number(row.amount||0),remark:row.remark||''}))
    snDialog.value=true
  }catch(e){ElMessage.error(e.response?.data?.message||'加载SN权益失败')}
}
async function saveSn(){ try{ await api.saveSnResourceRights(currentSnId.value, snForm); ElMessage.success('已保存'); snDialog.value=false; loadRights() }catch(e){ElMessage.error(e.response?.data?.message||'保存失败')} }
function openClaim(row){ Object.assign(claimForm,{snId:row.sn_id,snCode:row.sn_code,resourceType:row.resource_type,amount:Number(row.amount||0),attachmentUrl:'',remark:''}); claimDialog.value=true }
async function submitClaim(){ try{ await api.submitResourceClaim(claimForm); ElMessage.success('已提交财务审批'); claimDialog.value=false; loadRights() }catch(e){ElMessage.error(e.response?.data?.message||'提交失败')} }
function canReverse(row){ return !props.financeOnly && row.resource_type === 'GOV_SUBSIDY' && row.current_status === 'USED' && hasRole(['finance']) }
async function reverseSaleUse(row){
  try{
    const { value } = await ElMessageBox.prompt(
      `将恢复 SN ${row.sn_code} 的国补资格，并追加一条 USED → 可用的冲销记录。仅适用于原销售单已退单、SN已回库的纠错场景。请输入冲销原因。`,
      '冲销国补资格',
      { inputPattern:/\S+/, inputErrorMessage:'必须填写冲销原因', inputPlaceholder:'例如：测试订单退单时未勾选退回国补资格', type:'warning' }
    )
    const res = await api.reverseSaleUseResource({ snId: row.sn_id, resourceType: row.resource_type, reason: value })
    ElMessage.success(res.message || '国补资格冲销成功')
    await Promise.all([loadRights(), loadChanges()])
  }catch(e){ if(e !== 'cancel' && e !== 'close') ElMessage.error(e.response?.data?.message || '国补资格冲销失败') }
}
async function review(row, action){
  const { value }=await ElMessageBox.prompt(action==='approve'?'确认通过该套回申请？':'请输入拒绝原因', action==='approve'?'审批通过':'审批拒绝', {inputPlaceholder:'审批意见'}).catch(()=>({}))
  if(action==='reject' && !value)return
  try{await api.reviewResourceClaim(row.change_id,{action,comment:value||''});ElMessage.success('审批完成');loadChanges()}catch(e){ElMessage.error(e.response?.data?.message||'审批失败')}
}
async function searchProducts(keyword){ if(!keyword)return; productLoading.value=true; try{const res=await api.searchProduct({keyword,page:1,pageSize:30});products.value=payloadList(res)}finally{productLoading.value=false} }
function onCostSupplierChange(value){ const supplier=suppliers.value.find(item=>item.supplier_id===value); costForm.supplierName=supplier?.name||'' }
async function saveCost(){
  if(!costForm.productId)return ElMessage.warning('请选择商品')
  try{
    await api.saveProductResourceCostConfig({
      productId:costForm.productId, resourceType:costForm.resourceType, supplierId:costForm.supplierId,
      supplierName:costForm.supplierName, costAmount:costForm.costAmount,
      calculationType:costForm.calculationType, calculationValue:costForm.costAmount,
      effectiveStart:costForm.effectiveRange?.[0]||null, effectiveEnd:costForm.effectiveRange?.[1]||null,
      triggerCondition:costForm.triggerCondition,
      ruleConfigJson:costForm.triggerCondition==='sold_within_days'?{saleWithinDays:costForm.saleWithinDays}:null,
      affectsPerformanceProfit:costForm.affectsPerformanceProfit,
      performanceProfitRatio:costForm.performanceProfitRatio, remark:costForm.remark
    })
    ElMessage.success('已保存');loadCosts()
  }catch(e){ElMessage.error(e.response?.data?.message||'保存失败')}
}
async function batchRefresh(){
  if(!costForm.productId)return ElMessage.warning('请选择商品')
  try{
    const res=await api.batchRefreshResourceRights({productId:costForm.productId,resourceTypes:[costForm.resourceType]})
    ElMessage.success(res.message || `已刷新 ${res.affected || 0} 条SN权益`)
    loadRights()
  }catch(e){ElMessage.error(e.response?.data?.message||'刷新失败')}
}
function openBatchAdjust(){
  Object.assign(batchForm,{snCodesText:'',productId:costForm.productId||'',resourceTypes:costForm.resourceType?[costForm.resourceType]:[],status:'AVAILABLE',amount:0,remark:''})
  batchDialog.value=true
}
async function submitBatchAdjust(){
  const snCodes=batchForm.snCodesText.split(/[\s,，;；]+/).map(item=>item.trim()).filter(Boolean)
  if(!snCodes.length && !batchForm.productId)return ElMessage.warning('请填写SN码或选择商品')
  if(!batchForm.resourceTypes.length)return ElMessage.warning('请选择权益')
  try{
    const res=await api.batchAdjustResourceRights({
      snCodes, productId:batchForm.productId, resourceTypes:batchForm.resourceTypes,
      status:batchForm.status, amount:batchForm.amount, remark:batchForm.remark
    })
    ElMessage.success(res.message || `已调整 ${res.affected || 0} 条SN权益`)
    batchDialog.value=false
    loadRights()
  }catch(e){ElMessage.error(e.response?.data?.message||'批量调整失败')}
}

function onBatchFileChange(event){ batchFile.value=event.target.files?.[0] || null }
function downloadBatchTemplate(){
  const defaultResourceName=resourceOptions.value[0]?.label || '国补'
  const rows=[{PN:'示例PN',SN:'',资源类型:defaultResourceName,资源金额:500,状态:'可用',开始时间:'',结束时间:'',备注:'按PN匹配全部在库SN'}]
  const instructions=[
    {填写项目:'PN与SN',填写说明:'二选一即可；同时填写时以SN为准。填写PN会调整该PN下全部符合条件的在库SN。'},
    {填写项目:'资源类型',填写说明:`请填写系统中的中文资源名称：${resourceOptions.value.map(item=>item.label).join('、') || '国补'}`},
    {填写项目:'资源金额',填写说明:'填写大于或等于0的数字，不填写按0处理。'},
    {填写项目:'状态',填写说明:'仅可填写：可用、不适用、异常；不填写默认为可用。'},
    {填写项目:'开始时间',填写说明:'不填写表示立即生效；可填写日期或日期时间。'},
    {填写项目:'结束时间',填写说明:'不填写表示永久有效；可填写日期或日期时间。'},
    {填写项目:'备注',填写说明:'选填，用于说明本次权益调整原因。'},
    {填写项目:'导入范围',填写说明:'仅调整未销售且在库的SN；已锁定、已核销、已套回的权益会自动跳过。'}
  ]
  const sheet=XLSX.utils.json_to_sheet(rows)
  sheet['!cols']=[{wch:22},{wch:22},{wch:18},{wch:14},{wch:12},{wch:20},{wch:20},{wch:34}]
  const instructionSheet=XLSX.utils.json_to_sheet(instructions)
  instructionSheet['!cols']=[{wch:16},{wch:72}]
  const book=XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book,sheet,'权益调整')
  XLSX.utils.book_append_sheet(book,instructionSheet,'填写说明')
  XLSX.writeFile(book,'资源权益批量调整模板.xlsx')
}
async function submitBatchImport(){
  if(!batchFile.value)return ElMessage.warning('请选择Excel文件')
  batchImporting.value=true
  try{
    const res=await api.importBatchResourceRights(batchFile.value); const data=res.data || res
    const failed=(data.results||[]).filter(item=>item.status==='failed')
    if(failed.length) ElMessage.warning(`${data.message}，失败原因：${failed.slice(0,3).map(item=>`第${item.row}行 ${item.message}`).join('；')}`)
    else ElMessage.success(data.message || '导入完成')
    batchDialog.value=false; await loadRights(); await loadChanges()
  }catch(e){ElMessage.error(e.response?.data?.message||'Excel导入失败')}
  finally{batchImporting.value=false}
}

function openEducationImport(){ educationFile.value=null; educationImportResult.value=null; educationImportDialog.value=true }
function onEducationFileChange(event){
  const file=event.target.files?.[0]
  event.target.value=''
  if(!file)return
  educationFile.value=file
  educationImportResult.value=null
}
async function submitEducationImport(){
  if(!educationFile.value)return ElMessage.warning('请选择教育优惠表')
  educationImporting.value=true
  try{
    const res=await api.importEducationSubsidyPolicies(educationFile.value)
    const data=res.data || res
    const rows=data.results||[]
    const success=rows.filter(item=>item.status==='success').length
    const failed=rows.filter(item=>item.status==='failed').length
    const skipped=rows.filter(item=>item.status==='skipped').length
    educationImportResult.value={message:data.message||'教育优惠表导入完成',success,failed,skipped,clearedRights:Number(data.clearedExpiredRights||0)+rows.reduce((sum,item)=>sum+Number(item.clearedExpiredRights||0),0),affectedSn:rows.reduce((sum,item)=>sum+Number(item.affectedInventory||0),0),rows}
    if(failed) ElMessage.warning(data.message||'教育优惠表部分导入失败')
    else ElMessage.success(data.message||'教育优惠表导入完成')
    await loadRights()
    await loadEducationPolicies()
  }catch(e){
    const message=e.response?.data?.message||e.message||'教育优惠表导入失败'
    educationImportResult.value={message,success:0,failed:1,skipped:0,clearedRights:0,affectedSn:0,rows:[{status:'failed',message}]}
    ElMessage.error(message)
  }
  finally{educationImporting.value=false}
}

async function loadNbPolicies(){
  nbPolicyLoading.value=true
  try{const res=await api.getInventoryNbPolicies(nbPolicyQuery);nbPolicies.value=payloadList(res);nbPolicyTotal.value=payloadTotal(res)}
  catch(e){ElMessage.error(e.response?.data?.message||'加载产品运作政策失败')}
  finally{nbPolicyLoading.value=false}
}
function openNbPolicyImport(){nbPolicyFile.value=null;nbPolicyImportResult.value=null;nbPolicyImportDialog.value=true}
function downloadNbPolicyTemplate(){
  const link=document.createElement('a')
  link.href=`${import.meta.env.BASE_URL}templates/产品政策导入模板.xlsx`
  link.download='产品政策导入模板.xlsx'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
function onNbPolicyFileChange(event){const file=event.target.files?.[0];event.target.value='';if(file){nbPolicyFile.value=file;nbPolicyImportResult.value=null}}
function readNbPolicyRows(file){return new Promise((resolve,reject)=>{
  const reader=new FileReader()
  reader.onload=event=>{
    try{
      const workbook=XLSX.read(new Uint8Array(event.target.result),{type:'array'})
      const normalize=value=>String(value||'').toLowerCase().replace(/[\s_\-（）()]/g,'')
      for(const sheetName of workbook.SheetNames){
        const matrix=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:''})
        const headerAt=matrix.slice(0,20).findIndex(row=>{
          const cells=row.map(normalize)
          return cells.some(v=>['pn','pncode','productcode','商品编号','产品编号'].includes(v))&&cells.some(v=>v.includes('结算')||v.includes('so政策')||v.includes('po政策')||v.includes('其他政策'))
        })
        if(headerAt<0)continue
        const headers=matrix[headerAt].map((value,index)=>String(value||`列${index+1}`).trim())
        const records=matrix.slice(headerAt+1).map(values=>Object.fromEntries(headers.map((header,index)=>[header,values[index]??'']))).filter(row=>Object.values(row).some(value=>String(value||'').trim()))
        if(records.length){resolve(records);return}
      }
      resolve([])
    }catch(error){reject(error)}
  }
  reader.onerror=reject;reader.readAsArrayBuffer(file)
})}
async function submitNbPolicyImport(){
  if(!nbPolicyFile.value)return ElMessage.warning('请选择产品政策表')
  nbPolicyImporting.value=true
  try{
    let rows=await readNbPolicyRows(nbPolicyFile.value)
    if(!rows.length)throw new Error('未识别到商品编号、结算价等政策表头')
    const res=await api.importInventoryNbPolicy({rows,sourceFileUrl:nbPolicyFile.value.name})
    const data=res.data||res
    const results=data.results||[]
    const failed=results.filter(item=>item.status==='failed')
    const success=results.filter(item=>item.status==='success')
    nbPolicyImportResult.value={message:data.message||`NB政策导入完成：${data.count||success.length}条`,success:success.length||Number(data.count||0),failed:failed.length,rows:results}
    if(failed.length)ElMessage.warning(data.message||'NB政策部分导入失败')
    else ElMessage.success(data.message||`NB政策导入成功，共${data.count||success.length}条`)
    await loadNbPolicies()
  }catch(e){
    const body=e.response?.data||{}
    const errors=body.data?.errors||body.errors||[]
    const rows=errors.map(item=>({pn:item.pn||item.productCode,row:item.row,status:'failed',message:item.message}))
    const message=body.message||e.message||'NB政策导入失败'
    nbPolicyImportResult.value={message,success:0,failed:rows.length||1,rows:rows.length?rows:[{status:'failed',message}]}
    ElMessage.error(message)
  }
  finally{nbPolicyImporting.value=false}
}

function openEducationSupplement(row){
  Object.assign(educationSupplementForm,{snId:row.sn_id,snCode:row.sn_code,orderNo:'',attachmentUrl:''})
  educationSupplementDialog.value=true
}

async function onEducationProofChange(event){
  const file=event.target.files?.[0]
  event.target.value=''
  if(!file)return
  educationProofUploading.value=true
  try{
    const result=await api.uploadFile(file,'education-supplement')
    const uploaded=result.data||{}
    educationSupplementForm.attachmentUrl=uploaded.fileId||uploaded.url||''
    if(!educationSupplementForm.attachmentUrl)throw new Error('上传成功但未取得附件标识')
    ElMessage.success('凭证已上传')
  }catch(e){ElMessage.error(e.response?.data?.message||e.message||'凭证上传失败')}
  finally{educationProofUploading.value=false}
}

async function submitEducationSupplement(){
  if(!educationSupplementForm.orderNo.trim())return ElMessage.warning('请输入销售单号')
  if(!educationSupplementForm.attachmentUrl)return ElMessage.warning('请先上传优惠凭证')
  educationSupplementSubmitting.value=true
  try{
    const res=await api.supplementEducationResource({snId:educationSupplementForm.snId,orderNo:educationSupplementForm.orderNo.trim(),attachmentUrl:educationSupplementForm.attachmentUrl})
    ElMessage.success(res.message||res.data?.message||'教育优惠资源补录完成')
    educationSupplementDialog.value=false
    await Promise.all([loadRights(),loadChanges(),loadLedger()])
  }catch(e){ElMessage.error(e.response?.data?.message||'教育优惠资源补录失败')}
  finally{educationSupplementSubmitting.value=false}
}

async function openAttachment(fileId){
  try{
    if(/^https?:\/\//i.test(fileId))return window.open(fileId,'_blank','noopener')
    const result=await api.resolveCloudFileUrls([fileId])
    const url=result.data?.items?.[0]?.url
    if(!url)throw new Error(result.data?.items?.[0]?.error||'附件地址暂不可用')
    window.open(url,'_blank','noopener')
  }catch(e){ElMessage.error(e.message||'附件打开失败')}
}

onMounted(async () => { await Promise.all([loadCategories(),loadSettlementAccounts()]); await initializeSuggestedResourceAccounts(); loadSuppliers(); loadActive(tab.value) })
</script>

<style scoped>
.category-management-entry{display:flex;justify-content:flex-end;margin-bottom:14px}.category-management-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.category-management-hint{color:#909399;font-size:13px}.system-category-label{padding:0 8px;color:#909399;font-size:12px}
.filter-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.el-pagination{margin-top:14px;justify-content:flex-end}.import-help{padding:4px 0 12px;color:#606266;line-height:1.7}.import-help p{margin:0}.file-name{margin-left:10px;color:#606266}.import-result{margin-top:14px}
</style>
