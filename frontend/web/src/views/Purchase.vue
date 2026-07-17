<template>
  <div class="purchase-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>采购管理</span>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="采购申请" name="request">
          <div class="filter-bar">
            <el-select v-model="queryParams.status" placeholder="状态" clearable style="width: 150px">
              <el-option label="全部" value="" />
              <el-option label="草稿" value="draft" />
              <el-option label="待审批" value="pending" />
              <el-option label="已通过" value="approved" />
              <el-option label="已拒绝" value="rejected" />
            </el-select>
            <el-button type="primary" @click="handleCreate">新建采购申请</el-button>
            <el-button type="success" :loading="exportLoading" @click="handleExportRequests">导出</el-button>
          </div>
          <el-table :data="tableData" stripe border>
            <el-table-column prop="request_no" label="申请单号" width="180" />
            <el-table-column prop="create_time" label="申请时间" width="160">
              <template #default="{ row }">
                {{ row.create_time ? formatDate(row.create_time) : '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="store_name" label="申请门店" width="120" />
            <el-table-column prop="supplier_name" label="供应商" width="150" />
            <el-table-column prop="operator_name" label="经手人" width="100" />
            <el-table-column prop="create_user" label="制单人" width="100" />
            <el-table-column label="付款方式" width="110">
              <template #default="{ row }">{{ getPaymentMethodText(row.payment_method) }}</template>
            </el-table-column>
            <el-table-column prop="invoice_type" label="发票类型" width="100" />
            <el-table-column prop="product_type" label="货型" width="130" />
            <el-table-column prop="product_names_summary" label="完整产品名称" min-width="220" show-overflow-tooltip>
              <template #default="{ row }"><div class="multiline-summary">{{ row.product_names_summary || '-' }}</div></template>
            </el-table-column>
            <el-table-column prop="product_codes_summary" label="产品编码" min-width="140" show-overflow-tooltip>
              <template #default="{ row }"><div class="multiline-summary">{{ row.product_codes_summary || '-' }}</div></template>
            </el-table-column>
            <el-table-column prop="manufacturer_codes_summary" label="厂商编码" min-width="140" show-overflow-tooltip>
              <template #default="{ row }"><div class="multiline-summary">{{ row.manufacturer_codes_summary || '-' }}</div></template>
            </el-table-column>
            <el-table-column prop="items_summary" label="商品摘要" min-width="200" show-overflow-tooltip />
            <el-table-column prop="total_amount" label="申请金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="250">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleApprove(row)" v-if="row.status === 'pending'">审批</el-button>
                <el-button link type="warning" @click="handleEditDraft(row)" v-if="row.status === 'draft'">编辑</el-button>
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
    <el-dialog v-model="requestDialogVisible" title="新建采购申请" width="700px" @close="handleDialogClose">
      <el-form :model="requestForm" label-width="100px">
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
        <el-form-item label="采购经手人">
          <el-select v-model="requestForm.operatorStaffId" placeholder="默认当前用户" clearable filterable style="width: 100%">
            <el-option v-for="staff in operatorStaffList" :key="staff.staffId" :label="staff.name" :value="staff.staffId" />
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

        <el-form-item label="商品明细">
          <div class="items-table" style="width: 100%; max-width: 600px; overflow: hidden;">
            <div v-for="(item, idx) in requestForm.items" :key="idx" class="item-row" style="border: 1px solid #ebeef5; padding: 10px; margin-bottom: 10px; border-radius: 4px; width: 100%; box-sizing: border-box; max-width: 600px;">
              <div class="item-top" style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px; width: 100%; box-sizing: border-box;">
                <div style="flex: 1; min-width: 140px; max-width: 300px;">
                  <el-select v-model="item.productId" placeholder="搜索商品" filterable remote :remote-method="searchProducts" @change="onProductChange(idx)" style="width: 100%;" size="small">
                    <el-option v-for="p in products" :key="p.product_id" :label="`${p.name} (${p.product_code})`" :value="p.product_id">
                      <div style="display: flex; flex-direction: column; font-size: 12px;">
                        <span>{{ p.name }}</span>
                        <span style="color: #909399; font-size: 11px;">编码: {{ p.product_code }} | 厂商: {{ p.manufacturer_code || '-' }}</span>
                      </div>
                    </el-option>
                  </el-select>
                  <div v-if="item.productId" class="product-code-meta">
                    <span>商品编码：{{ item.productCode || '-' }}</span>
                    <span>厂商编码：{{ item.manufacturerCode || '-' }}</span>
                    <span class="product-full-name">商品名称：{{ item.productName || '-' }}</span>
                  </div>
                </div>
                <div style="width: 110px;">
                  <el-input v-model="item.price" type="number" placeholder="采购单价" size="small" style="width: 100%;" class="no-spinner" />
                </div>
                <div style="width: 75px;">
                  <el-input v-model="item.quantity" size="small" placeholder="数量" style="width: 100%;" class="no-spinner" />
                </div>
                <div style="width: 70px; font-size: 13px; flex-shrink: 0;">
                  <span style="color: #f56c6c; font-weight: 500;">¥{{ (item.price * item.quantity || 0).toFixed(2) }}</span>
                </div>
                <div style="width: 60px; flex-shrink: 0;">
                  <el-button link type="danger" size="small" @click="removeRequestItem(idx)">删除</el-button>
                </div>
              </div>
              <div class="item-bottom" style="display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: #f5f7fa; border-radius: 4px; width: 100%; box-sizing: border-box; overflow: hidden;">
                <span style="font-size: 12px; color: #606266; min-width: 60px; white-space: nowrap; flex-shrink: 0;">门店分配:</span>
                <div style="flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow: hidden;">
                  <div v-if="item.storeAllocations && item.storeAllocations.length > 0" style="display: flex; flex-wrap: wrap; gap: 6px;">
                    <div v-for="(alloc, allocIdx) in item.storeAllocations" :key="allocIdx" style="background: #fff; padding: 3px 6px; border-radius: 4px; border: 1px solid #e4e7ed; font-size: 11px; white-space: nowrap; max-width: 180px; text-overflow: ellipsis; overflow: hidden;">
                      <span>{{ alloc.storeName || alloc.storeId }}</span>
                      <span style="color: #909399; margin-left: 3px;">× {{ alloc.quantity }}</span>
                    </div>
                  </div>
                  <span v-else style="color: #f56c6c; font-size: 12px;">未分配</span>
                </div>
                <el-button type="primary" size="small" @click="handleAllocateStore(item, idx)" style="flex-shrink: 0;">分配</el-button>
              </div>
              <div v-if="requestForm.supplierId && rebateBalance > 0" class="item-rebate-row">
                <span>逐单返利</span>
                <el-input
                  v-model="item.rebateDeduction"
                  type="number"
                  placeholder="0"
                  size="small"
                  class="no-spinner"
                  @change="onItemRebateChange"
                />
                <span>抵扣后：¥{{ Math.max(0, itemSubtotal(item) - toNumber(item.rebateDeduction)).toFixed(2) }}</span>
              </div>
              <div class="item-resource-row">
                <span>资源权益</span>
                <el-select
                  v-model="item.selectedResourceTypes"
                  multiple
                  collapse-tags
                  collapse-tags-tooltip
                  clearable
                  size="small"
                  placeholder="选择本批货权益"
                  style="flex: 1; min-width: 0;"
                >
                  <el-option v-for="option in resourceOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </div>
            </div>
            <el-button type="primary" size="small" @click="addRequestItem">添加商品</el-button>
          </div>
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
          <el-descriptions-item label="采购经手人">{{ currentRequest.operator_name || currentRequest.apply_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="制单人">{{ currentRequest.create_user || currentRequest.apply_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请金额">¥{{ formatMoney(currentRequest.total_amount) }}</el-descriptions-item>
          <el-descriptions-item label="是否使用返利">
            <el-tag :type="hasRebateDeduction(currentRequest) ? 'success' : 'info'">
              {{ hasRebateDeduction(currentRequest) ? '是' : '否' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="返利抵扣">-¥{{ formatMoney(currentRequest.rebate_deduction) }}</el-descriptions-item>
          <el-descriptions-item label="实际应付">¥{{ formatMoney(requestActualAmount(currentRequest)) }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ formatDate(currentRequest.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentRequest.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentRequest.items || []" border size="small">
          <el-table-column prop="product_name" label="商品名称" min-width="150" />
          <el-table-column prop="product_code" label="商品编码" width="130" show-overflow-tooltip />
          <el-table-column prop="manufacturer_code" label="厂商编码" min-width="160" show-overflow-tooltip />
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
          title="仅可调整尚未入库的数量；已入库数量如需退回，请到库存管理办理退库。提交后原采购单和原入库单保留历史，系统新增正负待付款调整记录。"
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
        <el-table-column prop="inbound_no" label="待入库单" width="170" />
        <el-table-column prop="unit_price" label="采购单价" width="105" align="right">
          <template #default="{ row }">¥{{ formatMoney(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column prop="original_quantity" label="原采购数量" width="105" align="right" />
        <el-table-column prop="received_quantity" label="已入库数量" width="105" align="right" />
        <el-table-column prop="pending_quantity" label="当前待入库" width="105" align="right" />
        <el-table-column label="调整后待入库" width="155" align="right">
          <template #default="{ row }">
            <el-input-number
              v-if="row.editable"
              v-model="row.target_quantity"
              :min="0"
              :precision="0"
              :step="1"
              controls-position="right"
              size="small"
              style="width: 130px"
            />
            <span v-else style="color: #909399;">{{ row.received_quantity }}（已入库）</span>
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
      </el-table>
      <template #footer>
        <el-button @click="allocateDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveAllocation">确定</el-button>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'

const activeTab = ref('request')
const PURCHASE_REQUEST_DRAFT_KEY = 'purchase-request-create'
const SUPPLIER_DRAFT_KEY = 'supplier-create'
const tableData = ref([])
const supplierData = ref([])
const allSuppliers = ref([])
const allStores = ref([])
const allStoresLoaded = ref(false)
const operatorStaffList = ref([])
const products = ref([])
const resourceOptions = ref([])
const goodsTypeOptions = ref([])
const productSearchKeyword = ref('')
const supplierSearchKeyword = ref('')
const total = ref(0)
const supplierTotal = ref(0)

const requestDialogVisible = ref(false)
const viewDialogVisible = ref(false)
const approveDialogVisible = ref(false)
const revokeDialogVisible = ref(false)
const adjustmentDialogVisible = ref(false)
const supplierDialogVisible = ref(false)
const allocateDialogVisible = ref(false)
const submitLoading = ref(false)
const exportLoading = ref(false)
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

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  status: ''
})

const supplierQuery = reactive({
  page: 1,
  pageSize: 100,
  keyword: ''
})

const requestForm = reactive({
  requestId: '',
  supplierId: '',
  invoiceType: '',
  paymentMethod: 'COMPANY_CREDIT',
  productType: '',
  operatorStaffId: '',
  remark: '',
  rebateDeduction: 0,
  items: []
})

const rebateBalance = ref(0)

const approveForm = reactive({
  action: 'approved',
  comment: ''
})

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

const formatMoney = (value) => toNumber(value).toFixed(2)

const hasRebateDeduction = (request) => toNumber(request?.rebate_deduction) > 0

const requestActualAmount = (request) => {
  const total = toNumber(request?.total_amount)
  const rebate = toNumber(request?.rebate_deduction)
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
  const delta = toQuantity(row.target_quantity) - toQuantity(row.pending_quantity)
  return delta * toNumber(row.actual_unit_price ?? row.unit_price)
}

const adjustmentTotalQuantityDelta = computed(() => {
  return adjustmentRows.value.reduce((sum, row) => {
    if (!row?.editable) return sum
    return sum + toQuantity(row.target_quantity) - toQuantity(row.pending_quantity)
  }, 0)
})

const adjustmentTotalAmountDelta = computed(() => {
  return adjustmentRows.value.reduce((sum, row) => sum + adjustmentRowAmount(row), 0)
})

const hasAdjustmentChanges = computed(() => adjustmentRows.value.some(row => (
  row?.editable && toQuantity(row.target_quantity) !== toQuantity(row.pending_quantity)
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

onMounted(() => {
  loadData()
  loadSuppliers()
  loadAllSuppliers()
  loadAllStores()
  loadProducts()
  loadOperatorStaff()
  loadResourceOptions()
  loadGoodsTypeOptions()
})

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

const loadData = async () => {
  try {
    const res = await api.getPurchaseRequestList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadOperatorStaff = async () => {
  try {
    const res = await api.getAuxiliaryStaff()
    operatorStaffList.value = res.code === 0 ? (res.data || []) : []
  } catch (_) {
    operatorStaffList.value = []
  }
}

const handleExportRequests = async () => {
  exportLoading.value = true
  try {
    await api.exportPurchaseRequests({ ...queryParams })
    ElMessage.success('采购申请导出成功')
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '采购申请导出失败')
  } finally {
    exportLoading.value = false
  }
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
  restorePurchaseRequestDraft()
  if (resourceOptions.value.length === 0) loadResourceOptions()
  if (goodsTypeOptions.value.length === 0) loadGoodsTypeOptions()
  requestDialogVisible.value = true
}

const parseSelectedResourceTypes = value => {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const handleEditDraft = async (row) => {
  try {
    const res = await api.getPurchaseRequestDetail(row.request_id)
    if (res.code !== 0) throw new Error(res.message || '获取草稿失败')
    const data = res.data || {}
    requestForm.requestId = data.request_id || row.request_id
    requestForm.supplierId = data.supplier_id || ''
    requestForm.invoiceType = data.invoice_type || ''
    requestForm.paymentMethod = data.payment_method || 'COMPANY_CREDIT'
    requestForm.productType = data.product_type || ''
    requestForm.operatorStaffId = data.operator_staff_id || ''
    requestForm.remark = data.reason || data.remark || ''
    requestForm.rebateDeduction = 0
    requestForm.items = (data.items || []).map(item => ({
      productId: item.product_id || '',
      productName: item.product_name || '',
      productCode: item.product_code || '',
      manufacturerCode: item.manufacturer_code || '',
      pnCode: item.pn_code || '',
      price: Number(item.unit_price || 0),
      quantity: Number(item.quantity || 0),
      rebateDeduction: 0,
      storeAllocations: item.store_allocations_parsed || [],
      selectedResourceTypes: parseSelectedResourceTypes(item.selected_resource_types)
    }))
    requestDialogVisible.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '获取草稿失败')
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
        target_quantity: toQuantity(item.target_quantity)
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
      `确认提交本次采购退单吗？数量变化 ${adjustmentTotalQuantityDelta.value}，应付变化 ¥${adjustmentTotalAmountDelta.value.toFixed(2)}`,
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
          targetQuantity: toQuantity(row.target_quantity)
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

  // 校验每个商品都已分配门店
  for (let i = 0; i < requestForm.items.length; i++) {
    const item = requestForm.items[i]
    const productName = item.productName || '第' + (i + 1) + '个商品'
    
    if (!item.storeAllocations || item.storeAllocations.length === 0) {
      ElMessage.warning(`请先为「${productName}」分配门店`)
      return
    }

    // 校验分配数量总和等于商品数量
    const itemQuantity = toQuantity(item.quantity)
    const allocatedQty = item.storeAllocations.reduce((sum, alloc) => sum + normalizeAllocationQuantity(alloc.quantity, itemQuantity), 0)
    if (allocatedQty !== itemQuantity) {
      ElMessage.warning(`「${productName}」分配数量(${allocatedQty})必须等于采购数量(${item.quantity})`)
      return
    }
  }

  if (rebateDeductionAmount.value > 0 && rebateDeductionAmount.value > rebateBalance.value) {
    ElMessage.warning('返利抵扣不能超过供应商返利余额')
    return
  }

  submitLoading.value = true
  try {
    const selectedGoodsType = goodsTypeOptions.value.find(item => item.name === requestForm.productType)
    const data = {
      supplierId: requestForm.supplierId,
      invoiceType: requestForm.invoiceType,
      paymentMethod: requestForm.paymentMethod,
      goodsTypeId: selectedGoodsType?.goods_type_id || '',
      productType: requestForm.productType,
      remark: requestForm.remark,
      rebateDeduction: rebateDeductionAmount.value,
      items: requestForm.items.map(item => ({
      productId: item.productId,
      productName: item.productName,
      productCode: item.productCode,
      manufacturerCode: item.manufacturerCode,
        price: item.price,
        quantity: item.quantity,
        goodsTypeId: selectedGoodsType?.goods_type_id || '',
        productType: requestForm.productType,
        rebateDeduction: Math.min(toNumber(item.rebateDeduction), itemSubtotal(item)),
        storeAllocations: item.storeAllocations,
        selectedResourceTypes: item.selectedResourceTypes || []
      }))
    }
    data.requestId = requestForm.requestId || undefined
    const res = await api.createPurchaseRequest(data)
    if (res.code === 0) {
      ElMessage.success('提交成功')
      clearDraft(PURCHASE_REQUEST_DRAFT_KEY)
      requestDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    ElMessage.error('提交失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  requestForm.requestId = ''
  requestForm.supplierId = ''
  requestForm.invoiceType = ''
  requestForm.paymentMethod = 'COMPANY_CREDIT'
  requestForm.productType = goodsTypeOptions.value[0]?.name || ''
  requestForm.operatorStaffId = ''
  requestForm.remark = ''
  requestForm.rebateDeduction = 0
  requestForm.items = []
}

const savePurchaseRequestDraft = async () => {
  submitLoading.value = true
  try {
    const selectedGoodsType = goodsTypeOptions.value.find(item => item.name === requestForm.productType)
    const res = await api.savePurchaseRequestDraft({
      requestId: requestForm.requestId || undefined,
      supplierId: requestForm.supplierId || '',
      invoiceType: requestForm.invoiceType,
      paymentMethod: requestForm.paymentMethod,
      goodsTypeId: selectedGoodsType?.goods_type_id || '',
      productType: requestForm.productType,
      operatorStaffId: requestForm.operatorStaffId || '',
      remark: requestForm.remark,
      items: requestForm.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        productCode: item.productCode,
        manufacturerCode: item.manufacturerCode,
        pnCode: item.pnCode,
        price: item.price,
        quantity: item.quantity,
        storeAllocations: item.storeAllocations,
        selectedResourceTypes: item.selectedResourceTypes || []
      }))
    })
    if (res.code !== 0) throw new Error(res.message || '草稿保存失败')
    requestForm.requestId = res.requestId || requestForm.requestId
    clearDraft(PURCHASE_REQUEST_DRAFT_KEY)
    ElMessage.success('采购申请草稿已保存')
    await loadData()
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '草稿保存失败')
  } finally {
    submitLoading.value = false
  }
}

const restorePurchaseRequestDraft = () => {
  const draft = loadDraft(PURCHASE_REQUEST_DRAFT_KEY)
  if (!draft) return
  Object.assign(requestForm, draft)
  requestForm.requestId = ''
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

const handleAllocateStore = (row, index) => {
  const totalQuantity = toQuantity(row.quantity)
  if (totalQuantity <= 0) {
    ElMessage.warning('请先输入商品数量')
    return
  }
  
  const product = products.value.find(p => p.product_id === row.productId)
  currentAllocateProduct.value = {
    ...row,
    quantity: totalQuantity,
    productName: product?.name || ''
  }
  currentAllocateIndex.value = index
  
  storeAllocationList.value = allStores.value.map(store => {
    const existing = row.storeAllocations?.find(a => a.storeId === store.store_id)
    return {
      storeId: store.store_id,
      storeName: store.name,
      quantity: normalizeAllocationQuantity(existing?.quantity, totalQuantity)
    }
  })
  
  allocateDialogVisible.value = true
}

const validateAllocation = () => {
  if (allocatedTotalQuantity.value > toQuantity(currentAllocateProduct.value?.quantity)) {
    ElMessage.warning('分配数量不能超过总数量')
  }
}

const handleSaveAllocation = () => {
  const totalAllocated = allocatedTotalQuantity.value
  const totalQuantity = toQuantity(currentAllocateProduct.value?.quantity)
  
  if (totalAllocated > totalQuantity) {
    ElMessage.warning('分配数量不能超过总数量')
    return
  }
  
  const validAllocations = storeAllocationList.value
    .map(a => ({ ...a, quantity: toQuantity(a.quantity) }))
    .filter(a => a.quantity > 0)
  
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
</script>

<style scoped>
.product-code-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  color: #606266;
  font-size: 11px;
  line-height: 16px;
}

.multiline-summary {
  white-space: pre-line;
  line-height: 1.45;
}

.product-full-name {
  flex-basis: 100%;
  color: #303133;
  white-space: normal;
  word-break: break-all;
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
