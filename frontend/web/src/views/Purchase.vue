<template>
  <div class="purchase-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>采购管理</span>
        </div>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs">
        <el-tab-pane label="采购申请" name="request">
          <div class="filter-bar">
            <el-input v-model="queryParams.submitter" placeholder="提交人" clearable style="width: 140px" />
            <el-input v-model="queryParams.keyword" placeholder="商品名称/PN/商品编码" clearable style="width: 230px" />
            <el-select v-model="queryParams.supplierId" placeholder="供应商" clearable filterable style="width: 180px">
              <el-option v-for="supplier in allSuppliers" :key="supplier.supplier_id" :label="supplier.name" :value="supplier.supplier_id" />
            </el-select>
            <el-select v-model="queryParams.status" placeholder="状态" clearable style="width: 150px" @change="handleRequestFilterChange">
              <el-option label="全部" value="" />
              <el-option label="草稿" value="draft" />
              <el-option label="待审批" value="pending" />
              <el-option label="已通过" value="approved" />
              <el-option label="已拒绝" value="rejected" />
            </el-select>
            <el-select v-model="queryParams.operatorStaffId" placeholder="经手人" clearable filterable style="width: 150px" @change="handleRequestFilterChange">
              <el-option label="全部经手人" value="" />
              <el-option v-for="staff in operatorStaffList" :key="staff.staffId" :label="staff.name" :value="staff.staffId" />
            </el-select>
            <el-button type="primary" @click="handleRequestSearch">查询</el-button>
            <el-button @click="resetRequestSearch">重置</el-button>
            <el-button type="primary" @click="handleCreate">新建采购申请</el-button>
          </div>
          <el-table :data="tableData" stripe border>
            <el-table-column prop="request_no" label="申请单号" width="180" />
            <el-table-column prop="create_time" label="申请时间" width="160">
              <template #default="{ row }">
                {{ row.create_time ? formatDate(row.create_time) : '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="store_name" label="申请门店" width="120" />
            <el-table-column label="提交人" width="110">
              <template #default="{ row }">
                {{ row.submitter_name || row.apply_user || row.create_user || row.operator_name || '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="approve_user" label="审批人" width="110" />
            <el-table-column prop="supplier_name" label="供应商" width="150" />
            <el-table-column label="付款方式" width="110">
              <template #default="{ row }">{{ getPaymentMethodText(row.payment_method) }}</template>
            </el-table-column>
            <el-table-column prop="invoice_type" label="发票类型" width="100" />
            <el-table-column prop="product_type" label="货型" width="130" />
            <el-table-column prop="items_summary" label="商品摘要" min-width="200" show-overflow-tooltip />
            <el-table-column prop="total_amount" label="申请金额" width="120">
              <template #default="{ row }">¥{{ formatMoney(row.current_total_amount ?? row.total_amount) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="250">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditDraft(row)" v-if="row.status === 'draft'">编辑</el-button>
                <el-button link type="success" @click="handleSubmitDraft(row)" v-if="row.status === 'draft'">提交</el-button>
                <el-button link type="danger" @click="handleDeleteDraft(row)" v-if="row.status === 'draft' && !row.submit_time">删除</el-button>
                <el-button link type="primary" @click="handleApprove(row)" v-if="row.status === 'pending'">审批</el-button>
                <el-button link type="warning" @click="handleRevoke(row)" v-if="row.status === 'approved'">撤销</el-button>
                <el-button link type="danger" @click="handleAdjustment(row)" v-if="row.status === 'approved'">退单</el-button>
                <el-button link type="primary" @click="handleView(row)">查看</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="queryParams.page"
            v-model:page-size="queryParams.pageSize"
            :total="total"
            layout="total, sizes, prev, pager, next"
            @size-change="loadData"
            @current-change="loadData"
          />
        </el-tab-pane>

        <el-tab-pane label="供应商管理" name="supplier">
          <div class="filter-bar">
            <el-input v-model="supplierQuery.keyword" placeholder="搜索供应商名称/联系人" clearable style="width: 250px" />
            <el-button type="primary" @click="loadSuppliers">搜索</el-button>
            <el-button type="primary" @click="handleAddSupplier">新增供应商</el-button>
          </div>
          <el-table :data="supplierData" stripe border>
            <el-table-column prop="supplier_id" label="供应商编号" width="150" />
            <el-table-column prop="name" label="供应商名称" min-width="150" />
            <el-table-column label="服务商" width="90">
              <template #default="{ row }">
                <el-tag :type="row.is_service_provider ? 'success' : 'warning'">
                  {{ row.is_service_provider ? '是' : '否' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="毛利上浮/件" width="120" align="right">
              <template #default="{ row }">
                {{ row.is_service_provider ? '-' : `¥${Number(row.gross_profit_uplift_amount || 0).toFixed(2)}` }}
              </template>
            </el-table-column>
            <el-table-column prop="contact" label="联系人" width="100" />
            <el-table-column prop="phone" label="联系电话" width="130" />
            <el-table-column prop="address" label="地址" min-width="200" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="260">
              <template #default="{ row, $index }">
                <el-button link type="primary" :disabled="$index === 0" @click="moveSupplier($index, -1)">上移</el-button>
                <el-button link type="primary" :disabled="$index === supplierData.length - 1" @click="moveSupplier($index, 1)">下移</el-button>
                <el-button link type="primary" @click="handleEditSupplier(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteSupplier(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="supplierQuery.page"
            v-model:page-size="supplierQuery.pageSize"
            :total="supplierTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSuppliers"
            @current-change="loadSuppliers"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新建采购申请对话框 -->
    <el-dialog v-model="requestDialogVisible" :title="editingRequestId ? '编辑采购申请草稿' : '新建采购申请'" width="min(1100px, 94vw)" class="purchase-request-dialog" @close="handleDialogClose">
      <el-form :model="requestForm" label-width="100px" class="purchase-request-form">
        <el-form-item label="供应商" required>
          <el-select
            v-model="requestForm.supplierId"
            placeholder="请输入供应商关键字"
            style="width: 100%"
            filterable
            remote
            clearable
            :remote-method="searchRequestSuppliers"
            @visible-change="onRequestSupplierVisibleChange"
            @change="onSupplierChange"
          >
            <el-option v-for="s in allSuppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发票类型">
          <el-select v-model="requestForm.invoiceType" placeholder="请选择发票类型" style="width: 100%">
            <el-option label="未税（收据或普票）" value="未税（收据或普票）" />
            <el-option label="增专票（13%）" value="增专票（13%）" />
          </el-select>
        </el-form-item>
        <el-form-item label="付款方式" required>
          <el-select v-model="requestForm.paymentMethod" placeholder="请选择付款方式" style="width: 100%">
            <el-option label="公司账期" value="COMPANY_CREDIT" />
            <el-option label="个人垫付" value="PERSONAL_ADVANCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="货型" required>
          <el-select v-model="requestForm.productType" placeholder="请选择货型" style="width: 100%" @change="onGoodsTypeChange">
            <el-option v-for="item in goodsTypeOptions" :key="item.goods_type_id" :label="item.name" :value="item.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="requestForm.remark" type="textarea" rows="2" placeholder="采购备注" />
        </el-form-item>

        <el-form-item label="返利抵扣" v-if="requestForm.supplierId && rebateBalance > 0">
          <div style="width: 100%">
            <div style="margin-bottom: 6px; font-size: 13px; color: #909399;">
              供应商返利余额：¥{{ rebateBalance.toFixed(2) }}
            </div>
            <el-input v-model="requestForm.rebateDeduction" placeholder="0" style="width: 240px" @change="onTotalRebateChange" />
            <el-button link type="primary" @click="allocateTotalRebateToItems">平摊到商品</el-button>
          </div>
        </el-form-item>

        <el-form-item label="商品明细" class="items-form-item">
          <div class="purchase-items-panel">
            <el-table :data="requestForm.items" border class="request-items-table">
              <el-table-column label="商品名称" min-width="230">
                <template #default="{ row, $index }">
                  <el-tag v-if="row.isUsedProduct" type="warning" size="small">二手商品</el-tag>
                  <span v-if="row.isUsedProduct" class="used-product-name">{{ row.productName || '-' }}</span>
                  <el-select v-else
                    v-model="row.productId"
                    placeholder="搜索商品"
                    filterable
                    remote
                    :remote-method="searchProducts"
                    @change="onProductChange($index)"
                    style="width: 100%;"
                    size="small"
                  >
                    <el-option v-for="p in products" :key="p.product_id" :label="`${p.name} (${p.product_code})`" :value="p.product_id">
                      <div class="product-option">
                        <span>{{ p.name }}</span>
                        <span class="product-option-meta">编码：{{ p.product_code }} | 厂商：{{ p.manufacturer_code || '-' }}</span>
                      </div>
                    </el-option>
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="商品编码" width="140">
                <template #default="{ row }">{{ row.productCode || getProductCode(row) || '-' }}</template>
              </el-table-column>
              <el-table-column label="厂商编码" width="150">
                <template #default="{ row }">{{ row.manufacturerCode || getManufacturerCode(row) || '-' }}</template>
              </el-table-column>
              <el-table-column label="单价（¥）" width="135">
                <template #default="{ row }">
                  <el-input v-model="row.price" type="number" min="0" placeholder="0.00" size="small" class="no-spinner" />
                </template>
              </el-table-column>
              <el-table-column label="数量" width="100">
                <template #default="{ row }">
                  <el-input v-model="row.quantity" type="number" min="1" placeholder="1" size="small" class="no-spinner" />
                </template>
              </el-table-column>
              <el-table-column label="总价（¥）" width="125" align="right">
                <template #default="{ row }"><span class="item-total">¥{{ itemSubtotal(row).toFixed(2) }}</span></template>
              </el-table-column>
              <el-table-column label="操作" width="80" align="center">
                <template #default="{ $index }">
                  <el-button link type="danger" size="small" @click="removeRequestItem($index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>

            <div class="purchase-items-footer">
              <el-button link type="warning" class="add-product-button" @click="openUsedProductDialog">二手商品</el-button>
              <el-button link type="primary" class="add-product-button" @click="addRequestItem">＋ 添加商品</el-button>
              <div class="purchase-items-total">商品合计：<span>¥{{ totalAmount.toFixed(2) }}</span></div>
            </div>

            <div v-for="(item, idx) in requestForm.items" :key="`allocation-${idx}`" class="purchase-allocation-row">
              <span class="purchase-subsection-label">收货门店分配（可多选）<span v-if="requestForm.items.length > 1">（{{ item.productName || `商品${idx + 1}` }}）</span>：</span>
              <div class="purchase-allocation-content">
                <template v-if="item.storeAllocations && item.storeAllocations.length > 0">
                  <span v-for="(alloc, allocIdx) in item.storeAllocations" :key="allocIdx" class="allocation-tag">
                    {{ alloc.storeName || alloc.storeId }} × {{ alloc.quantity }}
                  </span>
                </template>
                <span v-else class="allocation-empty">未分配</span>
              </div>
              <el-button type="primary" size="small" @click="handleAllocateStore(item, idx)">分配</el-button>
            </div>

            <div v-for="(item, idx) in requestForm.items" :key="`resource-${idx}`" class="purchase-resource-row">
              <span class="purchase-subsection-label">资源权益<span v-if="requestForm.items.length > 1">（{{ item.productName || `商品${idx + 1}` }}）</span></span>
              <el-select
                v-model="item.selectedResourceTypes"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                size="small"
                placeholder="选择本批货权益"
                class="resource-select"
              >
                <el-option v-for="option in resourceOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </div>

            <div v-if="requestForm.supplierId && rebateBalance > 0" class="purchase-rebate-section">
              <div class="purchase-rebate-header">供应商返利余额：¥{{ rebateBalance.toFixed(2) }}</div>
              <div v-for="(item, idx) in requestForm.items" :key="`rebate-${idx}`" class="item-rebate-row">
                <span>{{ item.productName || `商品${idx + 1}` }}返利抵扣</span>
                <el-input v-model="item.rebateDeduction" type="number" placeholder="0" size="small" class="no-spinner" @change="onItemRebateChange" />
                <span>抵扣后：¥{{ Math.max(0, itemSubtotal(item) - toNumber(item.rebateDeduction)).toFixed(2) }}</span>
              </div>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="配送平台">
          <el-select v-model="requestForm.freightPlatformId" clearable placeholder="请选择配送平台" style="width: 100%">
            <el-option v-for="platform in freightPlatforms" :key="platform.platform_id" :label="platform.platform_name" :value="platform.platform_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="运费金额">
          <el-input-number v-model="requestForm.freightAmount" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
        </el-form-item>

        <div class="order-summary">
          <div class="summary-item total">申请金额: <span>¥{{ totalAmount.toFixed(2) }}</span></div>
          <div v-if="rebateDeductionAmount > 0" class="summary-item deduction" style="color: #67c23a;">
            返利抵扣: <span>-¥{{ rebateDeductionAmount.toFixed(2) }}</span>
          </div>
          <div v-if="rebateDeductionAmount > 0" class="summary-item actual">
            实际应付: <span style="color: #f56c6c; font-weight: 700;">¥{{ actualTotal.toFixed(2) }}</span>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="requestDialogVisible = false">取消</el-button>
        <el-button type="info" @click="savePurchaseRequestDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- 查看采购申请对话框 -->
    <el-dialog v-model="viewDialogVisible" title="采购申请详情" width="860px">
      <div v-if="currentRequest">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="申请单号">{{ currentRequest.request_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(currentRequest.status)">{{ getStatusText(currentRequest.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="供应商">{{ currentRequest.supplier_name }}</el-descriptions-item>
          <el-descriptions-item label="付款方式">{{ getPaymentMethodText(currentRequest.payment_method) }}</el-descriptions-item>
          <el-descriptions-item label="发票类型">{{ currentRequest.invoice_type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="货型">{{ currentRequest.product_type || currentRequest.items?.[0]?.product_type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请门店">{{ currentRequest.store_name }}</el-descriptions-item>
          <el-descriptions-item label="申请金额">¥{{ formatMoney(currentRequest.current_total_amount ?? currentRequest.total_amount) }}</el-descriptions-item>
          <el-descriptions-item label="是否使用返利">
            <el-tag :type="hasRebateDeduction(currentRequest) ? 'success' : 'info'">
              {{ hasRebateDeduction(currentRequest) ? '是' : '否' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="返利抵扣">-¥{{ formatMoney(currentRequest.current_rebate_deduction ?? currentRequest.rebate_deduction) }}</el-descriptions-item>
          <el-descriptions-item label="实际应付">¥{{ formatMoney(requestActualAmount(currentRequest)) }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ formatDate(currentRequest.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="提交人">{{ currentRequest.submit_user || currentRequest.apply_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatDate(currentRequest.submit_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批人">{{ currentRequest.approve_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="审批时间">{{ formatDate(currentRequest.approve_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批意见" :span="2">{{ currentRequest.approve_comment || '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentRequest.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">流程记录</h4>
        <el-timeline v-if="currentRequest.action_logs?.length">
          <el-timeline-item v-for="log in currentRequest.action_logs" :key="log.log_id" :timestamp="formatDate(log.create_time)">
            <strong>{{ actionLabel(log.action) }}</strong>
            <span style="margin-left: 10px; color: #606266">{{ log.actor_name || '-' }}</span>
            <span v-if="log.comment" style="margin-left: 10px; color: #909399">{{ log.comment }}</span>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无流程记录" :image-size="60" />

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentRequest.items || []" border size="small">
          <el-table-column prop="product_name" label="商品名称" min-width="150" />
          <el-table-column prop="unit_price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.unit_price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column label="小计" width="100">
            <template #default="{ row }">¥{{ formatMoney(requestItemSubtotal(row)) }}</template>
          </el-table-column>
          <el-table-column label="返利抵扣" width="110">
            <template #default="{ row }">-¥{{ formatMoney(row.rebate_deduction) }}</template>
          </el-table-column>
          <el-table-column label="抵扣后金额" width="120">
            <template #default="{ row }">¥{{ formatMoney(requestItemActualAmount(row)) }}</template>
          </el-table-column>
          <el-table-column label="门店分配" min-width="200">
            <template #default="{ row }">
              <div v-if="row.store_allocations_parsed && row.store_allocations_parsed.length > 0">
                <div v-for="(alloc, idx) in row.store_allocations_parsed" :key="idx" style="font-size: 12px;">
                  <span>{{ alloc.storeName }}: {{ alloc.quantity }}</span>
                </div>
              </div>
              <span v-else style="color: #909399; font-size: 12px;">未分配</span>
            </template>
          </el-table-column>
        </el-table>

        <template v-if="currentRequest.adjustments && currentRequest.adjustments.length > 0">
          <h4 class="mt-20">采购退单 / 数量调整记录</h4>
          <el-table :data="currentRequest.adjustments" border size="small">
            <el-table-column prop="adjustment_no" label="调整单号" width="180" />
            <el-table-column prop="total_quantity_delta" label="数量变化" width="100" align="right" />
            <el-table-column prop="total_amount_delta" label="应付变化" width="120" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.total_amount_delta) }}</template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="180" show-overflow-tooltip />
            <el-table-column prop="create_user" label="操作人" width="110" />
            <el-table-column prop="create_time" label="操作时间" width="160">
              <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-dialog>

    <!-- 撤销对话框 -->
    <el-dialog v-model="usedProductDialogVisible" title="新建二手商品" width="560px" @close="resetUsedProductForm">
      <el-form :model="usedProductForm" label-width="150px">
        <el-form-item label="商品名称" required>
          <el-input v-model="usedProductForm.name" placeholder="请输入二手商品名称" />
        </el-form-item>
        <el-form-item label="PN码">
          <el-input v-model="usedProductForm.pnCode" placeholder="可选，填写厂商编码" />
        </el-form-item>
        <el-form-item label="采购单价" required>
          <el-input-number v-model="usedProductForm.price" :min="0" :precision="2" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="数量" required>
          <el-input-number v-model="usedProductForm.quantity" :min="1" :precision="0" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="审批完成及入库">
          <el-switch v-model="usedProductForm.directInbound" />
          <span class="ml-10">勾选后审批通过将自动入库</span>
        </el-form-item>
        <el-form-item v-if="usedProductForm.directInbound" label="SN号" required>
          <el-input v-model="usedProductForm.snCode" placeholder="请输入唯一SN号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="usedProductDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveUsedProduct">加入采购明细</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="revokeDialogVisible" title="撤销采购申请" width="500px">
      <el-form :model="revokeForm" label-width="100px">
        <el-form-item label="撤销备注">
          <el-input v-model="revokeForm.comment" type="textarea" rows="3" placeholder="请输入撤销备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revokeDialogVisible = false">取消</el-button>
        <el-button type="warning" @click="handleRevokeSubmit" :loading="revokeLoading">确定撤销</el-button>
      </template>
    </el-dialog>

    <!-- 采购退单/数量调整对话框 -->
    <el-dialog v-model="adjustmentDialogVisible" title="采购退单 / 数量调整" width="1100px" @close="resetAdjustmentForm">
      <div v-if="adjustmentRequest" class="adjustment-summary">
        <el-alert
          title="输入本次退库数量即可。未入库商品会取消待入库数量；已入库商品会同步扣减库存。SN商品必须选择对应的在库SN。原采购单、入库单和付款记录保留历史，系统新增负向应付款调整。"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-descriptions :column="3" border size="small" style="margin-top: 12px;">
          <el-descriptions-item label="采购单号">{{ adjustmentRequest.request_no }}</el-descriptions-item>
          <el-descriptions-item label="供应商">{{ adjustmentRequest.supplier_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="付款方式">{{ getPaymentMethodText(adjustmentRequest.payment_method) }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <el-table :data="adjustmentRows" stripe border size="small" style="margin-top: 16px;">
        <el-table-column prop="product_name" label="商品" min-width="180" show-overflow-tooltip />
        <el-table-column prop="store_name" label="门店" width="120" />
        <el-table-column prop="inbound_no" label="入库单" width="170" />
        <el-table-column prop="unit_price" label="采购单价" width="105" align="right">
          <template #default="{ row }">¥{{ formatMoney(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column prop="original_quantity" label="原采购数量" width="105" align="right" />
        <el-table-column prop="received_quantity" label="已入库数量" width="105" align="right" />
        <el-table-column label="处理类型" width="110">
          <template #default="{ row }">{{ row.operation_type === 'stock_return' ? '已入库退库' : '取消待入库' }}</template>
        </el-table-column>
        <el-table-column label="可处理数量" width="105" align="right">
          <template #default="{ row }">{{ row.max_return_quantity }}</template>
        </el-table-column>
        <el-table-column label="本次退库数量" width="155" align="right">
          <template #default="{ row }">
            <el-input-number
              v-if="row.editable"
              v-model="row.return_quantity"
              :min="0"
              :max="row.max_return_quantity"
              :precision="0"
              :step="1"
              controls-position="right"
              size="small"
              style="width: 130px"
            />
          </template>
        </el-table-column>
        <el-table-column label="选择SN" min-width="210" v-if="adjustmentRows.some(row => row.need_sn && row.operation_type === 'stock_return')">
          <template #default="{ row }">
            <el-select
              v-if="row.need_sn && row.operation_type === 'stock_return'"
              v-model="row.sn_ids"
              multiple
              collapse-tags
              filterable
              placeholder="请选择SN"
              size="small"
              style="width: 195px"
            >
              <el-option v-for="sn in row.sn_options" :key="sn.sn_id" :label="sn.sn_code" :value="sn.sn_id" />
            </el-select>
            <span v-else style="color: #909399;">无需选择</span>
          </template>
        </el-table-column>
        <el-table-column label="应付调整" width="120" align="right">
          <template #default="{ row }">
            <span :style="{ color: adjustmentRowAmount(row) < 0 ? '#F56C6C' : adjustmentRowAmount(row) > 0 ? '#67C23A' : '#909399' }">
              {{ adjustmentRowAmount(row) > 0 ? '+' : '' }}¥{{ adjustmentRowAmount(row).toFixed(2) }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <el-form label-width="90px" style="margin-top: 16px;">
        <el-form-item label="调整原因">
          <el-input v-model="adjustmentReason" type="textarea" rows="2" maxlength="512" show-word-limit placeholder="请输入退单或数量调整原因" />
        </el-form-item>
      </el-form>
      <div style="text-align: right; color: #606266;">
        数量变化：<strong>{{ adjustmentTotalQuantityDelta }}</strong>，应付变化：
        <strong :style="{ color: adjustmentTotalAmountDelta < 0 ? '#F56C6C' : '#67C23A' }">
          {{ adjustmentTotalAmountDelta > 0 ? '+' : '' }}¥{{ adjustmentTotalAmountDelta.toFixed(2) }}
        </strong>
      </div>
      <template #footer>
        <el-button @click="adjustmentDialogVisible = false">取消</el-button>
        <el-button type="danger" @click="handleAdjustmentSubmit" :loading="adjustmentLoading" :disabled="!hasAdjustmentChanges">确认退单</el-button>
      </template>
    </el-dialog>

    <!-- 审批对话框 -->
    <el-dialog v-model="approveDialogVisible" title="审批采购申请" width="500px">
      <el-form :model="approveForm" label-width="100px">
        <el-form-item label="审批结果">
          <el-radio-group v-model="approveForm.action">
            <el-radio value="approved">通过</el-radio>
            <el-radio value="rejected">拒绝</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="审批备注">
          <el-input v-model="approveForm.comment" type="textarea" rows="3" placeholder="审批备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleApproveSubmit" :loading="approveLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 门店分配对话框 -->
    <el-dialog v-model="allocateDialogVisible" title="分配门店" width="700px" @close="handleAllocateDialogClose">
      <div style="margin-bottom: 16px;">
        <span style="font-weight: bold;">商品：{{ currentAllocateProduct?.productName || '-' }}</span>
        <span style="margin-left: 24px; font-weight: bold;">总数量：{{ currentAllocateProduct?.quantity || 0 }}</span>
        <span style="margin-left: 24px; color: #409EFF; font-weight: bold;">已分配：{{ allocatedTotalQuantity }}</span>
        <span style="margin-left: 24px; color: #F56C6C; font-weight: bold;">待分配：{{ remainingAllocateQuantity }}</span>
      </div>
      <el-table :data="storeAllocationList" stripe border max-height="400">
        <el-table-column prop="storeName" label="门店名称" min-width="150" />
        <el-table-column label="分配数量" width="180">
          <template #default="{ row }">
            <el-input 
              v-model="row.quantity" 
              size="small" 
              style="width: 100%;"
              @change="validateAllocation" 
            />
          </template>
        </el-table-column>
        <el-table-column label="库位分配" min-width="300">
          <template #default="{ row }">
            <div v-if="row.quantity > 0 && row.locationAllocations?.length" class="location-summary">
              <span v-for="location in row.locationAllocations" :key="location.locationId">
                {{ location.locationName }} × {{ location.quantity }}
              </span>
            </div>
            <span v-else class="location-missing">未分配库位</span>
            <el-button link type="primary" size="small" @click="handleAllocateLocations(row)">分配库位</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="allocateDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveAllocation">确定</el-button>
      </template>
    </el-dialog>

    <!-- 门店库位分配对话框 -->
    <el-dialog v-model="locationAllocateDialogVisible" title="分配库位" width="620px" @close="handleLocationAllocateDialogClose">
      <div style="margin-bottom: 16px;">
        <span style="font-weight: bold;">门店：{{ currentLocationAllocateStore?.storeName || '-' }}</span>
        <span style="margin-left: 24px; font-weight: bold;">门店数量：{{ currentLocationAllocateStore?.quantity || 0 }}</span>
        <span style="margin-left: 24px; color: #409EFF; font-weight: bold;">已分配：{{ allocatedLocationQuantity }}</span>
        <span style="margin-left: 24px; color: #F56C6C; font-weight: bold;">待分配：{{ remainingLocationQuantity }}</span>
      </div>
      <el-table :data="locationAllocationList" stripe border max-height="360">
        <el-table-column prop="locationName" label="库位名称" min-width="220" />
        <el-table-column label="分配数量" width="180">
          <template #default="{ row }">
            <el-input v-model="row.quantity" size="small" class="no-spinner" @change="validateLocationAllocation" />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="locationAllocateDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveLocationAllocation">确定</el-button>
      </template>
    </el-dialog>

    <!-- 供应商对话框 -->
    <el-dialog v-model="supplierDialogVisible" :title="supplierDialogTitle" width="860px" @close="handleSupplierDialogClose">
      <el-form :model="supplierForm" label-width="100px">
        <el-form-item label="供应商名称" required>
          <el-input v-model="supplierForm.name" placeholder="请输入供应商名称" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="supplierForm.contact" placeholder="请输入联系人" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="supplierForm.phone" placeholder="请输入联系电话" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="supplierForm.address" placeholder="请输入地址" />
        </el-form-item>
        <el-form-item label="是否服务商">
          <el-switch v-model="supplierForm.isServiceProvider" />
          <span class="ml-10">{{ supplierForm.isServiceProvider ? '是：毛利按产品定价' : '否：采购价加上浮额度' }}</span>
        </el-form-item>
        <el-form-item v-if="!supplierForm.isServiceProvider" label="毛利上浮额度">
          <el-input-number
            v-model="supplierForm.grossProfitUpliftAmount"
            :min="0"
            :precision="2"
            :step="10"
            controls-position="right"
            style="width: 220px"
          />
          <span class="ml-10">元/件</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="supplierForm.remark" type="textarea" rows="2" placeholder="备注" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="supplierForm.status" :active-value="1" :inactive-value="0" />
          <span class="ml-10">{{ supplierForm.status === 1 ? '正常' : '停用' }}</span>
        </el-form-item>
        <el-form-item label="付款信息">
          <div class="supplier-accounts">
            <div
              v-for="(account, index) in supplierForm.paymentAccounts"
              :key="index"
              class="supplier-account-row"
            >
              <el-input v-model="account.companyName" placeholder="公司名称" />
              <el-input v-model="account.taxNo" placeholder="税号" />
              <el-input v-model="account.bankName" placeholder="开户行" />
              <el-input v-model="account.accountNumber" placeholder="账号" />
              <el-input v-model="account.remark" placeholder="备注" />
              <el-button type="danger" link @click="removeSupplierAccount(index)">删除</el-button>
            </div>
            <el-button type="primary" link @click="addSupplierAccount">添加付款账户</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="supplierDialogVisible = false">取消</el-button>
        <el-button v-if="!supplierForm.supplierId" type="info" @click="saveSupplierDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSupplierSubmit" :loading="supplierLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'

const route = useRoute()

const activeTab = ref('request')
const syncTabFromRoute = () => {
  activeTab.value = String(route.meta.tab || 'request')
}
const PURCHASE_REQUEST_DRAFT_KEY = 'purchase-request-create'
const SUPPLIER_DRAFT_KEY = 'supplier-create'
const tableData = ref([])
const supplierData = ref([])
const allSuppliers = ref([])
const operatorStaffList = ref([])
const allStores = ref([])
const allStoresLoaded = ref(false)
const products = ref([])
const resourceOptions = ref([])
const goodsTypeOptions = ref([])
const productSearchKeyword = ref('')
const supplierSearchKeyword = ref('')
const total = ref(0)
const supplierTotal = ref(0)

const requestDialogVisible = ref(false)
const usedProductDialogVisible = ref(false)
const editingRequestId = ref('')
const viewDialogVisible = ref(false)
const approveDialogVisible = ref(false)
const revokeDialogVisible = ref(false)
const adjustmentDialogVisible = ref(false)
const supplierDialogVisible = ref(false)
const allocateDialogVisible = ref(false)
const locationAllocateDialogVisible = ref(false)
const submitLoading = ref(false)
const approveLoading = ref(false)
const revokeLoading = ref(false)
const adjustmentLoading = ref(false)
const supplierLoading = ref(false)
const currentRequest = ref(null)
const adjustmentRequest = ref(null)
const adjustmentRows = ref([])
const adjustmentReason = ref('')
const supplierDialogTitle = ref('新增供应商')
const currentSupplier = ref(null)
const currentAllocateProduct = ref(null)
const currentAllocateIndex = ref(-1)
const storeAllocationList = ref([])
const locationAllocationList = ref([])
const currentLocationAllocateStore = ref(null)
const storeLocationOptions = reactive({})
const storeLocationLoading = reactive({})

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  submitter: '',
  keyword: '',
  supplierId: '',
  operatorStaffId: ''
})

const supplierQuery = reactive({
  page: 1,
  pageSize: 100,
  keyword: ''
})

const requestForm = reactive({
  supplierId: '',
  invoiceType: '',
  paymentMethod: 'COMPANY_CREDIT',
  productType: '',
  remark: '',
  rebateDeduction: 0,
  freightPlatformId: '',
  freightAmount: 0,
  items: []
})

const usedProductForm = reactive({
  name: '',
  pnCode: '',
  price: 0,
  quantity: 1,
  directInbound: false,
  snCode: ''
})

const freightPlatforms = ref([])

const rebateBalance = ref(0)

const approveForm = reactive({
  action: 'approved',
  comment: ''
})

const actionLabel = (action) => ({
  draft_created: '创建采购草稿',
  draft_saved: '保存采购草稿',
  submitted: '提交采购申请',
  approved: '审批通过',
  rejected: '审批拒绝',
  revoked: '撤销采购申请',
  deleted: '删除草稿'
}[action] || action || '操作')

const revokeForm = reactive({
  comment: ''
})

const supplierForm = reactive({
  supplierId: null,
  name: '',
  contact: '',
  phone: '',
  address: '',
  isServiceProvider: true,
  grossProfitUpliftAmount: 0,
  remark: '',
  status: 1,
  paymentAccounts: []
})

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const getApiErrorMessage = (error, fallback) => {
  const responseMessage = error?.response?.data?.message
  if (responseMessage) return responseMessage
  if (error?.code === 'ERR_NETWORK' || !error?.response) {
    return '采购接口暂时无法连接，请检查系统 API 回源配置后重试'
  }
  return error?.message || fallback
}

const formatMoney = (value) => toNumber(value).toFixed(2)

const hasRebateDeduction = (request) => toNumber(request?.current_rebate_deduction ?? request?.rebate_deduction) > 0

const requestActualAmount = (request) => {
  const total = toNumber(request?.current_total_amount ?? request?.total_amount)
  const rebate = toNumber(request?.current_rebate_deduction ?? request?.rebate_deduction)
  if (request?.current_actual_total !== undefined && request?.current_actual_total !== null) {
    return toNumber(request.current_actual_total)
  }
  const actual = toNumber(request?.actual_total)
  if (actual > 0 || total === 0) return actual
  return Math.max(0, total - rebate)
}

const requestItemSubtotal = (item) => {
  const subtotal = toNumber(item?.subtotal)
  if (subtotal > 0) return subtotal
  return toNumber(item?.unit_price) * toNumber(item?.quantity)
}

const requestItemActualAmount = (item) => {
  return Math.max(0, requestItemSubtotal(item) - toNumber(item?.rebate_deduction))
}

const adjustmentRowAmount = (row) => {
  if (!row?.editable) return 0
  return -toQuantity(row.return_quantity) * toNumber(row.actual_unit_price ?? row.unit_price)
}

const adjustmentTotalQuantityDelta = computed(() => {
  return adjustmentRows.value.reduce((sum, row) => {
    if (!row?.editable) return sum
    return sum - toQuantity(row.return_quantity)
  }, 0)
})

const adjustmentTotalAmountDelta = computed(() => {
  return adjustmentRows.value.reduce((sum, row) => sum + adjustmentRowAmount(row), 0)
})

const hasAdjustmentChanges = computed(() => adjustmentRows.value.some(row => (
  row?.editable && toQuantity(row.return_quantity) > 0
)))

const toQuantity = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

const normalizeAllocationQuantity = (value, totalQuantity) => {
  const quantity = toQuantity(value)
  const total = toQuantity(totalQuantity)
  return quantity <= total ? quantity : 0
}

const totalAmount = computed(() => {
  return requestForm.items.reduce((sum, item) => {
    return sum + (toNumber(item.price) * toNumber(item.quantity))
  }, 0)
})

const itemSubtotal = (item) => {
  return toNumber(item.price) * toNumber(item.quantity)
}

const rebateDeductionAmount = computed(() => {
  return Math.min(toNumber(requestForm.rebateDeduction), totalAmount.value, rebateBalance.value || totalAmount.value)
})

const actualTotal = computed(() => {
  return totalAmount.value - rebateDeductionAmount.value
})

const allocatedTotalQuantity = computed(() => {
  return storeAllocationList.value.reduce((sum, item) => {
    return sum + toQuantity(item.quantity)
  }, 0)
})

const remainingAllocateQuantity = computed(() => {
  return toQuantity(currentAllocateProduct.value?.quantity) - allocatedTotalQuantity.value
})

const allocatedLocationQuantity = computed(() => {
  return locationAllocationList.value.reduce((sum, item) => sum + toQuantity(item.quantity), 0)
})

const remainingLocationQuantity = computed(() => {
  return toQuantity(currentLocationAllocateStore.value?.quantity) - allocatedLocationQuantity.value
})

onMounted(() => {
  syncTabFromRoute()
  const traceRequestId = String(route.query.requestId || '').trim()
  if (traceRequestId && String(route.query.trace || '') === '1') {
    activeTab.value = 'request'
    handleTraceView(traceRequestId)
    return
  }
  loadData()
  loadSuppliers()
  loadAllSuppliers()
  loadAllStores()
  loadProducts()
  loadFreightPlatforms()
  loadOperatorStaff()
  loadResourceOptions()
  loadGoodsTypeOptions()
})

watch(() => route.path, syncTabFromRoute)

const handleTraceView = async (requestId) => {
  try {
    const res = await api.getPurchaseRequestDetail(requestId, { trace: '1' })
    if (res.code === 0) {
      currentRequest.value = res.data
      viewDialogVisible.value = true
    } else {
      ElMessage.error(res.message || '获取采购订单详情失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '获取采购订单详情失败')
  }
}

const loadAllStores = async () => {
  if (allStoresLoaded.value) return
  try {
    const res = await api.getAllStores()
    if (res && res.code === 0 && Array.isArray(res.data)) {
      allStores.value = res.data
      allStoresLoaded.value = true
    } else {
      allStores.value = []
    }
  } catch (err) {
    allStores.value = []
  }
}

const loadFreightPlatforms = async () => {
  try {
    const res = await api.getFreightPlatforms()
    if (res.code === 0) freightPlatforms.value = res.data || []
  } catch (err) {
    freightPlatforms.value = []
  }
}

const loadData = async () => {
  try {
    const res = await api.getPurchaseRequestList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.pagination?.total || res.data?.total || 0
      return
    }
    tableData.value = []
    total.value = 0
    ElMessage.error(res.message || '加载采购申请失败')
  } catch (err) {
    tableData.value = []
    total.value = 0
    ElMessage.error(getApiErrorMessage(err, '加载采购申请失败'))
  }
}

const handleRequestSearch = () => {
  queryParams.page = 1
  loadData()
}

const handleRequestFilterChange = () => {
  queryParams.page = 1
  loadData()
}

const loadOperatorStaff = async () => {
  try {
    const res = await api.getAuxiliaryStaff()
    operatorStaffList.value = res.code === 0 ? (res.data || []) : []
  } catch (_) {
    operatorStaffList.value = []
  }
}

const resetRequestSearch = () => {
  queryParams.page = 1
  queryParams.status = ''
  queryParams.submitter = ''
  queryParams.keyword = ''
  queryParams.supplierId = ''
  queryParams.operatorStaffId = ''
  loadData()
}

const loadSuppliers = async () => {
  try {
    const res = await api.getSupplierList(supplierQuery)
    if (res.code === 0) {
      supplierData.value = res.data?.list || []
      supplierTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load suppliers')
    ElMessage.error(err.response?.data?.message || '加载供应商失败')
  }
}

const loadAllSuppliers = async () => {
  try {
    const params = supplierSearchKeyword.value
      ? { keyword: supplierSearchKeyword.value, status: 1, page: 1, pageSize: 50 }
      : null
    const res = params ? await api.getSupplierList(params) : await api.getAllSuppliers()
    if (res.code === 0) {
      allSuppliers.value = params ? (res.data?.list || []) : (res.data || [])
    }
  } catch (err) {
    console.error('Failed to load all suppliers')
  }
}

const moveSupplier = async (index, direction) => {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= supplierData.value.length) return

  const sorted = [...supplierData.value]
  ;[sorted[index], sorted[targetIndex]] = [sorted[targetIndex], sorted[index]]

  try {
    const res = await api.sortSuppliers({
      items: sorted.map((item, idx) => ({ id: item.supplier_id, sortOrder: idx }))
    })
    if (res.code === 0) {
      ElMessage.success('排序已更新')
      await loadSuppliers()
      await loadAllSuppliers()
    } else {
      ElMessage.error(res.message || '排序失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '排序失败')
  }
}

const searchRequestSuppliers = async (keyword) => {
  supplierSearchKeyword.value = keyword || ''
  await loadAllSuppliers()
}

const onRequestSupplierVisibleChange = async (visible) => {
  if (visible) {
    supplierSearchKeyword.value = ''
    await loadAllSuppliers()
  }
}

const loadProducts = async () => {
  try {
    const res = await api.getProductList({ page: 1, pageSize: 1000 })
    if (res.code === 0) {
      products.value = res.data?.list || []
    }
  } catch (err) {
    console.error('Failed to load products')
  }
}

const loadResourceOptions = async () => {
  try {
    const res = await api.getResourceCategories({ activeOnly: 1 })
    resourceOptions.value = (res.data || [])
      .filter(item => item.supports_purchase_select !== 0)
      .map(item => ({ label: item.name, value: item.category_code }))
  } catch (err) {
    console.error('Failed to load resource categories')
  }
}

const loadGoodsTypeOptions = async () => {
  try {
    const res = await api.getGoodsTypes({ activeOnly: 1 })
    goodsTypeOptions.value = res.data || []
    if (!requestForm.productType && goodsTypeOptions.value.length) {
      requestForm.productType = goodsTypeOptions.value[0].name
    }
  } catch (err) {
    goodsTypeOptions.value = []
    console.error('Failed to load goods types')
  }
}

const goodsTypeResourceCodes = name => {
  const goodsType = goodsTypeOptions.value.find(item => item.name === name)
  return (goodsType?.ResourceCategories || [])
    .filter(item => item.status !== 0 && item.supports_purchase_select !== 0)
    .map(item => item.category_code)
}

const onGoodsTypeChange = name => {
  const resourceTypes = goodsTypeResourceCodes(name)
  requestForm.items.forEach(item => {
    item.selectedResourceTypes = [...resourceTypes]
  })
}

const handleCreate = () => {
  resetForm()
  editingRequestId.value = ''
  restorePurchaseRequestDraft()
  if (resourceOptions.value.length === 0) loadResourceOptions()
  if (goodsTypeOptions.value.length === 0) loadGoodsTypeOptions()
  requestDialogVisible.value = true
}

const parseDraftJson = (value, fallback = []) => {
  if (Array.isArray(value)) return value
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch (_) {
    return fallback
  }
}

const handleEditDraft = async (row) => {
  try {
    const res = await api.getPurchaseRequestDetail(row.request_id)
    if (res.code !== 0) {
      ElMessage.error(res.message || '获取采购申请详情失败')
      return
    }
    const request = res.data
    editingRequestId.value = request.request_id
    requestForm.supplierId = request.supplier_id || ''
    requestForm.invoiceType = request.invoice_type || ''
    requestForm.paymentMethod = request.payment_method || 'COMPANY_CREDIT'
    requestForm.productType = request.product_type || goodsTypeOptions.value[0]?.name || ''
    requestForm.remark = request.reason || ''
    requestForm.rebateDeduction = request.rebate_deduction || 0
    requestForm.freightPlatformId = request.freight_platform_id || ''
    requestForm.freightAmount = Number(request.freight_amount || 0)
    requestForm.items = (request.items || []).map(item => ({
      productId: item.product_id || '',
      productName: item.product_name || '',
      productCode: item.product_code || '',
      manufacturerCode: item.manufacturer_code || '',
      pnCode: item.pn_code || '',
      price: item.unit_price || 0,
      quantity: item.quantity || 1,
      rebateDeduction: item.rebate_deduction || 0,
      storeAllocations: parseDraftJson(item.store_allocations_parsed || item.store_allocations),
      selectedResourceTypes: parseDraftJson(item.selected_resource_types)
      ,isUsedProduct: Number(item.is_used_product) === 1
      ,directInbound: Number(item.direct_inbound) === 1
      ,directInboundSnCode: item.direct_inbound_sn_code || ''
    }))
    requestDialogVisible.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '获取采购申请详情失败')
  }
}

const handleSubmitDraft = async (row) => {
  try {
    await ElMessageBox.confirm('提交后将进入采购审批流程，是否继续？', '提交采购申请', {
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.submitPurchaseRequestDraft(row.request_id)
    if (res.code === 0) {
      ElMessage.success('采购申请已提交')
      await loadData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '提交失败')
  }
}

const handleView = async (row) => {
  try {
    const res = await api.getPurchaseRequestDetail(row.request_id)
    if (res.code === 0) {
      currentRequest.value = res.data
      viewDialogVisible.value = true
    } else {
      ElMessage.error(res.message || '获取详情失败')
    }
  } catch (err) {
    ElMessage.error('获取详情失败')
  }
}

const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

const handleApprove = (row) => {
  currentRequest.value = row
  approveForm.action = 'approved'
  approveForm.comment = ''
  approveDialogVisible.value = true
}

const handleApproveSubmit = async () => {
  approveLoading.value = true
  try {
    const res = await api.approvePurchaseRequest(currentRequest.value.request_id, {
      status: approveForm.action,
      comment: approveForm.comment
    })
    if (res.code === 0) {
      ElMessage.success('审批成功')
      approveDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '审批失败')
    }
  } catch (err) {
    ElMessage.error('审批失败')
  } finally {
    approveLoading.value = false
  }
}

const handleRevoke = (row) => {
  currentRequest.value = row
  revokeForm.comment = ''
  revokeDialogVisible.value = true
}

const handleRevokeSubmit = async () => {
  revokeLoading.value = true
  try {
    const res = await api.revokePurchaseRequest(currentRequest.value.request_id, {
      comment: revokeForm.comment
    })
    if (res.code === 0) {
      ElMessage.success('撤销成功')
      revokeDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '撤销失败')
    }
  } catch (err) {
    if (err.response?.data?.message) {
      ElMessage.error(err.response.data.message)
    } else {
      ElMessage.error('撤销失败')
    }
  } finally {
    revokeLoading.value = false
  }
}

const handleAdjustment = async (row) => {
  try {
    const res = await api.getPurchaseAdjustmentPreview(row.request_id)
    if (res.code === 0) {
      adjustmentRequest.value = res.data
      adjustmentRows.value = (res.data?.rows || []).map(item => ({
        ...item,
        return_quantity: 0,
        sn_ids: []
      }))
      adjustmentReason.value = ''
      adjustmentDialogVisible.value = true
    } else {
      ElMessage.warning(res.message || '该采购单没有可调整的未入库商品')
    }
  } catch (err) {
    ElMessage.warning(err.response?.data?.message || '该采购单没有可调整的未入库商品')
  }
}

const handleAdjustmentSubmit = async () => {
  if (!hasAdjustmentChanges.value) {
    ElMessage.warning('调整后数量未发生变化')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认提交本次采购退单吗？退库数量 ${Math.abs(adjustmentTotalQuantityDelta.value)}，应付变化 ¥${adjustmentTotalAmountDelta.value.toFixed(2)}`,
      '确认采购退单',
      { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }
    )
  } catch (_) {
    return
  }

  adjustmentLoading.value = true
  try {
    const res = await api.createPurchaseAdjustment({
      requestId: adjustmentRequest.value.request_id,
      reason: adjustmentReason.value,
      items: adjustmentRows.value
        .filter(row => row.editable)
        .map(row => ({
          inboundItemId: row.inbound_item_id,
          returnQuantity: toQuantity(row.return_quantity),
          snIds: row.sn_ids || []
        }))
    })
    if (res.code === 0) {
      ElMessage.success(res.message || '采购退单完成')
      adjustmentDialogVisible.value = false
      await loadData()
    } else {
      ElMessage.error(res.message || '采购退单失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '采购退单失败')
  } finally {
    adjustmentLoading.value = false
  }
}

const resetAdjustmentForm = () => {
  adjustmentRequest.value = null
  adjustmentRows.value = []
  adjustmentReason.value = ''
}

const handleAddSupplier = () => {
  supplierDialogTitle.value = '新增供应商'
  resetSupplierForm()
  restoreSupplierDraft()
  supplierDialogVisible.value = true
}

const handleEditSupplier = (row) => {
  supplierDialogTitle.value = '编辑供应商'
  currentSupplier.value = row
  supplierForm.supplierId = row.supplier_id
  supplierForm.name = row.name
  supplierForm.contact = row.contact || ''
  supplierForm.phone = row.phone || ''
  supplierForm.address = row.address || ''
  supplierForm.isServiceProvider = row.is_service_provider !== 0
  supplierForm.grossProfitUpliftAmount = Number(row.gross_profit_uplift_amount || 0)
  supplierForm.remark = row.remark || ''
  supplierForm.status = row.status
  supplierForm.paymentAccounts = normalizeSupplierAccounts(row.paymentAccounts || row.SupplierPaymentAccounts || [])
  supplierDialogVisible.value = true
}

const handleDeleteSupplier = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除供应商「${row.name}」吗？删除后不可恢复！`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const res = await api.deleteSupplier(row.supplier_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadSuppliers()
      loadAllSuppliers()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

const handleSupplierSubmit = async () => {
  if (!supplierForm.name) {
    ElMessage.warning('请输入供应商名称')
    return
  }

  supplierLoading.value = true
  try {
    const data = {
      name: supplierForm.name,
      contact: supplierForm.contact,
      phone: supplierForm.phone,
      address: supplierForm.address,
      isServiceProvider: supplierForm.isServiceProvider,
      grossProfitUpliftAmount: Number(supplierForm.grossProfitUpliftAmount || 0),
      remark: supplierForm.remark,
      status: supplierForm.status,
      paymentAccounts: normalizeSupplierAccounts(supplierForm.paymentAccounts)
    }

    let res
    if (supplierForm.supplierId) {
      res = await api.updateSupplier(supplierForm.supplierId, data)
    } else {
      res = await api.createSupplier(data)
    }

    if (res.code === 0) {
      ElMessage.success(supplierForm.supplierId ? '更新成功' : '创建成功')
      if (!supplierForm.supplierId) {
        clearDraft(SUPPLIER_DRAFT_KEY)
      }
      supplierDialogVisible.value = false
      supplierQuery.page = 1
      await loadSuppliers()
      await loadAllSuppliers()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '操作失败'
    ElMessage.error(msg)
  } finally {
    supplierLoading.value = false
  }
}

const handleSupplierDialogClose = () => {
  resetSupplierForm()
}

const resetSupplierForm = () => {
  supplierForm.supplierId = null
  supplierForm.name = ''
  supplierForm.contact = ''
  supplierForm.phone = ''
  supplierForm.address = ''
  supplierForm.isServiceProvider = true
  supplierForm.grossProfitUpliftAmount = 0
  supplierForm.remark = ''
  supplierForm.status = 1
  supplierForm.paymentAccounts = []
}

const saveSupplierDraft = () => {
  saveDraft(SUPPLIER_DRAFT_KEY, cloneDraft(supplierForm))
  ElMessage.success('草稿已保存')
}

const restoreSupplierDraft = () => {
  const draft = loadDraft(SUPPLIER_DRAFT_KEY)
  if (!draft) return
  Object.assign(supplierForm, draft)
  supplierForm.supplierId = null
  supplierForm.paymentAccounts = Array.isArray(draft.paymentAccounts) ? draft.paymentAccounts : []
  ElMessage.success('已恢复上次草稿')
}

const normalizeSupplierAccounts = (accounts = []) => {
  return accounts
    .map(account => ({
      accountId: account.accountId || account.account_id || '',
      companyName: account.companyName || account.company_name || '',
      taxNo: account.taxNo || account.tax_no || '',
      bankName: account.bankName || account.bank_name || '',
      accountNumber: account.accountNumber || account.account_number || '',
      remark: account.remark || ''
    }))
    .filter(account => account.companyName || account.taxNo || account.bankName || account.accountNumber || account.remark)
}

const addSupplierAccount = () => {
  supplierForm.paymentAccounts.push({
    companyName: supplierForm.name || '',
    taxNo: '',
    bankName: '',
    accountNumber: '',
    remark: ''
  })
}

const removeSupplierAccount = (index) => {
  supplierForm.paymentAccounts.splice(index, 1)
}

const searchProducts = async (keyword) => {
  productSearchKeyword.value = keyword
  try {
    const res = await api.getProductList({ keyword, page: 1, pageSize: 50 })
    if (res.code === 0) {
      products.value = res.data?.list || []
    }
  } catch (err) {
    console.error('Failed to search products')
  }
}

const onSupplierChange = async (supplierId) => {
  const supplier = allSuppliers.value.find(s => s.supplier_id === supplierId)
  if (supplier && supplier.invoice_type) {
    requestForm.invoiceType = supplier.invoice_type
  }
  requestForm.rebateDeduction = 0
  requestForm.items.forEach(item => {
    item.rebateDeduction = 0
  })
  if (supplierId) {
    try {
      const res = await api.getRebateBalance({ supplierId })
      if (res.code === 0) {
        rebateBalance.value = parseFloat(res.data?.balance || 0)
      }
    } catch (err) {
      rebateBalance.value = 0
    }
  } else {
    rebateBalance.value = 0
  }
}

const allocateTotalRebateToItems = () => {
  const totalCents = Math.round(rebateDeductionAmount.value * 100)
  if (totalCents <= 0 || requestForm.items.length === 0) {
    requestForm.items.forEach(item => {
      item.rebateDeduction = 0
    })
    requestForm.rebateDeduction = 0
    return
  }

  const candidates = requestForm.items
    .map((item, index) => ({ index, cap: Math.max(0, Math.round(itemSubtotal(item) * 100)) }))
    .filter(item => item.cap > 0)

  if (candidates.length === 0) return

  const cappedTotal = Math.min(totalCents, candidates.reduce((sum, item) => sum + item.cap, 0))
  const allocations = new Array(requestForm.items.length).fill(0)
  const base = Math.floor(cappedTotal / candidates.length)
  let extra = cappedTotal % candidates.length

  candidates.forEach(item => {
    const share = base + (extra > 0 ? 1 : 0)
    allocations[item.index] = Math.min(share, item.cap)
    if (extra > 0) extra -= 1
  })

  let remaining = cappedTotal - allocations.reduce((sum, amount) => sum + amount, 0)
  for (const item of candidates) {
    if (remaining <= 0) break
    const capacity = item.cap - allocations[item.index]
    if (capacity <= 0) continue
    const add = Math.min(capacity, remaining)
    allocations[item.index] += add
    remaining -= add
  }

  requestForm.items.forEach((item, index) => {
    item.rebateDeduction = (allocations[index] / 100).toFixed(2)
  })
  requestForm.rebateDeduction = (allocations.reduce((sum, amount) => sum + amount, 0) / 100).toFixed(2)
}

const onTotalRebateChange = () => {
  requestForm.rebateDeduction = rebateDeductionAmount.value.toFixed(2)
  allocateTotalRebateToItems()
}

const onItemRebateChange = () => {
  const maxTotal = Math.min(rebateBalance.value || totalAmount.value, totalAmount.value)
  let remaining = maxTotal
  let total = 0
  requestForm.items.forEach(item => {
    const amount = Math.min(toNumber(item.rebateDeduction), itemSubtotal(item), remaining)
    item.rebateDeduction = amount > 0 ? amount.toFixed(2) : 0
    remaining -= amount
    total += amount
  })
  requestForm.rebateDeduction = total.toFixed(2)
}

const onProductChange = (index) => {
  const product = products.value.find(p => p.product_id === requestForm.items[index].productId)
  if (product) {
    requestForm.items[index].productName = product.name
    requestForm.items[index].productCode = product.product_code || ''
    requestForm.items[index].manufacturerCode = product.manufacturer_code || ''
    requestForm.items[index].price = product.min_sale_price || 0
  }
}

const handleDeleteDraft = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除采购申请草稿 ${row.request_no}？`, '删除草稿', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.deletePurchaseRequestDraft(row.request_id)
    if (res.code === 0) {
      ElMessage.success('采购申请草稿已删除')
      await loadData()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '删除失败')
  }
}

const getProductByItem = (item) => {
  if (!item?.productId) return null
  return products.value.find(product => product.product_id === item.productId) || null
}

const getProductCode = (item) => getProductByItem(item)?.product_code || ''

const getManufacturerCode = (item) => getProductByItem(item)?.manufacturer_code || ''

const onItemAmountChange = () => {
  onItemRebateChange()
}

const addRequestItem = () => {
  requestForm.items.push({
    productId: '', productName: '', productCode: '', manufacturerCode: '', price: 0, quantity: 1, rebateDeduction: 0, storeAllocations: [],
    selectedResourceTypes: goodsTypeResourceCodes(requestForm.productType)
  })
  if (toNumber(requestForm.rebateDeduction) > 0) {
    allocateTotalRebateToItems()
  }
}

const removeRequestItem = (index) => {
  requestForm.items.splice(index, 1)
  if (toNumber(requestForm.rebateDeduction) > 0) {
    allocateTotalRebateToItems()
  }
}

const buildPurchaseRequestPayload = () => {
  const selectedGoodsType = goodsTypeOptions.value.find(item => item.name === requestForm.productType)
  return {
    supplierId: requestForm.supplierId,
    invoiceType: requestForm.invoiceType,
    paymentMethod: requestForm.paymentMethod,
    goodsTypeId: selectedGoodsType?.goods_type_id || '',
    productType: requestForm.productType,
    remark: requestForm.remark,
    rebateDeduction: rebateDeductionAmount.value,
    freightPlatformId: requestForm.freightPlatformId,
    freightPlatformName: freightPlatforms.value.find(item => item.platform_id === requestForm.freightPlatformId)?.platform_name || '',
    freightAmount: Number(requestForm.freightAmount || 0),
    items: requestForm.items.map(item => ({
      productId: item.productId || '',
      productName: item.productName,
      pnCode: item.pnCode || '',
      price: item.price,
      quantity: item.quantity,
      goodsTypeId: selectedGoodsType?.goods_type_id || '',
      productType: requestForm.productType,
      rebateDeduction: Math.min(toNumber(item.rebateDeduction), itemSubtotal(item)),
      isUsedProduct: Boolean(item.isUsedProduct),
      directInbound: Boolean(item.directInbound),
      directInboundSnCode: item.directInboundSnCode || '',
      storeAllocations: item.storeAllocations,
      selectedResourceTypes: item.selectedResourceTypes || []
    }))
  }
}

const validateItemAllocation = (item, index) => {
  const productName = item.productName || `第${index + 1}个商品`
  if (!Array.isArray(item.storeAllocations) || item.storeAllocations.length === 0) {
    ElMessage.warning(`请先为「${productName}」分配门店和库位`)
    return false
  }

  const itemQuantity = toQuantity(item.quantity)
  const allocatedQty = item.storeAllocations.reduce((sum, allocation) => sum + toQuantity(allocation.quantity), 0)
  if (allocatedQty !== itemQuantity) {
    ElMessage.warning(`「${productName}」门店分配数量(${allocatedQty})必须等于采购数量(${item.quantity})`)
    return false
  }

  const invalidStore = item.storeAllocations.find(allocation => {
    const locationTotal = (allocation.locationAllocations || []).reduce((sum, location) => sum + toQuantity(location.quantity), 0)
    return allocation.quantity <= 0 || locationTotal !== toQuantity(allocation.quantity)
  })
  if (invalidStore) {
    ElMessage.warning(`请完善「${productName}」的门店库位分配`)
    return false
  }
  return true
}

const validateDraftForm = () => {
  if (requestForm.items.length === 0) {
    ElMessage.warning('请添加商品')
    return false
  }
  for (const [index, item] of requestForm.items.entries()) {
    if ((!item.isUsedProduct && !item.productId) || (item.isUsedProduct && !String(item.productName || '').trim()) || toNumber(item.price) < 0 || toQuantity(item.quantity) <= 0) {
      ElMessage.warning(`请完善第${index + 1}个商品的名称、价格和数量`)
      return false
    }
    if (item.isUsedProduct && item.directInbound && (toQuantity(item.quantity) !== 1 || !String(item.directInboundSnCode || '').trim())) {
      ElMessage.warning(`二手商品“${item.productName || index + 1}”勾选审批完成及入库时，必须填写SN号且数量为1`)
      return false
    }
    if (!validateItemAllocation(item, index)) return false
  }
  return true
}

const handleSubmit = async () => {
  if (!requestForm.supplierId) {
    ElMessage.warning('请选择供应商')
    return
  }
  if (!requestForm.productType) {
    ElMessage.warning('请选择货型')
    return
  }
  if (requestForm.items.length === 0) {
    ElMessage.warning('请添加商品')
    return
  }

  // 校验每个商品都已分配门店和库位
  for (let i = 0; i < requestForm.items.length; i++) {
    const item = requestForm.items[i]
    if ((!item.isUsedProduct && !item.productId) || (item.isUsedProduct && !String(item.productName || '').trim()) || toNumber(item.price) < 0 || toQuantity(item.quantity) <= 0) {
      ElMessage.warning(`请完善第${i + 1}个商品的名称、价格和数量`)
      return
    }
    if (item.isUsedProduct && item.directInbound && (toQuantity(item.quantity) !== 1 || !String(item.directInboundSnCode || '').trim())) {
      ElMessage.warning('二手商品勾选审批完成及入库时，数量必须为1且必须填写SN号')
      return
    }
    if (!validateItemAllocation(item, i)) return
  }

  if (rebateDeductionAmount.value > 0 && rebateDeductionAmount.value > rebateBalance.value) {
    ElMessage.warning('返利抵扣不能超过供应商返利余额')
    return
  }

  submitLoading.value = true
  try {
    const data = buildPurchaseRequestPayload()
    let res
    if (editingRequestId.value) {
      res = await api.updatePurchaseRequestDraft(editingRequestId.value, data)
      if (res.code === 0) res = await api.submitPurchaseRequestDraft(editingRequestId.value)
    } else {
      res = await api.createPurchaseRequest(data)
    }
    if (res.code === 0) {
      ElMessage.success('提交成功')
      clearDraft(PURCHASE_REQUEST_DRAFT_KEY)
      requestDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    ElMessage.error(getApiErrorMessage(err, '提交采购申请失败'))
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
  editingRequestId.value = ''
}

const resetForm = () => {
  requestForm.supplierId = ''
  requestForm.invoiceType = ''
  requestForm.paymentMethod = 'COMPANY_CREDIT'
  requestForm.productType = goodsTypeOptions.value[0]?.name || ''
  requestForm.remark = ''
  requestForm.rebateDeduction = 0
  requestForm.freightPlatformId = ''
  requestForm.freightAmount = 0
  requestForm.items = []
}

const resetUsedProductForm = () => {
  usedProductForm.name = ''
  usedProductForm.pnCode = ''
  usedProductForm.price = 0
  usedProductForm.quantity = 1
  usedProductForm.directInbound = false
  usedProductForm.snCode = ''
}

const openUsedProductDialog = () => {
  resetUsedProductForm()
  usedProductDialogVisible.value = true
}

const saveUsedProduct = () => {
  const name = String(usedProductForm.name || '').trim()
  const quantity = toQuantity(usedProductForm.quantity)
  const price = toNumber(usedProductForm.price)
  const snCode = String(usedProductForm.snCode || '').trim()
  if (!name || price < 0 || quantity <= 0) {
    ElMessage.warning('请完善二手商品名称、采购单价和数量')
    return
  }
  if (usedProductForm.directInbound && (quantity !== 1 || !snCode)) {
    ElMessage.warning('勾选审批完成及入库时，数量必须为1且必须填写SN号')
    return
  }
  requestForm.items.push({
    isUsedProduct: true,
    productId: '',
    productName: name,
    productCode: '二手商品待生成',
    manufacturerCode: usedProductForm.pnCode || '',
    pnCode: usedProductForm.pnCode || '',
    price,
    quantity,
    rebateDeduction: 0,
    directInbound: Boolean(usedProductForm.directInbound),
    directInboundSnCode: usedProductForm.directInbound ? snCode : '',
    storeAllocations: [],
    selectedResourceTypes: goodsTypeResourceCodes(requestForm.productType)
  })
  usedProductDialogVisible.value = false
  resetUsedProductForm()
  ElMessage.success('二手商品已加入采购明细，请继续分配收货门店和库位')
}

const savePurchaseRequestDraft = async () => {
  if (!validateDraftForm()) return
  submitLoading.value = true
  try {
    const data = buildPurchaseRequestPayload()
    const res = editingRequestId.value
      ? await api.updatePurchaseRequestDraft(editingRequestId.value, data)
      : await api.savePurchaseRequestDraft(data)
    if (res.code === 0) {
      ElMessage.success('采购申请草稿已保存')
      clearDraft(PURCHASE_REQUEST_DRAFT_KEY)
      requestDialogVisible.value = false
      editingRequestId.value = ''
      await loadData()
    } else {
      ElMessage.error(res.message || '保存草稿失败')
    }
  } catch (err) {
    ElMessage.error(getApiErrorMessage(err, '保存草稿失败'))
  } finally {
    submitLoading.value = false
  }
}

const restorePurchaseRequestDraft = () => {
  const draft = loadDraft(PURCHASE_REQUEST_DRAFT_KEY)
  if (!draft) return
  Object.assign(requestForm, draft)
  requestForm.paymentMethod = draft.paymentMethod || 'COMPANY_CREDIT'
  requestForm.items = Array.isArray(draft.items)
    ? draft.items.map(item => ({ rebateDeduction: 0, selectedResourceTypes: [], ...item }))
    : []
  ElMessage.success('已恢复上次草稿')
}

const getStatusType = (status) => {
  const types = { draft: 'info', pending: 'warning', approved: 'success', rejected: 'danger', purchased: 'info', revoked: 'info' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { draft: '草稿', pending: '待审批', approved: '已通过', rejected: '已拒绝', purchased: '已采购', revoked: '已撤销' }
  return texts[status] || status
}

const getPaymentMethodText = (value) => {
  const map = {
    COMPANY_CREDIT: '公司账期',
    PERSONAL_ADVANCE: '个人垫付'
  }
  return map[value] || '公司账期'
}

const ensureStoreLocations = async (storeId) => {
  if (!storeId || Object.prototype.hasOwnProperty.call(storeLocationOptions, storeId)) return storeLocationOptions[storeId] || []
  storeLocationLoading[storeId] = true
  try {
    const res = await api.getLocationsByStore(storeId)
    const locations = res.code === 0 ? (res.data || []).filter(location => Number(location.status) !== 0) : []
    storeLocationOptions[storeId] = locations
    return locations
  } catch (err) {
    storeLocationOptions[storeId] = []
    ElMessage.error(err.response?.data?.message || '加载库位失败')
    return []
  } finally {
    storeLocationLoading[storeId] = false
  }
}

const getDefaultSalesLocation = (locations = []) => {
  return locations.find(location => location.type === 'normal_qty' || location.name === '销售仓') || locations[0]
}

const getExistingLocationAllocations = (allocation) => {
  if (Array.isArray(allocation?.locationAllocations)) return allocation.locationAllocations
  if (Array.isArray(allocation?.location_allocations)) return allocation.location_allocations
  if (allocation?.locationId || allocation?.location_id) {
    return [{
      locationId: allocation.locationId || allocation.location_id,
      locationName: allocation.locationName || allocation.location_name || '',
      quantity: allocation.quantity
    }]
  }
  return []
}

const handleAllocateStore = async (row, index) => {
  const totalQuantity = toQuantity(row.quantity)
  if (totalQuantity <= 0) {
    ElMessage.warning('请先输入商品数量')
    return
  }

  await Promise.all(allStores.value.map(store => ensureStoreLocations(store.store_id)))
  
  const product = products.value.find(p => p.product_id === row.productId)
  currentAllocateProduct.value = {
    ...row,
    quantity: totalQuantity,
    productName: product?.name || ''
  }
  currentAllocateIndex.value = index
  
  storeAllocationList.value = allStores.value.map(store => {
    const existing = row.storeAllocations?.find(a => (a.storeId || a.store_id) === store.store_id)
    const quantity = normalizeAllocationQuantity(existing?.quantity, totalQuantity)
    const locations = storeLocationOptions[store.store_id] || []
    const existingLocations = getExistingLocationAllocations(existing)
    const defaultLocation = getDefaultSalesLocation(locations)
    const locationAllocations = existingLocations.length
      ? existingLocations.map(location => {
        const locationId = location.locationId || location.location_id
        const locationOption = locations.find(option => option.location_id === locationId)
        return {
          ...location,
          locationId,
          locationName: location.locationName || location.location_name || locationOption?.name || '',
          quantity: normalizeAllocationQuantity(location.quantity, quantity)
        }
      })
      : (quantity > 0 && defaultLocation
        ? [{ locationId: defaultLocation.location_id, locationName: defaultLocation.name, quantity }]
        : [])
    return {
      storeId: store.store_id,
      storeName: store.name,
      quantity,
      locationAllocations
    }
  })
  
  allocateDialogVisible.value = true
}

const validateAllocation = () => {
  if (allocatedTotalQuantity.value > toQuantity(currentAllocateProduct.value?.quantity)) {
    ElMessage.warning('分配数量不能超过总数量')
  }
  storeAllocationList.value.forEach(row => {
    if (toQuantity(row.quantity) <= 0 || (row.locationAllocations || []).length > 0) return
    const defaultLocation = getDefaultSalesLocation(storeLocationOptions[row.storeId] || [])
    if (defaultLocation) {
      row.locationAllocations = [{
        locationId: defaultLocation.location_id,
        locationName: defaultLocation.name,
        quantity: toQuantity(row.quantity)
      }]
    }
  })
}

const handleAllocateLocations = async (row) => {
  const storeQuantity = toQuantity(row.quantity)
  if (storeQuantity <= 0) {
    ElMessage.warning('请先输入门店分配数量')
    return
  }
  const locations = await ensureStoreLocations(row.storeId)
  if (locations.length === 0) {
    ElMessage.warning('该门店暂无启用库位')
    return
  }
  const existingLocations = getExistingLocationAllocations(row)
  const defaultLocation = getDefaultSalesLocation(locations)
  const hasExisting = existingLocations.length > 0
  currentLocationAllocateStore.value = row
  locationAllocationList.value = locations.map(location => {
    const existing = existingLocations.find(item => (
      item.locationId === location.location_id || item.location_id === location.location_id
    ))
    return {
      locationId: location.location_id,
      locationName: location.name,
      quantity: existing
        ? normalizeAllocationQuantity(existing.quantity, storeQuantity)
        : (!hasExisting && defaultLocation?.location_id === location.location_id ? storeQuantity : 0)
    }
  })
  locationAllocateDialogVisible.value = true
}

const validateLocationAllocation = () => {
  if (allocatedLocationQuantity.value > toQuantity(currentLocationAllocateStore.value?.quantity)) {
    ElMessage.warning('库位分配数量不能超过门店分配数量')
  }
}

const handleSaveLocationAllocation = () => {
  const storeQuantity = toQuantity(currentLocationAllocateStore.value?.quantity)
  if (allocatedLocationQuantity.value !== storeQuantity) {
    ElMessage.warning(`库位分配数量(${allocatedLocationQuantity.value})必须等于门店数量(${storeQuantity})`)
    return
  }
  if (currentLocationAllocateStore.value) {
    currentLocationAllocateStore.value.locationAllocations = locationAllocationList.value
      .map(location => ({ ...location, quantity: toQuantity(location.quantity) }))
      .filter(location => location.quantity > 0)
  }
  ElMessage.success('库位分配成功')
  locationAllocateDialogVisible.value = false
}

const handleSaveAllocation = () => {
  const totalAllocated = allocatedTotalQuantity.value
  const totalQuantity = toQuantity(currentAllocateProduct.value?.quantity)
  
  if (totalAllocated !== totalQuantity) {
    ElMessage.warning(`门店分配数量(${totalAllocated})必须等于商品总数量(${totalQuantity})`)
    return
  }
  
  const validAllocations = storeAllocationList.value
    .map(a => ({
      ...a,
      quantity: toQuantity(a.quantity),
      locationAllocations: (a.locationAllocations || [])
        .map(location => ({ ...location, quantity: toQuantity(location.quantity) }))
        .filter(location => location.quantity > 0)
    }))
    .filter(a => a.quantity > 0)

  const invalidLocationAllocation = validAllocations.find(allocation => (
    allocation.locationAllocations.length === 0 ||
    allocation.locationAllocations.reduce((sum, location) => sum + location.quantity, 0) !== allocation.quantity
  ))
  if (invalidLocationAllocation) {
    ElMessage.warning(`请完善${invalidLocationAllocation.storeName}的库位分配`)
    return
  }
  
  if (currentAllocateIndex.value >= 0) {
    requestForm.items[currentAllocateIndex.value].storeAllocations = validAllocations
  }
  
  ElMessage.success('分配成功')
  allocateDialogVisible.value = false
}

const handleAllocateDialogClose = () => {
  currentAllocateProduct.value = null
  currentAllocateIndex.value = -1
  storeAllocationList.value = []
}

const handleLocationAllocateDialogClose = () => {
  currentLocationAllocateStore.value = null
  locationAllocationList.value = []
}
</script>

<style scoped>
.module-tabs :deep(.el-tabs__header) {
  display: none;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.purchase-request-dialog :deep(.el-dialog__body) {
  padding: 18px 24px 8px;
}

.purchase-request-form :deep(.el-form-item__label) {
  color: #606266;
  font-size: 16px;
}

.purchase-request-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.purchase-request-form :deep(.el-input__wrapper),
.purchase-request-form :deep(.el-select__wrapper),
.purchase-request-form :deep(.el-textarea__inner) {
  min-height: 42px;
  border-radius: 6px;
}

.purchase-request-form :deep(.el-textarea__inner) {
  min-height: 82px;
}

.items-form-item :deep(.el-form-item__content) {
  display: block;
}

.purchase-items-panel {
  width: 100%;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 16px;
  box-sizing: border-box;
}

.request-items-table {
  width: 100%;
}

.request-items-table :deep(.el-table__cell) {
  padding: 12px 8px;
}

.request-items-table :deep(.el-table__header-wrapper th) {
  color: #606266;
  background: #fafafa;
  font-size: 15px;
}

.product-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.product-option-meta {
  color: #909399;
  font-size: 12px;
}

.item-total {
  color: #f56c6c;
  font-weight: 600;
}

.purchase-items-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 54px;
  border: 1px solid #ebeef5;
  border-top: 0;
  padding: 0 16px;
}

.add-product-button {
  font-size: 16px;
}

.purchase-items-total {
  color: #606266;
  font-size: 16px;
  font-weight: 600;
}

.purchase-items-total span {
  color: #f56c6c;
  margin-left: 12px;
}

.purchase-allocation-row,
.purchase-resource-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  margin-top: 14px;
  padding: 0 16px;
  border-radius: 6px;
  background: #f5f7fa;
  box-sizing: border-box;
}

.purchase-resource-row {
  background: #eef5ff;
}

.purchase-subsection-label {
  flex: 0 0 auto;
  color: #606266;
  font-size: 16px;
  white-space: nowrap;
}

.purchase-allocation-content {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.allocation-tag {
  padding: 4px 8px;
  color: #606266;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 13px;
}

.allocation-empty {
  color: #f56c6c;
  font-size: 15px;
}

.resource-select {
  flex: 1;
  min-width: 0;
}

.purchase-rebate-section {
  margin-top: 14px;
  padding: 10px 16px;
  background: #fff7e8;
  border-radius: 6px;
}

.purchase-rebate-header {
  margin-bottom: 8px;
  color: #909399;
  font-size: 13px;
}

.item-field-hint {
  color: #909399;
  font-size: 12px;
  margin-bottom: 8px;
}

.item-field-header {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 110px 75px 70px 60px;
  gap: 8px;
  color: #606266;
  font-size: 12px;
  padding: 0 10px 6px;
  align-items: center;
}
.location-summary {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-right: 8px;
  color: #606266;
  font-size: 12px;
}
.location-summary span {
  padding: 2px 6px;
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
  border-radius: 4px;
}
.location-missing {
  color: #f56c6c;
  font-size: 12px;
  margin-right: 8px;
}
.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
.items-table {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
}
.item-rebate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px;
  background: #fff7e8;
  border-radius: 4px;
  font-size: 12px;
  color: #606266;
}

.item-resource-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px;
  background: #eef5ff;
  border-radius: 4px;
  font-size: 12px;
  color: #606266;
}
.item-rebate-row .el-input {
  width: 120px;
}
.mt-10 {
  margin-top: 10px;
}
.mt-20 {
  margin-top: 20px;
}
.ml-10 {
  margin-left: 10px;
}
.order-summary {
  background: #f5f7fa;
  padding: 15px;
  border-radius: 4px;
  margin-top: 20px;
}
.summary-item {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
}
.summary-item.total {
  font-weight: bold;
  font-size: 16px;
}
.summary-item span {
  color: #f56c6c;
}
.supplier-accounts {
  width: 100%;
}
.supplier-account-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) 44px;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.no-spinner :deep(input[type='number'])::-webkit-inner-spin-button,
.no-spinner :deep(input[type='number'])::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner :deep(input[type='number']) {
  -moz-appearance: textfield;
}
</style>
