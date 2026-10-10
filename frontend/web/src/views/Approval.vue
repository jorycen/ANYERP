<template>
  <div class="approval-page">
    <el-card>
      <div class="batch-approval-toolbar"><el-button type="success" :loading="batchApproving" :disabled="!mergedTasks.length" @click="approveAll">全部通过<span v-if="mergedTasks.length">（{{ mergedTasks.length }}）</span></el-button></div>
      <template #header>
        <div class="page-header"><span>审批管理中心</span><el-button @click="reload">刷新</el-button></div>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs">
        <el-tab-pane label="待我审批" name="tasks">
          <div class="approval-filters">
            <el-input v-model="taskFilters.applicant" clearable placeholder="按发起人筛选" style="width: 190px" />
            <el-input v-model="taskFilters.supplier" clearable placeholder="按供应商筛选" style="width: 190px" />
            <el-select v-model="taskFilters.type" clearable placeholder="业务类型" style="width: 180px">
              <el-option v-for="item in taskTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button @click="resetTaskFilters">重置</el-button>
          </div>
          <el-alert v-for="issue in approvalIssues" :key="`${issue.businessType}:${issue.message}`" :title="`${businessTypeText(issue.businessType)}：${issue.message}`" type="warning" :closable="false" />
          <el-table :data="filteredMergedTasks" stripe border v-loading="loading">
            <el-table-column label="业务类型" width="140"><template #default="{ row }">{{ taskBusinessType(row) }}</template></el-table-column>
            <el-table-column label="业务信息" min-width="210"><template #default="{ row }">{{ taskMainInfo(row) }}</template></el-table-column>
            <el-table-column label="金额/负毛利" width="130"><template #default="{ row }"><span :class="{ 'negative-profit': row.isSalesApproval }">{{ taskAmount(row) }}</span></template></el-table-column>
            <el-table-column label="发起人" min-width="130"><template #default="{ row }">{{ taskApplicant(row) }}</template></el-table-column>
            <el-table-column label="供应商" min-width="150"><template #default="{ row }">{{ taskSupplier(row) }}</template></el-table-column>
            <el-table-column label="税务情况" width="130"><template #default="{ row }">{{ taskTaxStatus(row) }}</template></el-table-column>
            <el-table-column label="提交时间" width="180"><template #default="{ row }">{{ taskCreateTime(row) }}</template></el-table-column>
            <el-table-column label="当前节点" width="160"><template #default="{ row }">{{ taskNode(row) }}</template></el-table-column>
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <template v-if="row.isSalesApproval">
                  <el-button link type="primary" @click="openSales(row.salesRow)">审批详情</el-button>
                  <el-button link @click="openOriginalFromRow(row)">原始单据</el-button>
                  <el-button link type="success" @click="reviewSales(row.salesRow, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="reviewSales(row.salesRow, 'reject')">拒绝</el-button>
                </template>
                <template v-else-if="row.isModuleApproval">
                  <el-button link type="primary" @click="openModule(row)">审批详情</el-button>
                  <el-button link @click="openOriginalFromRow(row)">原始单据</el-button>
                  <el-button link type="success" @click="row.moduleType === 'product_application' ? openModule(row) : reviewModule(row, 'approve')">{{ row.manualPath ? '前往确认' : '通过' }}</el-button>
                  <el-button v-if="!row.manualPath" link type="danger" @click="reviewModule(row, 'reject')">拒绝</el-button>
                </template>
                <template v-else>
                  <el-button link type="primary" @click="openInstance(row.instance_id, row)">审批详情</el-button>
                  <el-button v-if="canViewOriginal(row.Instance)" link @click="openOriginalFromRow(row)">原始单据</el-button>
                  <el-button v-if="row.Instance?.business_type === 'expense'" link type="warning" @click="openAttributionEditor(row)">调整分摊</el-button>
                  <el-button link type="success" @click="review(row, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="review(row, 'reject')">拒绝</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!loading && filteredMergedTasks.length === 0" description="暂无符合条件的待审批单据" :image-size="60" />
        </el-tab-pane>

        <el-tab-pane label="我的申请" name="instances">
          <el-table :data="instances" stripe border v-loading="loading">
            <el-table-column prop="title" label="审批主题" min-width="220" />
            <el-table-column label="业务类型" width="150"><template #default="{ row }">{{ businessTypeText(row.business_type) }}</template></el-table-column>
            <el-table-column prop="instance_no" label="申请编号" width="190" />
            <el-table-column label="当前进度" min-width="210">
              <template #default="{ row }">{{ instanceProgressText(row) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="create_time" label="提交时间" width="180" />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openInstance(row.instance_id)">详情</el-button>
                <el-button v-if="row.status === 'rejected' && !row.payload?.managedBusiness" link type="warning" @click="resubmit(row)">重新提交</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="我的审批" name="handled">
          <el-table :data="handledInstances" stripe border v-loading="handledLoading">
            <el-table-column prop="title" label="审批主题" min-width="220" />
            <el-table-column label="业务类型" width="150"><template #default="{ row }">{{ businessTypeText(row.business_type) }}</template></el-table-column>
            <el-table-column prop="instance_no" label="申请编号" width="190" />
            <el-table-column label="当前进度" min-width="210"><template #default="{ row }">{{ instanceProgressText(row) }}</template></el-table-column>
            <el-table-column prop="status" label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column prop="create_time" label="提交时间" width="180" />
            <el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="openInstance(row.instance_id)">审批详情</el-button></template></el-table-column>
          </el-table>
          <el-pagination v-if="handledTotal" v-model:current-page="handledPage" v-model:page-size="handledPageSize" :total="handledTotal" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next, jumper" style="justify-content:flex-end;margin-top:16px" @current-change="loadHandledInstances" @size-change="onHandledPageSizeChange" />
          <el-empty v-if="!handledLoading && !handledInstances.length" description="暂无经手的审批单" :image-size="70" />
        </el-tab-pane>

        <el-tab-pane v-if="canConfigure" label="流程配置" name="flows">
          <div class="toolbar"><el-button type="primary" @click="newFlow">新增流程</el-button><el-button @click="initializeFlows">补齐系统流程</el-button><span>共 {{ new Set(flows.map(row => row.flow_code)).size }} 类流程</span></div>
          <el-alert title="编辑并保存后立即作为新申请的审批规则；已发起的审批单继续使用提交时的流程快照。流程列表只显示每类流程的当前配置。" type="info" :closable="false" style="margin-bottom:12px" />
          <el-table :data="flows" stripe border>
            <el-table-column prop="name" label="流程名称" min-width="180" />
            <el-table-column prop="flow_code" label="流程编码" width="180" />
            <el-table-column label="业务类型" width="160"><template #default="{ row }">{{ businessTypeText(row.business_type) }}</template></el-table-column>
            <el-table-column label="接入情况" width="170"><template #default="{ row }">{{ row.binding_status === 'business' ? '已绑定业务审批' : '独立流程（未绑定业务）' }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }">{{ ({ draft: '草稿', published: '已发布', disabled: '已停用' })[row.status] || row.status }}</template></el-table-column>
            <el-table-column label="待完善" min-width="140"><template #default="{ row }">{{ (row.config?.missingApprovers || []).join('、') || '-' }}</template></el-table-column>
            <el-table-column label="操作" width="240">
              <template #default="{ row }">
                <el-button link type="primary" @click="editFlow(row)">编辑</el-button>
                <el-button v-if="row.status === 'draft'" link type="success" @click="publish(row)">发布</el-button>
                <el-button v-if="row.status === 'published'" link type="danger" @click="disable(row)">停用</el-button>
                <el-button v-if="row.status === 'disabled'" link type="success" @click="enable(row)">启用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="detailVisible" title="审批详情" width="800px">
      <template v-if="currentInstance">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="主题">{{ currentInstance.title }}</el-descriptions-item>
          <el-descriptions-item label="申请编号">{{ currentInstance.instance_no }}</el-descriptions-item>
          <el-descriptions-item v-if="currentInstance.applicant_name" label="发起人">{{ currentInstance.applicant_name }}</el-descriptions-item>
          <el-descriptions-item v-if="currentInstance.store_name" label="申请门店">{{ currentInstance.store_name }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ currentInstance.create_time || '-' }}</el-descriptions-item>
          <el-descriptions-item label="说明" :span="2">{{ currentInstance.summary || '-' }}</el-descriptions-item>
          <el-descriptions-item v-if="currentInstance.returnReason !== undefined" label="退单缘由" :span="2">{{ currentInstance.returnReason || '-' }}</el-descriptions-item>
        </el-descriptions>
        <template v-if="currentInstance.moduleData">
          <el-divider>发起信息</el-divider>
          <el-skeleton v-if="currentInstance.detailLoading" :rows="3" animated />
          <template v-else>
            <div v-if="currentInstance.moduleType === 'product_application' && productApplicationEdit" class="detail-section">
              <div class="detail-section-title">商品信息（按新建商品模板核对/修改）</div>
              <el-alert title="审批通过时将按以下商品信息创建商品。分类必须完整选择到第 4 级。" type="info" :closable="false" />
              <el-form :model="productApplicationEdit" label-width="100px" class="product-application-edit-form">
                <el-row :gutter="12">
                  <el-col :span="12"><el-form-item label="商品分类" required><el-cascader v-model="productApplicationEdit.categoryPath" :options="productApplicationCategoryTree" :props="{ label: 'name', value: 'category_id', children: 'children', emitPath: true }" :show-all-levels="true" filterable style="width:100%" placeholder="请选择 1-4 级分类" @change="onProductApplicationCategoryChange" /></el-form-item></el-col>
                  <el-col :span="12"><el-form-item label="商品名称" required><el-input v-model="productApplicationEdit.name" /></el-form-item></el-col>
                  <el-col :span="12"><el-form-item label="PN / 厂商编码" required><el-input v-model="productApplicationEdit.pnCode" /></el-form-item></el-col>
                  <el-col :span="12"><el-form-item label="厂商商品名称"><el-input v-model="productApplicationEdit.config" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="商品分类维度"><el-input v-model="productApplicationEdit.category" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="品牌"><el-input v-model="productApplicationEdit.brand" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="系列"><el-input v-model="productApplicationEdit.series" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="型号"><el-input v-model="productApplicationEdit.model" /></el-form-item></el-col>
                  <el-col :span="8"><el-form-item label="单位"><el-input v-model="productApplicationEdit.unit" /></el-form-item></el-col>
                  <el-col :span="4"><el-form-item label="需要 SN"><el-switch v-model="productApplicationEdit.needSn" :active-value="1" :inactive-value="0" /></el-form-item></el-col>
                  <el-col :span="4"><el-form-item label="需要 IMEI"><el-switch v-model="productApplicationEdit.needImei" :active-value="1" :inactive-value="0" /></el-form-item></el-col>
                </el-row>
                <el-row v-if="productApplicationCategoryFields.length" :gutter="12">
                  <el-col v-for="field in productApplicationCategoryFields" :key="field.field_key" :span="8">
                    <el-form-item :label="field.field_label" :required="Number(field.required) === 1">
                      <el-select v-if="field.field_type === 'select'" :model-value="productApplicationFieldValue(field)" clearable style="width:100%" @update:model-value="value => setProductApplicationField(field, value)"><el-option v-for="option in field.options || []" :key="option" :label="option" :value="option" /></el-select>
                      <el-input v-else :model-value="productApplicationFieldValue(field)" @update:model-value="value => setProductApplicationField(field, value)" />
                    </el-form-item>
                  </el-col>
                </el-row>
                <el-form-item label="备注"><el-input v-model="productApplicationEdit.remark" type="textarea" :rows="2" /></el-form-item>
              </el-form>
            </div>
            <el-descriptions v-if="detailScalarFields(currentInstance.moduleData).length" :column="2" border>
              <el-descriptions-item
                v-for="field in detailScalarFields(currentInstance.moduleData)"
                :key="field.key"
                :label="field.label"
                :span="field.span"
              >{{ field.value }}</el-descriptions-item>
            </el-descriptions>
            <div v-for="section in detailArraySections(currentInstance.moduleData)" :key="section.key" class="detail-section">
              <div class="detail-section-title">{{ section.label }}</div>
              <el-table :data="section.rows" stripe border size="small">
                <el-table-column v-for="column in section.columns" :key="column.key" :label="column.label" min-width="120">
                  <template #default="{ row }">
                    <el-link v-if="column.key === 'url' && row[column.key]" :href="row[column.key]" target="_blank" type="primary">打开附件</el-link>
                    <span v-else>{{ formatDetailValue(row[column.key]) }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
            <div v-if="purchaseItemsNeedingCategory.length" class="detail-section">
              <div class="detail-section-title">新建二手商品类别</div>
              <el-alert title="审批通过后会自动创建商品，请为每个新建商品选择四级类别。" type="info" :closable="false" />
              <el-table :data="purchaseItemsNeedingCategory" stripe border size="small" style="margin-top: 10px">
                <el-table-column prop="product_name" label="商品名称" min-width="220" />
                <el-table-column prop="pn_code" label="PN" min-width="160" />
                <el-table-column label="四级商品类别" min-width="260">
                  <template #default="{ row }">
                    <el-select v-model="row.approvalCategoryId" filterable clearable placeholder="请选择四级商品类别" style="width: 100%">
                      <el-option v-for="category in approvalProductCategoryOptions" :key="category.categoryId" :label="category.displayName" :value="category.categoryId" />
                    </el-select>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </template>
        <template v-else-if="currentInstance.payload !== undefined && currentInstance.payload !== null">
          <el-divider>发起信息</el-divider>
          <el-descriptions v-if="detailScalarFields(currentInstance.payload, currentInstance.business_type).length" :column="2" border>
            <el-descriptions-item v-for="field in detailScalarFields(currentInstance.payload, currentInstance.business_type)" :key="field.key" :label="field.label" :span="field.span">{{ field.value }}</el-descriptions-item>
          </el-descriptions>
        </template>
        <template v-if="currentInstance.business_type === 'payable_settlement' && currentInstance.settlement_detail">
          <el-divider>应付审批关键信息</el-divider>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="订单发起人">{{ currentInstance.settlement_detail.applicant_name || currentInstance.applicant_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="付款性质">{{ currentInstance.settlement_detail.funding_type || '-' }}</el-descriptions-item>
            <el-descriptions-item label="供应商">{{ currentInstance.settlement_detail.supplier_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="实际收款方">{{ currentInstance.settlement_detail.payee_name || currentInstance.settlement_detail.supplier_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="应付结算单号">{{ currentInstance.settlement_detail.settlement_no || '-' }}</el-descriptions-item>
            <el-descriptions-item label="来源单号">{{ currentInstance.settlement_detail.source_no || '-' }}</el-descriptions-item>
            <el-descriptions-item label="结算金额">¥{{ formatMoney(currentInstance.settlement_detail.total_amount) }}</el-descriptions-item>
            <el-descriptions-item label="返款抵扣">¥{{ formatMoney(currentInstance.settlement_detail.rebate_deduction) }}</el-descriptions-item>
            <el-descriptions-item label="审批备注" :span="2">{{ currentInstance.settlement_detail.remark || '-' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="currentInstance.settlement_detail.purchase_requests?.length" class="detail-section">
            <div class="detail-section-title">关联采购申请</div>
            <el-table :data="currentInstance.settlement_detail.purchase_requests" stripe border size="small">
              <el-table-column prop="request_no" label="采购申请单号" min-width="180" />
              <el-table-column prop="applicant_name" label="采购申请人" min-width="120" />
              <el-table-column prop="payment_method" label="采购付款方式" min-width="130" />
              <el-table-column prop="actual_total" label="实际金额" width="120"><template #default="{ row }">¥{{ formatMoney(row.actual_total || row.total_amount) }}</template></el-table-column>
              <el-table-column prop="reason" label="采购说明" min-width="180" />
            </el-table>
          </div>
          <div v-if="currentInstance.settlement_detail.items?.length" class="detail-section">
            <div class="detail-section-title">本次采购商品</div>
            <el-table :data="currentInstance.settlement_detail.items" stripe border size="small">
              <el-table-column prop="request_no" label="采购申请单号" min-width="170" />
              <el-table-column prop="product_name" label="商品名称" min-width="180" />
              <el-table-column prop="product_code" label="商品编码" min-width="130" />
              <el-table-column prop="pn_code" label="PN" min-width="120" />
              <el-table-column prop="quantity" label="数量" width="80" />
              <el-table-column prop="unit_price" label="单价" width="110"><template #default="{ row }">¥{{ formatMoney(row.unit_price) }}</template></el-table-column>
              <el-table-column prop="amount" label="金额" width="120"><template #default="{ row }">¥{{ formatMoney(row.amount) }}</template></el-table-column>
            </el-table>
          </div>
        </template>
        <template v-if="currentInstance.business_type === 'payable_settlement'">
          <el-divider>收款方账户</el-divider>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="收款方">{{ currentInstance.counterparty_payment_info?.payeeName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="收款单位">{{ currentInstance.counterparty_payment_info?.companyName || '未登记收款账户' }}</el-descriptions-item>
            <el-descriptions-item label="开户行">{{ currentInstance.counterparty_payment_info?.bankName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="收款账号">{{ currentInstance.counterparty_payment_info?.accountNumber || '-' }}</el-descriptions-item>
            <el-descriptions-item label="收款方税号">{{ currentInstance.counterparty_payment_info?.taxNo || '-' }}</el-descriptions-item>
            <el-descriptions-item label="收款备注" :span="2">{{ currentInstance.counterparty_payment_info?.remark || '-' }}</el-descriptions-item>
          </el-descriptions>
        </template>
        <template v-if="currentInstance.originalData">
          <el-divider>{{ currentInstance.originalTitle || '原始单据' }}</el-divider>
          <el-descriptions :column="2" border>
            <el-descriptions-item v-for="field in detailScalarFields(currentInstance.originalData, currentInstance.business_type)" :key="field.key" :label="field.label" :span="field.span">{{ field.value }}</el-descriptions-item>
          </el-descriptions>
          <div v-for="section in detailArraySections(currentInstance.originalData)" :key="section.key" class="detail-section">
            <div class="detail-section-title">{{ section.label }}</div>
            <el-table :data="section.rows" stripe border size="small"><el-table-column v-for="column in section.columns" :key="column.key" :label="column.label" min-width="120"><template #default="{ row }">{{ formatDetailValue(row[column.key]) }}</template></el-table-column></el-table>
          </div>
          <div v-if="currentInstance.business_type === 'payable_settlement' && currentInstance.originalData.items?.length" class="detail-section">
            <div class="detail-section-title">关联采购单</div>
            <el-table :data="currentInstance.originalData.items" stripe border size="small">
              <el-table-column prop="request_no" label="采购单号" min-width="180" />
              <el-table-column prop="amount" label="结算金额" width="130"><template #default="{ row }">¥{{ formatMoney(row.amount) }}</template></el-table-column>
              <el-table-column label="操作" width="120"><template #default="{ row }"><el-button v-if="row.purchase_request_id" link type="primary" @click="openSettlementPurchase(row.purchase_request_id)">查看采购单</el-button></template></el-table-column>
            </el-table>
          </div>
          <template v-if="currentInstance.linkedDocument">
            <el-divider>采购单详情</el-divider>
            <el-descriptions :column="2" border><el-descriptions-item v-for="field in detailScalarFields(currentInstance.linkedDocument)" :key="field.key" :label="field.label" :span="field.span">{{ field.value }}</el-descriptions-item></el-descriptions>
            <div v-for="section in detailArraySections(currentInstance.linkedDocument)" :key="`linked-${section.key}`" class="detail-section"><div class="detail-section-title">{{ section.label }}</div><el-table :data="section.rows" stripe border size="small"><el-table-column v-for="column in section.columns" :key="column.key" :label="column.label" min-width="120"><template #default="{ row }">{{ formatDetailValue(row[column.key]) }}</template></el-table-column></el-table></div>
          </template>
        </template>
        <el-divider>审批流程</el-divider>
        <el-empty v-if="!(currentInstance.Tasks || []).length" description="暂无审批记录" :image-size="60" />
        <el-timeline v-else>
          <el-timeline-item v-for="task in currentInstance.Tasks" :key="task.task_id" :timestamp="task.acted_time || task.update_time || task.create_time" :type="task.status === 'approved' ? 'success' : task.status === 'rejected' ? 'danger' : 'primary'">
            <div class="approval-timeline-head"><strong>{{ task.node_name || '审批节点' }}</strong><el-tag size="small" :type="task.status === 'approved' ? 'success' : task.status === 'rejected' ? 'danger' : task.status === 'pending' ? 'warning' : 'info'">{{ taskStatusText(task.status) }}</el-tag></div>
            <div>审批人：{{ task.Assignee?.name || task.assignee?.name || task.assignee_staff_id || '未指定' }}</div>
            <div v-if="task.comment" class="approval-timeline-comment">意见：{{ task.comment }}</div>
          </el-timeline-item>
        </el-timeline>
      </template>
      <template #footer>
        <el-button v-if="canViewOriginal(currentInstance)" @click="openOriginalDocument">查看原始单据</el-button>
        <el-button v-if="detailReviewRow" type="success" @click="reviewFromDetail('approve')">通过</el-button>
        <el-button v-if="detailReviewRow" type="danger" @click="reviewFromDetail('reject')">拒绝</el-button>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="attributionEditVisible" title="调整费用分摊金额" width="620px">
      <el-alert title="只能调整当前审批节点的费用分摊金额，合计必须等于费用总额；调整会记录审计日志。" type="info" :closable="false" />
      <el-table :data="attributionEditRows" border stripe style="margin-top: 14px">
        <el-table-column prop="target_name" label="归属对象" min-width="180" />
        <el-table-column label="分摊金额" width="220">
          <template #default="{ row }"><el-input-number v-model="row.amount" :min="0" :precision="2" controls-position="right" /></template>
        </el-table-column>
      </el-table>
      <div class="attribution-total">合计：¥{{ attributionEditTotal.toFixed(2) }} / 费用总额：¥{{ attributionEditAmount.toFixed(2) }}</div>
      <template #footer><el-button @click="attributionEditVisible = false">取消</el-button><el-button type="primary" :loading="attributionEditLoading" @click="saveAttributionEditor">保存调整</el-button></template>
    </el-dialog>

    <el-dialog v-model="flowDialogVisible" :title="flowForm.definitionId ? '编辑当前流程' : '新增审批流程'" width="900px">
      <el-form label-width="110px">
        <el-form-item label="流程编码"><el-input v-model="flowForm.flowCode" :disabled="!!flowForm.definitionId" placeholder="如 expense_reimburse" /></el-form-item>
        <el-form-item label="流程名称"><el-input v-model="flowForm.name" /></el-form-item>
        <el-form-item label="业务类型"><el-input v-model="flowForm.businessType" placeholder="如 expense_reimburse" /></el-form-item>
        <el-divider>审批节点</el-divider>
        <div v-for="(node, nodeIndex) in flowForm.nodes" :key="nodeIndex" class="node-card">
          <div class="node-head"><el-input v-model="node.name" placeholder="节点名称" /><el-select v-model="node.signMode" style="width:150px"><el-option label="串行签批" value="serial" /><el-option label="或签（一人通过）" value="or" /></el-select><el-button link type="danger" @click="removeNode(nodeIndex)">删除节点</el-button></div>
          <div v-for="(rule, ruleIndex) in node.approvers" :key="ruleIndex" class="rule-row">
            <el-select v-model="rule.type" style="width:170px" @change="clearRule(rule)">
              <el-option label="门店店长" value="store_manager" />
              <el-option label="门店授权人员" value="store_staff" />
              <el-option label="直属上级" value="direct_supervisor" />
              <el-option label="指定人员" value="fixed_user" />
              <el-option label="审批部门/角色" value="role" />
            </el-select>
            <el-select v-if="rule.type === 'fixed_user'" v-model="rule.staffId" filterable style="width:220px" placeholder="选择人员"><el-option v-for="item in assigneeOptions.staff" :key="item.staff_id" :label="`${item.name} (${item.phone})`" :value="item.staff_id" /></el-select>
            <el-select v-if="rule.type === 'role'" v-model="rule.roleCode" style="width:180px" placeholder="选择角色"><el-option v-for="item in assigneeOptions.roles" :key="item.role_code" :label="item.name" :value="item.role_code" /></el-select>
            <el-select v-if="rule.type === 'role'" v-model="rule.scope" style="width:180px"><el-option label="主题人所在门店" value="subject_store" /><el-option label="主题人所在经销商" value="subject_distributor" /></el-select>
            <el-button link type="danger" @click="node.approvers.splice(ruleIndex, 1)">删除审批人</el-button>
          </div>
          <el-button link type="primary" @click="node.approvers.push(newRule())">添加审批人</el-button>
        </div>
        <el-button plain @click="addNode">添加审批节点</el-button>
      </el-form>
      <template #footer><el-button @click="flowDialogVisible = false">取消</el-button><el-button type="primary" @click="saveFlow">{{ flowForm.definitionId ? '保存并立即生效' : '保存草稿' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('tasks')
const route = useRoute()
const router = useRouter()
const syncTabFromRoute = () => {
  activeTab.value = String(route.meta.tab || 'tasks')
}
const loading = ref(false)
const batchApproving = ref(false)
const tasks = ref([])
const salesTasks = ref([])
const moduleTasks = ref([])
const instances = ref([])
const handledInstances = ref([])
const handledLoading = ref(false)
const handledPage = ref(1)
const handledPageSize = ref(20)
const handledTotal = ref(0)
const flows = ref([])
const detailVisible = ref(false)
const currentInstance = ref(null)
const detailReviewRow = ref(null)
let detailRequestSerial = 0
const flowDialogVisible = ref(false)
const attributionEditVisible = ref(false)
const attributionEditLoading = ref(false)
const attributionEditExpenseId = ref('')
const attributionEditAmount = ref(0)
const attributionEditRows = ref([])
const attributionEditTotal = computed(() => attributionEditRows.value.reduce((sum, row) => sum + Number(row.amount || 0), 0))
const assigneeOptions = reactive({ staff: [], roles: [], stores: [] })
const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
const approvalIssues = ref([])
const approvalProductCategoryOptions = ref([])
const productApplicationCategoryTree = ref([])
const productApplicationCategoryFields = ref([])
const productApplicationEdit = ref(null)
const purchaseItemsNeedingCategory = computed(() => {
  if (!['purchase', 'purchase_request'].includes(detailReviewRow.value?.moduleType)) return []
  const items = currentInstance.value?.moduleData?.items || []
  return items.filter(item => Number(item.is_used_product || item.isUsedProduct) === 1 && !(item.product_id || item.productId) && !item.categoryFromPayload)
})
const roleCodes = computed(() => {
  const rawRoles = Array.isArray(userInfo.roles) && userInfo.roles.length
    ? userInfo.roles
    : String(userInfo.roleCode || userInfo.userRole || userInfo.role || '').split(',')
  const roleAliases = { distributor: 'admin', system_admin: 'admin', store_admin: 'manager' }
  return [...new Set(rawRoles.map(role => String(role || '').trim().toLowerCase()).filter(Boolean).map(role => roleAliases[role] || role))]
})
const canReviewSales = computed(() => roleCodes.value.some(role => ['boss', 'admin', 'manager', 'store_manager', 'store_admin'].includes(role)))
const canConfigure = computed(() => roleCodes.value.some(role => ['admin', 'boss'].includes(role)))
const flowForm = reactive({ definitionId: '', flowCode: '', name: '', businessType: '', nodes: [] })
const taskFilters = reactive({ applicant: '', supplier: '', type: '' })
const mergedTasks = computed(() => {
  const genericTasks = tasks.value.map(row => ({ ...row, isSalesApproval: false }))
  const salesApprovalTasks = salesTasks.value.map(row => ({
    isSalesApproval: true,
    salesRow: row,
    node_name: '负毛利归档审批',
    create_time: row.create_time,
    Instance: {
      title: `销售订单 ${row.order_no || '-'}`,
      business_type: 'sales_negative_gross_profit',
      instance_no: row.order_no,
      create_time: row.create_time,
      summary: '归档前最终毛利为负'
    }
  }))
  return genericTasks.concat(salesApprovalTasks, moduleTasks.value).sort((left, right) => (
    new Date(taskCreateTime(right)).getTime() - new Date(taskCreateTime(left)).getTime()
  ))
})
const taskTypeOptions = computed(() => [...new Map(mergedTasks.value.map(row => {
  const value = row.isSalesApproval ? 'sales_negative_gross_profit' : (row.moduleType || row.Instance?.business_type || '')
  return [value, { value, label: taskBusinessType(row) }]
})).values()].filter(item => item.value))
const normalizedTaskFilter = value => String(value || '').trim().toLowerCase()
const filteredMergedTasks = computed(() => {
  const applicant = normalizedTaskFilter(taskFilters.applicant)
  const supplier = normalizedTaskFilter(taskFilters.supplier)
  return mergedTasks.value.filter(row => {
    const type = row.isSalesApproval ? 'sales_negative_gross_profit' : (row.moduleType || row.Instance?.business_type || '')
    return (!taskFilters.type || type === taskFilters.type)
      && (!applicant || normalizedTaskFilter(taskApplicant(row)).includes(applicant))
      && (!supplier || normalizedTaskFilter(taskSupplier(row)).includes(supplier))
  })
})
function resetTaskFilters() { Object.assign(taskFilters, { applicant: '', supplier: '', type: '' }) }

const newRule = () => ({ type: 'store_manager', staffId: '', roleCode: '', scope: 'subject_store' })
const newNode = () => ({ name: '', signMode: 'serial', approvers: [newRule()] })

async function loadTasks() { tasks.value = responseList(await api.getApprovalTasks({ status: 'pending' })) }
async function loadSalesTasks() {
  if (!canReviewSales.value) {
    salesTasks.value = []
    return
  }
  const response = await api.getSalesApprovalList({ page: 1, pageSize: 100 })
  salesTasks.value = responseList(response)
}
function responseList(response) {
  const payload = response?.data ?? response
  if (Array.isArray(payload)) return payload
  return payload?.list || payload?.rows || payload?.items || payload?.records || []
}
function canReviewRole(allowedRoles) {
  return roleCodes.value.includes('boss') || roleCodes.value.some(role => allowedRoles.includes(role))
}
function moduleTask(type, row, fields) {
  const id = fields.id
  if (!id) return null
  const no = fields.no || id
  const createTime = fields.createTime || row.create_time || row.createTime || ''
  return {
    isModuleApproval: true,
    moduleType: type,
    moduleRow: row,
    instance_id: `${type}:${id}`,
    node_name: fields.node || '待审批',
    create_time: createTime,
    amountText: fields.amountText || '-',
    Instance: {
      title: fields.title || no,
      business_type: type,
      instance_no: no,
      business_id: id,
      create_time: createTime,
      summary: fields.summary || '-'
    }
  }
}
function moneyText(value, signed = false) {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) return '-'
  const prefix = signed && amount >= 0 ? '+' : ''
  return `${prefix}¥${amount.toFixed(2)}`
}
async function loadPurchaseApprovalRows() {
  const params = { scope: 'review', page: 1, pageSize: 100 }
  const responses = await Promise.all([
    api.getPurchaseRequestList({ ...params, status: 'pending' }).catch(() => null),
    api.getPurchaseRequestList({ ...params, status: 'pending_approval' }).catch(() => null)
  ])
  const rows = responses.flatMap(response => response ? responseList(response) : [])
  const seen = new Set()
  return rows.filter(row => {
    const key = row.request_id || row.requestId || row.request_no || row.requestNo
    if (!key || seen.has(String(key))) return false
    seen.add(String(key))
    return true
  })
}
async function loadOtherApprovalTasks() {
  const response = await api.getBusinessApprovalTasks()
  const rows = Array.isArray(response?.data) ? response.data : response?.data?.data || []
  approvalIssues.value = response.issues || []
  // 调拨确认需在调拨管理选择SN/上传凭证，与手机端保持一致，不在审批中心重复展示。
  moduleTasks.value = rows.filter(item => !item.manual_path && !['inventory_transfer', 'inventory_transfer_receipt'].includes(item.business_type)).map(item => ({
    ...moduleTask(item.business_type, item.row, {
      id: item.business_id, no: item.business_no, node: item.node_name,
      title: item.row.product_name || item.row.supplier_name || businessTypeText(item.business_type),
      summary: item.row.reason || item.row.remark || '',
      amountText: businessAmountText(item.row)
    }),
    managedBusiness: true, manualPath: item.manual_path, approvalInstanceId: item.instance_id
  }))
}
function businessAmountText(data = {}) {
  const candidates = [data.actual_total, data.actualTotal, data.total_amount, data.totalAmount, data.refund_amount, data.refundAmount, data.amount, data.change_amount, data.signed_amount]
  const value = candidates.find(item => item !== undefined && item !== null && item !== '' && Number(item) !== 0)
    ?? candidates.find(item => item !== undefined && item !== null && item !== '')
  return value === undefined ? '-' : moneyText(value)
}
async function initializeFlows() {
  await api.initializeApprovalFlows()
  ElMessage.success('系统流程已补齐')
  await loadFlows()
}
async function loadInstances() { instances.value = (await api.getApprovalInstances({ scope: 'mine' })).data || [] }
async function loadHandledInstances() {
  handledLoading.value = true
  try {
    const response = await api.getApprovalInstances({ scope: 'handled', page: handledPage.value, pageSize: handledPageSize.value })
    const payload = response?.data || {}
    handledInstances.value = payload.list || []
    handledTotal.value = Number(payload.total || 0)
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '查询我的审批失败')
  } finally { handledLoading.value = false }
}
function onHandledPageSizeChange() { handledPage.value = 1; loadHandledInstances() }
async function loadFlows() { if (canConfigure.value) flows.value = (await api.getApprovalFlows()).data || [] }
async function loadOptions() { if (canConfigure.value) Object.assign(assigneeOptions, (await api.getApprovalAssigneeOptions()).data || {}) }
async function reload() { loading.value = true; try { await Promise.all([loadTasks(), loadOtherApprovalTasks(), loadInstances(), loadFlows(), loadOptions(), ...(activeTab.value === 'handled' ? [loadHandledInstances()] : [])]) } finally { loading.value = false } }

async function approveTaskDirect(row) {
  if (row.isSalesApproval) return api.approveOrder(row.salesRow.order_id)
  if (row.isModuleApproval) {
    if (row.manualPath) return { skipped: true }
    if (['manufacturer_rebate_confirmation', 'product_application'].includes(row.moduleType)) return { skipped: true }
    return api.actionBusinessApproval(row.moduleType, row.Instance?.business_id, { action: 'approve', comment: '' })
  }
  return api.actionApproval(row.instance_id, { action: 'approve', comment: '' })
}

async function approveAll() {
  if (batchApproving.value || !mergedTasks.value.length) return
  const confirmed = await ElMessageBox.confirm(
    `确认将当前 ${mergedTasks.value.length} 条待审批单据全部通过？`,
    '一键审批',
    { type: 'warning', confirmButtonText: '全部通过', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  batchApproving.value = true
  const failed = []
  const total = mergedTasks.value.length
  try {
    for (const row of mergedTasks.value) {
      try {
        const result = await approveTaskDirect(row)
        if (result?.skipped) failed.push(`${taskNo(row)}：需前往业务页面确认`)
      } catch (error) {
        failed.push(`${taskNo(row)}：${error.response?.data?.message || error.message || '审批失败'}`)
      }
    }
    await reload()
    if (failed.length) ElMessage.warning(`已处理 ${total - failed.length} 条，${failed.length} 条未通过：${failed.slice(0, 3).join('；')}`)
    else ElMessage.success('全部待审批单据已通过')
  } finally {
    batchApproving.value = false
  }
}

function instanceProgressText(row) { return row.current_progress_text || statusText(row.status) }
function statusText(value) { return ({ pending: '审批中', approved: '已通过', rejected: '已拒绝', cancelled: '已撤销' }[value] || value || '-') }
function businessTypeText(value) {
  return ({
    sn_change: 'SN修改申请',
    sales_negative_gross_profit: '销售负毛利',
    purchase: '采购审批',
    expense: '报销审批',
    product: '商品审批',
    payable_settlement: '应付结算单审批',
    return: '退库审批',
    sales_return: '销售退单',
    resource: '资源套回',
    profit: '毛利调整',
    purchase_expense: '采购垫付报销审批',
    inventory_transfer_receipt: '调拨入库确认',
    inventory_batch: '批量库存维护审批',
    sale_share: '销售晒单审核',
    purchase_request: '采购申请审批',
    product_application: '新建商品审批',
    inventory_transfer: '库存调拨审批',
    sales_order_negative_gross_profit: '销售负毛利归档审批',
    deposit_refund: '定金退款审批',
    return_stock: '退库审批',
    resource_claim: '资源权益套回审批',
    profit_adjustment: '毛利调整审批',
    manufacturer_rebate_confirmation: '厂商返利金额确认',
    subsidy_receivable_adjustment: '国补差额审批',
    expense_performance_allocation: '费用绩效分摊审批'
  }[value] || value || '-')
}
function statusType(value) { return ({ pending: 'warning', approved: 'success', rejected: 'danger' }[value] || 'info') }
function taskStatusText(value) { return ({ pending: '待审批', waiting: '等待中', approved: '已通过', rejected: '已拒绝', cancelled: '已取消' }[value] || value) }
function formatMoney(value) { return Number(value || 0).toFixed(2) }
function formatProfit(value) { return value === undefined || value === null ? '-' : `¥${formatMoney(value)}` }
function taskTitle(row) { return row.isSalesApproval ? `销售订单 ${row.salesRow?.order_no || '-'}` : row.Instance?.title || '-' }
function salesApprovalStage(row = {}) {
  const stage = row.approval_stage || row.approvalStage
  if (stage === 'store' || stage === 'distributor') return stage
  if (['pending_store_approval', 'pending_approval'].includes(row.order_status)) return 'store'
  if (row.order_status === 'pending_distributor_approval') return 'distributor'
  return ''
}
function salesApprovalStageText(row = {}) {
  return salesApprovalStage(row) === 'distributor' ? '待经销商总权限审批' : '待店长审批'
}
function taskNode(row) {
  if (row.managedBusiness) return row.node_name || '-'
  if (row.isSalesApproval) return salesApprovalStageText(row.salesRow || {})
  if (row.moduleType === 'sales_return') {
    const stage = row.moduleRow?.approval_stage || row.moduleRow?.approvalStage || ''
    return stage === 'pending_li' ? '李燕审批' : stage === 'pending_deng' ? '邓红梅审批' : stage === 'pending_duan' ? '段超审批' : '店长审批'
  }
  return row.node_name || '-'
}
function taskBusinessType(row) { return businessTypeText(row.isSalesApproval ? 'sales_negative_gross_profit' : row.Instance?.business_type) }
function taskNo(row) { return row.isSalesApproval ? row.salesRow?.order_no || '-' : row.Instance?.instance_no || '-' }
function taskCreateTime(row) { return row.isSalesApproval ? row.salesRow?.create_time || '-' : row.create_time || row.Instance?.create_time || '-' }
function taskAmount(row) {
  if (row.isSalesApproval) return formatProfit(row.salesRow?.grossProfitSnapshot?.gross_profit_amount)
  return row.amountText || row.Instance?.display?.amount || '-'
}
function taskData(row) { return row.isSalesApproval ? row.salesRow || {} : (row.moduleRow || row.Instance?.display || {}) }
function taskMainInfo(row) {
  const data = taskData(row)
  if (row.isSalesApproval) return data.product_name || data.productName || data.order_no || '-'
  if (row.Instance?.business_type === 'payable_settlement') return data.settlement_no || data.title || row.Instance?.instance_no || '-'
  return data.product_name || data.productName || data.items_summary || data.name || taskTitle(row)
}
function taskCounterparty(row) {
  const data = taskData(row)
  if (row.isSalesApproval) return data.salesperson_name || data.salesperson || data.sales_name || data.create_user || '-'
  return data.supplier_name || data.supplierName || data.employee_name || data.applicant_name || data.applicantName || '-'
}
function taskApplicant(row) {
  const data = taskData(row)
  if (row.isSalesApproval) return data.submit_user || data.submitter_name || data.create_user || data.salesperson_name || '-'
  return moduleApplicant(data) || row.Instance?.applicant_name || row.Instance?.Applicant?.name || '-'
}
function taskSupplier(row) {
  const data = taskData(row)
  return data.supplier_name || data.supplierName || data.Supplier?.name || '-'
}
function taskTaxStatus(row) {
  const data = taskData(row)
  const value = String(data.tax_status || data.taxStatus || data.invoice_type || data.invoiceType || data.has_invoice || '').trim()
  if (value === true || value === 1 || value === '1') return '有发票'
  const normalized = value.toUpperCase()
  if (normalized === 'TAX_INCLUDED') return '含税'
  if (normalized === 'UNTAXED') return '未税'
  if (normalized === 'MIXED') return '混合税务'
  if (normalized === 'UNKNOWN' || !value || normalized === 'NONE') return '待补充'
  if (value.includes('专票') || normalized === 'SPECIAL') return '含税'
  if (value.includes('未税') || value.includes('收据') || value.includes('普票')) return '未税'
  return '待补充'
}
const detailFieldLabels = {
  sales_order_no: '销售订单号', sale_price: '销售价格', original_pickup_price: '提货价', settlement_price_at_sale: '当前结算价格', po_policy_at_sale: 'PO政策', so_policy_at_sale: 'SO政策', other_policy_at_sale: '其他政策', policy_remark: '备注', policy_name: '当前政策', policy_content: '政策内容', sn: 'SN',
  application_no: '申请单号', application_id: '申请ID', request_no: '采购申请单号', request_id: '采购申请ID',
  expense_no: '费用单号', expense_id: '费用ID', return_no: '退库单号', return_id: '退库申请ID',
  change_order_no: '变更单号', change_id: '变更ID', adjustment_no: '调整单号', adjustment_id: '调整ID',
  order_no: '订单号', order_id: '订单ID', create_time: '发起时间', update_time: '更新时间',
  applicant_name: '申请人', applicant_staff_id: '申请人ID', submitter_name: '提交人', submit_user: '提交人',
  apply_user: '发起账号', applicant_store_name: '申请门店', store_name: '门店', store_id: '门店ID',
  applicant_distributor_name: '经销商', distributor_id: '经销商ID', supplier_name: '供应商', supplier_id: '供应商ID',
  name: '商品名称', product_name: '商品名称', productName: '商品名称', product_code: '商品编码', productCode: '商品编码', pn_code: 'PN', pnCode: 'PN', sn_code: 'SN', snCode: 'SN',
  categoryId: '分类ID', manufacturerCode: '厂商编码', needSn: '需要SN', needImei: '需要IMEI', unit: '单位', config: '配置',
  barcodes: '条码', pns: 'PN明细', attributes: '商品属性', labelPhotoIds: '标签照片', labelPhotoUrls: '标签照片地址', isFocusProduct: '重点商品',
  category_name: '商品分类', expense_type: '费用类型', expense_party: '费用发生方', payment_method: '付款方式',
  invoice_type: '发票类型', product_type: '货型', reason: '申请原因', return_reason: '退单缘由', remark: '备注',
  amount: '金额', total_amount: '申请金额', actual_total: '实际金额', current_actual_total: '当前实际金额',
  refund_amount: '退款金额', change_amount: '套回金额', signed_amount: '调整金额', base_gross_profit: '调整前毛利',
  gross_profit_amount: '毛利金额', adjustment_type: '调整方向', status: '业务状态', approval_status: '审批状态',
  approval_stage: '审批阶段', review_comment: '审批意见', reviewer_name: '审批人', review_time: '审批时间',
  attachment_url: '附件地址', source_type: '来源类型', source_no: '来源单号'
}
Object.assign(detailFieldLabels, { expense_date: '\u8d39\u7528\u65e5\u671f', accounting_month: '\u6838\u7b97\u6708\u4efd', affects_store_profit: '\u8ba1\u5165\u95e8\u5e97\u5229\u6da6', has_invoice: '\u662f\u5426\u6709\u53d1\u7968', invoice_no: '\u53d1\u7968\u53f7', attribution_type: '\u8d39\u7528\u5f52\u5c5e', attribution_method: '\u5206\u644a\u65b9\u5f0f', related_order_no: '\u5173\u8054\u8ba2\u5355', target_type: '\u5f52\u5c5e\u7c7b\u578b', target_name: '\u5f52\u5c5e\u5bf9\u8c61', url: '\u9644\u4ef6' })
const detailArrayLabels = { items: '商品明细', OrderItems: '订单商品明细', InboundItems: '入库商品明细', originalOrderItems: '原订单商品明细', attachments: '附件' }
Object.assign(detailArrayLabels, { attribution_details: '\u8d39\u7528\u5f52\u5c5e\u5206\u644a' })
const detailArrayColumnLabels = {
  product_name: '商品名称', product_code: '商品编码', pn_code: 'PN', sn_code: 'SN', quantity: '数量',
  current_quantity: '当前数量', unit_price: '单价', amount: '金额', amount_delta: '金额变化',
  store_name: '门店', storeName: '门店', reason: '原因', original_name: '附件名称', mime_type: '文件类型', file_size: '文件大小'
}
Object.assign(detailArrayColumnLabels, { target_type: '\u5f52\u5c5e\u7c7b\u578b', target_name: '\u5f52\u5c5e\u5bf9\u8c61', url: '\u9644\u4ef6' })
const detailAllowedKeys = new Set([
  'sales_order_no', 'sale_price', 'original_pickup_price', 'settlement_price_at_sale', 'po_policy_at_sale', 'so_policy_at_sale', 'other_policy_at_sale', 'policy_remark', 'policy_name', 'policy_content', 'sn',
  'application_no', 'request_no', 'expense_no', 'return_no', 'change_order_no', 'adjustment_no', 'order_no', 'settlement_no',
  'create_time', 'submit_time', 'applicant_name', 'submitter_name', 'submit_user', 'apply_user', 'applicant_store_name', 'store_name',
  'supplier_name', 'employee_name', 'salesperson_name', 'name', 'product_name', 'productName', 'product_code', 'productCode', 'pn_code', 'pnCode', 'sn_code', 'snCode',
  'category_name', 'expense_type', 'expense_party', 'expense_date', 'accounting_month', 'affects_store_profit', 'payment_method', 'has_invoice', 'invoice_type', 'invoice_no', 'attribution_type', 'attribution_method', 'related_order_no', 'tax_status', 'tax_rate', 'product_type',
  'reason', 'return_reason', 'remark', 'amount', 'total_amount', 'actual_total', 'current_actual_total', 'paid_amount', 'unpaid_amount',
  'refund_amount', 'change_amount', 'signed_amount', 'base_gross_profit', 'gross_profit_amount', 'sales_gross_profit', 'sales_amount', 'sales_settlement_cost',
  'adjustment_type', 'review_comment', 'reviewer_name', 'review_time', 'attachment_url', 'source_no', 'payee_name', 'payment_status'
])
const hiddenDetailKeys = new Set(['Applicant', 'applicant', 'Store', 'Supplier', 'settlement', 'originalOrder', 'adjustments', 'action_logs', 'payload_json', 'definition_snapshot_json', 'category_id', 'categoryId', 'category_path_legacy', 'brand', 'model', 'series', 'category', 'business_id', 'request_id', 'application_id', 'expense_id', 'return_id', 'change_id', 'adjustment_id', 'order_id', 'settlement_id', 'applicant_staff_id', 'store_id', 'supplier_id', 'distributor_id', 'status', 'approval_status', 'approval_stage'])
function detailLabel(key) {
  if (detailFieldLabels[key]) return detailFieldLabels[key]
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
}
function formatDetailValue(value) {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
function formatJson(value) {
  try { return JSON.stringify(value, null, 2) } catch (error) { return String(value || '') }
}
function detailScalarFields(data = {}) {
  return Object.entries(data)
    .filter(([key, value]) => detailAllowedKeys.has(key) && !hiddenDetailKeys.has(key) && !Array.isArray(value) && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => ({ key, label: detailLabel(key), value: formatDetailValue(value), span: ['remark', 'reason', 'return_reason', 'review_comment', 'policy_content', 'po_policy_at_sale', 'so_policy_at_sale', 'other_policy_at_sale', 'policy_remark'].includes(key) ? 2 : 1 }))
}
function detailArraySections(data = {}) {
  return Object.entries(data)
    .filter(([key, value]) => ['items', 'OrderItems', 'InboundItems', 'originalOrderItems', 'attribution_details', 'attachments'].includes(key) && Array.isArray(value) && value.length && !hiddenDetailKeys.has(key))
    .map(([key, rows]) => {
      const objectRows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
      if (!objectRows.length) return null
      const keys = [...new Set(objectRows.flatMap(row => Object.keys(row)))]
        .filter(columnKey => !hiddenDetailKeys.has(columnKey) && objectRows.some(row => row[columnKey] !== undefined && row[columnKey] !== null && row[columnKey] !== '' && typeof row[columnKey] !== 'object'))
      const preferred = key === 'attribution_details' ? ['target_type', 'target_name', 'amount', 'reason'] : ['product_name', 'product_code', 'pn_code', 'sn_code', 'quantity', 'current_quantity', 'unit_price', 'amount', 'amount_delta', 'original_name', 'url', 'mime_type', 'file_size']
      const orderedKeys = [...preferred.filter(columnKey => keys.includes(columnKey)), ...keys.filter(columnKey => !preferred.includes(columnKey))].slice(0, 8)
      return {
        key,
        label: detailArrayLabels[key] || detailLabel(key),
        rows: objectRows,
        columns: orderedKeys.map(columnKey => ({ key: columnKey, label: detailArrayColumnLabels[columnKey] || detailLabel(columnKey) }))
      }
    })
    .filter(section => section && section.columns.length)
}
function detailHasContent(data = {}) {
  return detailScalarFields(data).length > 0 || detailArraySections(data).length > 0
}
function responseData(response) {
  const payload = response?.data ?? response
  return payload?.data ?? payload
}
function moduleApplicant(data = {}) {
  return data.applicant_name || data.applicantName || data.submitter_name || data.submit_user || data.apply_user || data.create_user || data.createUser || data.operator_name || data.Applicant?.name || data.applicant?.name || ''
}
function moduleStore(data = {}) {
  return data.store_name || data.applicant_store_name || data.Store?.name || data.Applicant?.Store?.name || data.storeName || ''
}
function buildModuleInstance(row, moduleData = row.moduleRow || {}) {
  return {
    title: taskTitle(row),
    status: 'pending',
    instance_no: taskNo(row),
    business_type: taskBusinessType(row),
    business_id: row.Instance?.business_id || '-',
    summary: row.Instance?.summary || '-',
    create_time: row.create_time || row.Instance?.create_time || moduleData.create_time || '-',
    applicant_name: moduleApplicant(moduleData),
    applicant_staff_id: moduleData.applicant_staff_id || moduleData.applicantStaffId || '',
    store_name: moduleStore(moduleData),
    store_id: moduleData.store_id || moduleData.storeId || '',
    moduleType: row.moduleType,
    moduleData,
    returnReason: row.moduleType === 'sales_return' ? moduleData.reason || moduleData.return_reason || '' : undefined,
    Tasks: []
  }
}
async function loadModuleDetail(row) {
  const aliases = { purchase_request: 'purchase', product_application: 'product', purchase_expense: 'expense', profit_adjustment: 'profit' }
  if (row.managedBusiness && aliases[row.moduleType]) row = { ...row, moduleType: aliases[row.moduleType] }
  const id = row.Instance?.business_id
  const source = row.moduleRow || {}
  if (!id) return source
  if (row.moduleType === 'sales_order_negative_gross_profit') return responseData(await api.getSalesDetail(id))
  if (['inventory_transfer', 'inventory_transfer_receipt'].includes(row.moduleType)) return responseData(await api.getTransferDetail(id))
  if (row.moduleType === 'inventory_batch') return responseData(await api.getInventoryBatchApplicationDetail(id))
  if (row.moduleType === 'return_stock') return responseList(await api.getReturnList({ returnId: id }))[0] || source
  if (row.moduleType === 'purchase') {
    const response = responseData(await api.getPurchaseRequestDetail(id)) || {}
    const data = {
      ...source,
      ...response,
      apply_user: response.apply_user || response.applicant_name || response.submit_user || source.apply_user || source.applicant_name || source.submit_user || source.create_user || '',
      applicant_name: response.applicant_name || response.apply_user || response.submit_user || source.applicant_name || source.apply_user || source.submit_user || source.create_user || '',
      total_amount: Number(response.total_amount || response.actual_total || source.total_amount || source.actual_total || 0),
      actual_total: Number(response.actual_total || response.total_amount || source.actual_total || source.total_amount || 0)
    }
    return {
      ...data,
      items: (data.items || []).map(item => {
        let payload = item.new_product_payload || item.newProductPayload || {}
        if (typeof payload === 'string') { try { payload = JSON.parse(payload || '{}') } catch (error) { payload = {} } }
        const categoryId = payload.categoryId || payload.category_id || ''
        return { ...item, approvalCategoryId: categoryId, categoryFromPayload: Boolean(categoryId) }
      })
    }
  }
  if (row.moduleType === 'expense') return responseData(await api.getExpenseDetail(id))
  if (row.moduleType === 'product') {
    const data = responseData(await api.getProductApplicationDetail(id)) || source
    const payload = typeof data.payload_json === 'string' ? (() => { try { return JSON.parse(data.payload_json) } catch (error) { return null } })() : data.payload_json
    return payload && typeof payload === 'object' ? { ...data, ...payload } : data
  }
  if (row.moduleType === 'sales_return' && source.order_id) {
    const order = responseData(await api.getSalesDetail(source.order_id))
    return { ...source, original_order_no: order?.order_no || source.order_no, original_order_customer_name: order?.customer_name || '', originalOrder: order, originalOrderItems: order?.OrderItems || order?.items || [] }
  }
  if (row.moduleType === 'profit' && source.order_id) {
    const order = responseData(await api.getSalesDetail(source.order_id))
    return { ...source, original_order_no: order?.order_no || source.order_no, original_order_customer_name: order?.customer_name || '', originalOrder: order, originalOrderItems: order?.OrderItems || order?.items || [] }
  }
  return source
}
async function openInstance(id, row = null) {
  const serial = ++detailRequestSerial
  currentInstance.value = null
  detailReviewRow.value = row
  detailVisible.value = true
  try {
    const instance = responseData(await api.getApprovalInstance(id))
    if (serial === detailRequestSerial) currentInstance.value = instance
  } catch (error) {
    detailVisible.value = false
    ElMessage.error(error.response?.data?.message || error.message || '审批详情加载失败')
  }
}
async function openAttributionEditor(row) {
  const expenseId = row.Instance?.business_id
  if (!expenseId) return
  try {
    const response = await api.getExpenseDetail(expenseId)
    const data = response?.data?.data || response?.data || response || {}
    let details = data.attribution_details
    if (!Array.isArray(details)) {
      try { details = JSON.parse(data.attribution_details_json || '[]') } catch (error) { details = [] }
    }
    attributionEditExpenseId.value = expenseId
    attributionEditAmount.value = Number(data.amount || row.amount || 0)
    attributionEditRows.value = details.map(item => ({ ...item, amount: Number(item.amount || 0) }))
    attributionEditVisible.value = true
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || '加载费用分摊失败')
  }
}
async function saveAttributionEditor() {
  if (!attributionEditExpenseId.value) return
  if (Math.abs(attributionEditTotal.value - attributionEditAmount.value) > 0.01) {
    ElMessage.warning('分摊金额必须等于费用总额')
    return
  }
  attributionEditLoading.value = true
  try {
    const response = await api.updateExpenseAttribution(attributionEditExpenseId.value, {
      attributionMethod: 'MANUAL',
      allocationDetails: attributionEditRows.value.map(item => ({
        targetId: item.target_id,
        targetName: item.target_name,
        amount: Number(item.amount || 0)
      }))
    })
    if (response?.code === 0) {
      ElMessage.success(response.message || '费用归属已调整')
      attributionEditVisible.value = false
      await reload()
    }
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || '调整费用分摊失败')
  } finally {
    attributionEditLoading.value = false
  }
}
async function openModule(row) {
  const serial = ++detailRequestSerial
  currentInstance.value = buildModuleInstance(row)
  detailReviewRow.value = row
  currentInstance.value.detailLoading = true
  detailVisible.value = true
  try {
    const moduleData = await loadModuleDetail(row)
    const approval = row.approvalInstanceId ? responseData(await api.getApprovalInstance(row.approvalInstanceId)) : null
    if (serial !== detailRequestSerial) return
    currentInstance.value = { ...buildModuleInstance(row, moduleData), Tasks: approval?.Tasks || [], detailLoading: false }
    if (row.moduleType === 'product_application') await initializeProductApplicationEditor(moduleData)
    if (['purchase', 'purchase_request'].includes(row.moduleType) && purchaseItemsNeedingCategory.value.length) loadApprovalProductCategories()
  } catch (error) {
    if (serial !== detailRequestSerial) return
    currentInstance.value = { ...currentInstance.value, detailLoading: false }
    console.warn('加载审批发起详情失败:', error)
  }
}
function flattenApprovalProductCategories(nodes = [], parentPath = []) {
  const options = []
  for (const node of nodes || []) {
    if (!node) continue
    const categoryId = node.category_id || node.categoryId || node.id || ''
    const name = node.name || ''
    const children = (node.children || []).filter(child => Number(child.status ?? 1) === 1)
    const path = [...parentPath, name].filter(Boolean)
    if (categoryId && Number(node.level) === 4 && children.length === 0) {
      options.push({ categoryId, displayName: path.join('/') })
    }
    options.push(...flattenApprovalProductCategories(children, path))
  }
  return options
}
async function loadApprovalProductCategories() {
  if (approvalProductCategoryOptions.value.length) return
  try {
    const response = await api.getCategoryTree()
    const data = responseData(response)
    approvalProductCategoryOptions.value = flattenApprovalProductCategories(data)
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '商品类别加载失败')
  }
}
const productApplicationStandardFields = {
  category: ['category'], brand: ['brand'], series: ['series'], model: ['model'],
  processor: ['processor', 'cpu'], memory: ['memory', 'mem'], storage: ['storage', 'harddisk'],
  color: ['color'], gpu: ['gpu'], accessory_type: ['accessory_type']
}
function productApplicationStandardFieldKey(fieldKey) {
  const normalized = String(fieldKey || '').trim().toLowerCase()
  return Object.entries(productApplicationStandardFields).find(([, aliases]) => aliases.includes(normalized))?.[0] || ''
}
function findProductCategoryPath(nodes, targetId, path = []) {
  for (const node of nodes || []) {
    const nodeId = node.category_id || node.categoryId || node.id
    const nextPath = [...path, nodeId]
    if (String(nodeId) === String(targetId)) return nextPath
    const found = findProductCategoryPath(node.children, targetId, nextPath)
    if (found) return found
  }
  return []
}
async function loadProductApplicationCategoryFields(categoryId) {
  productApplicationCategoryFields.value = []
  if (!categoryId) return
  try {
    const response = responseData(await api.getCategoryFieldConfig(categoryId))
    productApplicationCategoryFields.value = response?.fields || []
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '商品分类字段加载失败')
  }
}
async function initializeProductApplicationEditor(data = {}) {
  let payload = data
  if (typeof data.payload_json === 'string') {
    try { payload = { ...JSON.parse(data.payload_json), ...data } } catch (error) { payload = data }
  }
  if (!productApplicationCategoryTree.value.length) {
    const response = responseData(await api.getCategoryTree())
    productApplicationCategoryTree.value = Array.isArray(response) ? response : response?.rows || []
  }
  const categoryId = payload.categoryId || payload.category_id || ''
  productApplicationEdit.value = {
    ...payload,
    name: payload.name || payload.product_name || '',
    categoryId,
    categoryPath: findProductCategoryPath(productApplicationCategoryTree.value, categoryId),
    pnCode: payload.pnCode || payload.manufacturerCode || payload.manufacturer_code || payload.pns?.find(item => item.isPrimary || Number(item.isPrimary) === 1)?.pnCode || '',
    needSn: Number(payload.needSn ?? payload.need_sn ?? 0),
    needImei: Number(payload.needImei ?? payload.need_imei ?? 0),
    unit: payload.unit || '台',
    attributes: payload.attributes && typeof payload.attributes === 'object' ? { ...payload.attributes } : {}
  }
  await loadProductApplicationCategoryFields(categoryId)
}
async function onProductApplicationCategoryChange(path = []) {
  const selectedPath = Array.isArray(path) ? path : []
  const categoryId = selectedPath[selectedPath.length - 1] || ''
  if (!productApplicationEdit.value) return
  productApplicationEdit.value.categoryPath = selectedPath
  productApplicationEdit.value.categoryId = categoryId
  await loadProductApplicationCategoryFields(categoryId)
}
function productApplicationFieldValue(field) {
  const standardKey = productApplicationStandardFieldKey(field.field_key)
  return standardKey ? productApplicationEdit.value?.[standardKey] || '' : productApplicationEdit.value?.attributes?.[field.field_key] || ''
}
function setProductApplicationField(field, value) {
  if (!productApplicationEdit.value) return
  const standardKey = productApplicationStandardFieldKey(field.field_key)
  if (standardKey) productApplicationEdit.value[standardKey] = value
  else productApplicationEdit.value.attributes[field.field_key] = value
}
function buildEditedProductApplicationPayload() {
  const payload = { ...productApplicationEdit.value, attributes: { ...(productApplicationEdit.value?.attributes || {}) } }
  delete payload.categoryPath
  const pnCode = String(payload.pnCode || '').trim()
  payload.pnCode = pnCode
  payload.manufacturerCode = pnCode
  const pns = Array.isArray(payload.pns) ? payload.pns.map(item => ({ ...item })) : []
  const primary = pns.find(item => item.isPrimary || Number(item.isPrimary) === 1)
  if (primary) primary.pnCode = pnCode
  else if (pnCode) pns.push({ pnCode, isPrimary: true })
  payload.pns = pns
  return payload
}
function validateProductApplicationEditor() {
  if (!productApplicationEdit.value || productApplicationEdit.value.categoryPath?.length !== 4 || !productApplicationEdit.value.categoryId) {
    ElMessage.warning('请为商品选择完整的 1-4 级分类')
    return false
  }
  if (!String(productApplicationEdit.value.name || '').trim() || !String(productApplicationEdit.value.pnCode || '').trim()) {
    ElMessage.warning('商品名称和 PN / 厂商编码不能为空')
    return false
  }
  const missingField = productApplicationCategoryFields.value.find(field => Number(field.required) === 1 && !String(productApplicationFieldValue(field) ?? '').trim())
  if (missingField) {
    ElMessage.warning(`请填写${missingField.field_label}`)
    return false
  }
  return true
}
async function openSales(row) {
  const serial = ++detailRequestSerial
  detailReviewRow.value = { isSalesApproval: true, salesRow: row }
  currentInstance.value = {
    title: `销售订单 ${row.order_no || '-'}`,
    instance_no: row.order_no || '-', business_type: 'sales_negative_gross_profit', create_time: row.create_time || '-',
    applicant_name: row.salesperson_name || row.salesperson || row.create_user || '', moduleData: row, Tasks: [], detailLoading: true
  }
  detailVisible.value = true
  try {
    const order = responseData(await api.getSalesDetail(row.order_id)) || row
    if (serial === detailRequestSerial) currentInstance.value = { ...currentInstance.value, moduleData: row, originalData: order, originalTitle: '销售订单', detailLoading: false }
  } catch (error) {
    if (serial === detailRequestSerial) currentInstance.value = { ...currentInstance.value, detailLoading: false }
  }
}
function canViewOriginal(instance) {
  return Boolean(instance?.business_type === 'payable_settlement' || instance?.business_type === 'sales_negative_gross_profit')
}
async function openOriginalDocument() {
  if (!currentInstance.value || currentInstance.value.originalData) return
  try {
    if (currentInstance.value.business_type === 'payable_settlement') {
      const id = currentInstance.value.business_id || currentInstance.value.payload?.settlement_id
      currentInstance.value = { ...currentInstance.value, originalData: responseData(await api.getSettlementDetail(id)), originalTitle: '应付结算单及关联采购单' }
    }
  } catch (error) { ElMessage.error(error.response?.data?.message || '加载原始单据失败') }
}
async function openSettlementPurchase(requestId) {
  try {
    const document = responseData(await api.getPurchaseRequestDetail(requestId))
    currentInstance.value = { ...currentInstance.value, linkedDocument: document || null }
  } catch (error) { ElMessage.error(error.response?.data?.message || '加载关联采购单失败') }
}
async function openOriginalFromRow(row) {
  if (row.isSalesApproval) return openSales(row.salesRow)
  if (row.isModuleApproval) return openModule(row)
  await openInstance(row.instance_id, row)
  await openOriginalDocument()
}
async function reviewFromDetail(action) {
  const row = detailReviewRow.value
  if (!row) return
  if (action === 'approve' && row.moduleType === 'product_application' && !validateProductApplicationEditor()) return
  if (row.isSalesApproval) await reviewSales(row.salesRow, action)
  else if (row.isModuleApproval) await reviewModule(row, action)
  else await review(row, action)
  detailVisible.value = false
}
async function reviewSales(row, action) {
  const stage = salesApprovalStage(row)
  let comment = ''
  if (action === 'reject') {
    const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝负毛利审批', { inputType: 'textarea' }).catch(() => null)
    if (!result) return
    comment = result.value
  } else if (!(await ElMessageBox.confirm(
    stage === 'store' ? '确认通过店长初审？通过后将进入经销商总权限复审。' : '确认通过经销商总权限复审？通过后订单将自动归档。',
    '审批确认',
    { type: 'warning' }
  ).catch(() => false))) return
  try {
    if (action === 'approve') await api.approveOrder(row.order_id)
    else await api.rejectOrder(row.order_id, { reason: comment })
    ElMessage.success(action === 'approve'
      ? (stage === 'store' ? '店长初审通过，已进入经销商总权限复审' : '经销商总权限复审通过，订单已自动归档')
      : `${stage === 'store' ? '店长初审' : '经销商总权限复审'}已拒绝，订单已退回未归档`)
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '销售审批处理失败')
  }
}
async function reviewModule(row, action) {
  if (row.manualPath) { await router.push(row.manualPath); return }
  const isPurchaseRequest = ['purchase', 'purchase_request'].includes(row.moduleType)
  let rebateAmount = null
  if (action === 'approve' && row.moduleType === 'manufacturer_rebate_confirmation') {
    const result = await ElMessageBox.prompt('请填写该 SN 实际应得的厂商返利金额；不符合返利条件请填写 0。', '确认厂商返利金额', {
      inputType: 'number',
      inputValue: '',
      inputPattern: /^\d+(?:\.\d{1,2})?$/,
      inputErrorMessage: '请输入大于或等于 0、最多两位小数的金额',
      confirmButtonText: '提交金额并审批',
      cancelButtonText: '取消'
    }).catch(() => null)
    if (!result) return
    rebateAmount = Number(result.value)
  }
  const purchaseCategoryRows = isPurchaseRequest ? purchaseItemsNeedingCategory.value : []
  if (action === 'approve' && purchaseCategoryRows.some(item => !item.approvalCategoryId)) {
    ElMessage.warning('请先为每个新建商品选择四级商品类别')
    return
  }
  let editedProductPayload = null
  if (action === 'approve' && row.moduleType === 'product_application') {
    if (!validateProductApplicationEditor()) return
    editedProductPayload = buildEditedProductApplicationPayload()
  }
  let comment = ''
  if (action === 'reject') {
    const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝审批', { inputType: 'textarea' }).catch(() => null)
    if (!result) return
    comment = result.value
  } else if (!(await ElMessageBox.confirm('确认通过该审批？', '审批确认', { type: 'warning' }).catch(() => false))) return

  const moduleRow = row.moduleRow || {}
  const approved = action === 'approve' ? 'approved' : 'rejected'
  const id = row.Instance?.business_id
  const newProductCategories = action === 'approve'
    ? purchaseCategoryRows.map(item => ({ itemId: item.item_id || item.itemId, categoryId: item.approvalCategoryId }))
    : []
  try {
    if (row.managedBusiness) {
      const result = await api.actionBusinessApproval(row.moduleType, id, { action, comment, businessData: { newProductCategories, ...(editedProductPayload ? { payload: editedProductPayload } : {}), ...(rebateAmount !== null ? { rebateAmount } : {}) } })
      ElMessage.success(result.message || '审批已记录')
      await reload()
      return
    }
    if (isPurchaseRequest && !row.managedBusiness) await api.approvePurchaseRequest(id, { status: approved, comment, newProductCategories })
    else if (row.moduleType === 'expense') await api.reviewExpense(id, { action: approved, comment })
    else if (row.moduleType === 'product') await api.reviewProductApplication(id, { action: approved, comment })
    else if (row.moduleType === 'return') await api.approveReturn({ returnId: id, storeId: moduleRow.store_id || moduleRow.storeId || '', action: approved, comment })
    else if (row.moduleType === 'sales_return') await api.reviewSalesReturn(id, {
      action: approved,
      comment,
      postToDailyStatement: action === 'approve',
      post_to_daily_statement: action === 'approve',
      createNegativeDailyStatement: action === 'approve',
      create_negative_daily_statement: action === 'approve',
      reviewerRole: userInfo.roleCode || '',
      reviewerId: userInfo.staffId || userInfo.userId || ''
    })
    else if (row.moduleType === 'deposit_refund') await api.reviewDepositRefund(id, { action: approved, comment })
    else if (row.moduleType === 'resource') await api.reviewResourceClaim(id, { action: action === 'approve' ? 'approve' : 'reject', comment })
    else if (row.moduleType === 'profit') {
      if (action === 'approve') await api.approveProfitAdjustment(id, { comment })
      else await api.rejectProfitAdjustment(id, { comment })
    } else throw new Error('不支持的审批类型')
    ElMessage.success(action === 'approve' ? '审批通过' : '审批已拒绝')
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '审批处理失败')
  }
}
async function review(row, action) {
  let comment = ''
  if (action === 'reject') { const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝审批', { inputType: 'textarea' }).catch(() => null); if (!result) return; comment = result.value }
  else if (!(await ElMessageBox.confirm('确认通过该审批？', '审批确认', { type: 'warning' }).catch(() => false))) return
  try {
    await api.actionApproval(row.instance_id, { action, comment })
    ElMessage.success('审批处理完成')
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '审批处理失败')
  }
}
async function resubmit(row) { const result = await ElMessageBox.prompt('可填写重新提交说明', '重新提交', { inputType: 'textarea' }).catch(() => null); if (result === null) return; await api.resubmitApproval(row.instance_id, { comment: result.value }); ElMessage.success('已重新提交'); await reload() }
function newFlow() { Object.assign(flowForm, { definitionId: '', flowCode: '', name: '', businessType: '', nodes: [newNode()] }); flowDialogVisible.value = true }
function editFlow(row) { Object.assign(flowForm, { definitionId: row.definition_id, flowCode: row.flow_code, name: row.name, businessType: row.business_type, nodes: JSON.parse(JSON.stringify(row.config.nodes || [])) }); flowDialogVisible.value = true }
function addNode() { flowForm.nodes.push(newNode()) }
function removeNode(index) { flowForm.nodes.splice(index, 1) }
function clearRule(rule) { rule.staffId = ''; rule.roleCode = '' }
async function saveFlow() { const editing = Boolean(flowForm.definitionId); const data = { flowCode: flowForm.flowCode, name: flowForm.name, businessType: flowForm.businessType, config: { nodes: flowForm.nodes } }; if (editing) await api.updateApprovalFlow(flowForm.definitionId, data); else await api.createApprovalFlow(data); ElMessage.success(editing ? '流程已更新并立即生效' : '流程草稿已保存'); flowDialogVisible.value = false; await loadFlows() }
async function publish(row) { const confirmed = await ElMessageBox.confirm('发布后将作为新申请的审批规则；已发起的审批单不受影响，是否继续？', '发布流程').then(() => true).catch(() => false); if (!confirmed) return; await api.publishApprovalFlow(row.definition_id); ElMessage.success('流程已发布'); await loadFlows() }
async function enable(row) { const confirmed = await ElMessageBox.confirm('启用后将作为新申请的审批规则，是否继续？', '启用流程').then(() => true).catch(() => false); if (!confirmed) return; await api.enableApprovalFlow(row.definition_id); ElMessage.success('流程已启用'); await loadFlows() }
async function disable(row) { await api.disableApprovalFlow(row.definition_id); ElMessage.success('流程已停用'); await loadFlows() }
watch(activeTab, value => { if (value === 'flows') loadFlows(); if (value === 'handled' && !handledLoading.value) loadHandledInstances() })
watch(() => route.path, syncTabFromRoute)
onMounted(() => { syncTabFromRoute(); reload() })
</script>

<style scoped>
.module-tabs :deep(.el-tabs__header) { display: none; }
.negative-profit { color: var(--el-color-danger); font-weight: 600; }
.batch-approval-toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.detail-section { margin-top: 16px; }
.detail-section-title { margin-bottom: 8px; color: var(--el-text-color-primary); font-weight: 600; }
.raw-detail { margin-top: 16px; }
.raw-detail-content,.raw-detail pre { margin: 0; padding: 12px; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); border-radius: 4px; font: 12px/1.6 Consolas, monospace; }
.page-header,.toolbar,.node-head,.rule-row,.approval-filters{display:flex;align-items:center;gap:10px}.page-header{justify-content:space-between}.toolbar,.approval-filters{margin-bottom:12px}.approval-filters{flex-wrap:wrap}.node-card{border:1px solid var(--el-border-color);padding:12px;margin-bottom:12px;border-radius:4px}.node-head{margin-bottom:10px}.node-head .el-input{max-width:360px}.rule-row{margin:8px 0;flex-wrap:wrap}
</style>
