<template>
  <div class="sales-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>销售订单</span>
          <div v-if="!traceReadonly" class="sales-actions">
            <el-button @click="openDepositManager">定金管理</el-button>
            <el-button type="primary" @click="handleCreate">新建订单</el-button>
            <el-button v-if="canExportOrders" :loading="exporting" @click="handleExport">导出订单</el-button>
          </div>
        </div>
      </template>

      <div v-if="!traceReadonly" class="filter-bar">
        <el-select v-model="queryParams.storeId" placeholder="门店" clearable class="sales-filter-control" v-loading="storesLoading">
          <el-option label="全部门店" :value="''" />
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
        </el-select>
        <el-input v-model="queryParams.submitUser" placeholder="提交人" clearable class="sales-filter-control" @keyup.enter="handleSearch" />
        <el-input v-model="queryParams.customerName" placeholder="客户姓名" clearable class="sales-filter-control" @keyup.enter="handleSearch" />
        <el-input v-model="queryParams.orderNo" placeholder="订单号" clearable class="sales-filter-control" @keyup.enter="handleSearch" />
        <el-input v-model="queryParams.productName" placeholder="商品名称（模糊查找）" clearable class="sales-filter-product" @keyup.enter="handleSearch" />
        <el-input v-model="queryParams.productCode" placeholder="商品编码" clearable class="sales-filter-control" @keyup.enter="handleSearch" />
        <el-select v-model="queryParams.status" placeholder="状态" clearable class="sales-filter-status">
          <el-option label="全部" value="" />
          <el-option label="草稿" value="draft" />
          <el-option label="待审批" value="pending_approval" />
          <el-option label="未归档" value="未归档" />
          <el-option label="已归档" value="已归档" />
          <el-option label="已取消" value="cancelled" />
          <el-option label="退库处理中" value="return_pending" />
          <el-option label="已退单" value="returned" />
          <el-option label="已完成（历史）" value="completed" />
          <el-option label="定金收款" value="deposit" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          clearable
          class="sales-filter-date"
        />
        <el-button type="primary" :loading="loading" @click="handleSearch">搜索</el-button>
      </div>

      <div v-if="!traceReadonly" class="sales-table-scroll">
        <table class="sales-order-table">
          <thead>
            <tr>
              <th class="order-no-column">订单号</th>
              <th>业务类型</th>
              <th>门店</th>
              <th>创建时间</th>
              <th>提交人</th>
              <th>客户姓名</th>
              <th>联系电话</th>
              <th class="money-column">订单金额</th>
              <th class="money-column">实付金额</th>
              <th>状态</th>
              <th class="operation-column">操作</th>
            </tr>
          </thead>
          <tbody v-if="!loading && tableData.length">
            <tr v-for="row in tableData" :key="row.order_id">
              <td class="order-no-cell"><span class="order-no-text">{{ row.order_no || '-' }}</span></td>
              <td>{{ row.record_type === 'deposit' ? '定金收款' : '销售订单' }}</td>
              <td>{{ row.Store?.name || '-' }}</td>
              <td>{{ formatDate(row.create_time) }}</td>
              <td>{{ row.submit_user || row.create_user || '-' }}</td>
              <td>{{ row.customer_name || '-' }}</td>
              <td>{{ row.customer_phone || '-' }}</td>
              <td class="money-column">¥{{ row.total_amount || 0 }}</td>
              <td class="money-column">¥{{ row.actual_payment || 0 }}</td>
              <td><el-tag :type="getStatusType(row.order_status)">{{ getStatusText(row.order_status) }}</el-tag></td>
              <td class="operation-column">
              <el-button link type="primary" @click="handleEditDraft(row)" v-if="!row.record_type && row.order_status === 'draft'">编辑</el-button>
              <el-button link type="success" @click="handleSubmitDraft(row)" v-if="!row.record_type && row.order_status === 'draft'">提交</el-button>
              <el-button link type="danger" @click="handleDeleteDraft(row)" v-if="!row.record_type && row.order_status === 'draft' && !row.submit_time">删除</el-button>
              <el-button link type="success" @click="handleArchive(row)" v-if="!row.record_type && row.order_status === '未归档'">归档</el-button>
              <el-button link type="primary" @click="handleView(row)">查看</el-button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="loading" class="sales-table-state">正在加载销售订单...</div>
        <div v-else-if="tableData.length === 0" class="sales-table-state">暂无销售订单</div>
      </div>

      <el-pagination
        v-if="!traceReadonly"
        v-model:current-page="queryParams.page"
        v-model:page-size="queryParams.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>

    <!-- 新建/编辑订单对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="950px" class="sales-order-dialog" @close="handleDialogClose">
      <el-form :model="orderForm" label-width="90px">
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="门店">
              <el-select v-model="orderForm.storeId" placeholder="选择门店" :disabled="isStoreUser()" v-loading="storesLoading">
                <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="客户姓名">
              <el-input v-model="orderForm.customerName" placeholder="请输入客户姓名" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="联系电话">
              <el-input v-model="orderForm.customerPhone" placeholder="请输入联系电话" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="客户来源">
              <div style="display: flex; gap: 8px">
                <el-select v-model="orderForm.customerSourceL1" placeholder="一级来源" clearable style="width: 140px" @change="onCustomerSourceL1Change">
                  <el-option v-for="cs in customerSourceL1List" :key="cs.source_id" :label="cs.name" :value="cs.source_id" />
                </el-select>
                <el-select v-model="orderForm.customerSourceL2" placeholder="二级来源" clearable style="width: 140px" :disabled="!orderForm.customerSourceL1">
                  <el-option v-for="cs in customerSourceL2Options" :key="cs.source_id" :label="cs.name" :value="cs.source_id" />
                </el-select>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="发票类型">
              <el-select v-model="orderForm.invoiceStatus" placeholder="请选择">
                <el-option label="不开票" value="不开票" />
                <el-option label="普通发票" value="普通发票" />
                <el-option label="增值税发票" value="增值税发票" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 商品明细 -->
        <el-form-item label="商品明细" class="product-details-item">
          <div class="items-table">
            <el-table :data="orderForm.items" border size="small" scrollbar-always-on>
              <el-table-column label="商品名称" min-width="200">
                <template #default="{ row, $index }">
                  <el-select
                    v-model="row.productId"
                    filterable
                    remote
                    reserve-keyword
                    placeholder="输入名称/编码搜索"
                    :remote-method="(q) => remoteSearchProduct(q, $index)"
                    :loading="row.searchLoading"
                    clearable
                    value-key="product_id"
                    style="width: 100%"
                    @change="(val) => onProductChange(val, $index)"
                  >
                    <el-option
                      v-for="p in row.searchOptions"
                      :key="p.product_id"
                      :label="formatProductOptionLabel(p)"
                      :value="p.product_id"
                    />
                  </el-select>
                  <el-tag v-if="row.needSn" type="warning" size="small" class="ml-5">SN管理</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="PN码" width="140">
                <template #default="{ row, $index }">
                  <el-select
                    v-model="row.pnCode"
                    placeholder="选择PN"
                    size="small"
                    clearable
                    filterable
                    style="width: 100%"
                    :loading="row.pnLoading"
                    @change="onPnChange($index)"
                    @blur="onPnBlur($index)"
                  >
                    <el-option v-for="pn in (row.pnList || [])" :key="pn" :label="pn" :value="pn" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="SN码" width="200">
                <template #default="{ row, $index }">
                  <el-select
                    v-if="row.needSn"
                    v-model="row.snCode"
                    placeholder="选择SN"
                    size="small"
                    clearable
                    filterable
                    :loading="row.snLoading"
                    style="width: 100%"
                    @change="(val) => onSnChange(val, $index)"
                  >
                    <el-option
                      v-for="sn in (row.snList || [])"
                      :key="sn.sn_id || sn.sn_code"
                      :label="sn.sn_code"
                      :value="sn.sn_code"
                    />
                    <el-option
                      v-if="row.snCode && !(row.snList || []).some(sn => sn.sn_code === row.snCode)"
                      :key="`current-${row.snCode}`"
                      :label="row.snCode"
                      :value="row.snCode"
                    />
                  </el-select>
                  <span v-else class="muted">无需SN</span>
                </template>
              </el-table-column>
              <el-table-column label="货品销售标签 / 可用权益" min-width="250">
                <template #default="{ row }">
                  <template v-if="row.selectedSn">
                    <div><el-tag size="small" :type="row.selectedSn.warning_message ? 'warning' : 'success'">{{ row.selectedSn.sales_resource_label }}</el-tag></div>
                    <div class="resource-checks">
                      <el-checkbox-group v-model="row.selectedResourceTypes">
                        <el-checkbox v-for="resource in saleResourceCategories" :key="resource.category_code" :value="resource.category_code" :disabled="!resourceAvailable(row, resource.category_code)">{{ resource.short_name || resource.name }}</el-checkbox>
                      </el-checkbox-group>
                    </div>
                    <div v-if="row.selectedSn.warning_message" class="resource-warning">{{ row.selectedSn.warning_message }}</div>
                  </template>
                  <span v-else class="muted">选择SN后自动显示</span>
                </template>
              </el-table-column>
              <el-table-column label="单价" width="120">
                <template #default="{ row }">
                  <el-input v-model="row.salePrice" size="small" style="width: 100%" />
                </template>
              </el-table-column>
              <el-table-column label="数量" width="70">
                <template #default="{ row }">
                  <el-input v-model="row.quantity" size="small" style="width: 60px" />
                </template>
              </el-table-column>
              <el-table-column label="小计" width="90">
                <template #default="{ row }">
                  ¥{{ ((row.salePrice || 0) * (row.quantity || 1)).toFixed(2) }}
                </template>
              </el-table-column>
              <el-table-column label="操作" width="60">
                <template #default="{ $index }">
                  <el-button link type="danger" @click="removeItem($index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-button type="primary" size="small" @click="addItem" class="mt-10">添加商品</el-button>
          </div>
        </el-form-item>

        <!-- 补贴信息 -->
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="国补金额">
              <el-input v-model="orderForm.nationalSubsidy" placeholder="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="教补金额">
              <el-input v-model="orderForm.educationSubsidy" placeholder="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="折扣金额">
              <el-input v-model="orderForm.discountAmount" placeholder="0" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 支付方式 -->
        <el-form-item label="支付方式">
          <div class="payment-methods">
            <el-checkbox-group v-model="selectedPayments">
              <el-checkbox v-for="pm in paymentMethods" :key="pm.method_id" :label="pm.name">
                {{ pm.name }}
              </el-checkbox>
            </el-checkbox-group>
            <div class="payment-amounts mt-10">
              <template v-for="pm in selectedPayments" :key="pm">
                <div v-if="isDepositPaymentName(pm)" class="deposit-payment-row">
                  <el-select
                    v-model="orderForm.depositId"
                    placeholder="选择待核销定金单"
                    filterable
                    style="width: 320px"
                    :loading="depositLoading"
                    @visible-change="(visible) => visible && loadAvailableDeposits()"
                    @change="onDepositChange"
                  >
                    <el-option
                      v-for="deposit in availableDepositList"
                      :key="deposit.deposit_id"
                      :label="`${deposit.deposit_no} ${deposit.customer_name} ¥${deposit.available_amount || deposit.amount}`"
                      :value="deposit.deposit_id"
                    />
                  </el-select>
                  <el-input
                    v-model="paymentAmounts[pm]"
                    disabled
                    placeholder="定金金额"
                    style="width: 150px"
                  />
                </div>
                <el-input
                  v-else
                  v-model="paymentAmounts[pm]"
                  :placeholder="getPaymentName(pm)"
                  style="width: 150px; margin-right: 10px"
                />
              </template>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="orderForm.remark" type="textarea" :rows="2" />
        </el-form-item>

        <div class="order-summary">
          <div class="summary-item">商品总额: <span>¥{{ totalAmount.toFixed(2) }}</span></div>
          <div class="summary-item">国补: <span>-¥{{ orderForm.nationalSubsidy.toFixed(2) }}</span></div>
          <div class="summary-item">教补: <span>-¥{{ orderForm.educationSubsidy.toFixed(2) }}</span></div>
          <div class="summary-item">折扣: <span>-¥{{ orderForm.discountAmount.toFixed(2) }}</span></div>
          <div class="summary-item" v-if="selectedDeposit">定金抵扣: <span>-¥{{ Number(selectedDeposit.available_amount || selectedDeposit.amount || 0).toFixed(2) }}</span></div>
          <div class="summary-item total">实付金额: <span>¥{{ actualPayment.toFixed(2) }}</span></div>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveOrderDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 订单详情对话框 -->
    <el-dialog v-model="detailVisible" :title="currentOrder?.record_type === 'deposit' ? '定金收款详情' : '订单详情'" width="1000px">
      <div v-if="currentOrder" class="order-detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单号">{{ currentOrder.order_no }}</el-descriptions-item>
          <el-descriptions-item label="订单状态">
            <el-tag :type="getStatusType(currentOrder.order_status)">{{ getStatusText(currentOrder.order_status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="门店">{{ currentOrder.Store?.name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="客户姓名">{{ currentOrder.customer_name }}</el-descriptions-item>
          <el-descriptions-item label="联系电话">{{ currentOrder.customer_phone }}</el-descriptions-item>
          <el-descriptions-item label="客户来源">{{ currentOrder.customer_source || '-' }}</el-descriptions-item>
          <el-descriptions-item label="发票类型">{{ currentOrder.invoice_status }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDate(currentOrder.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="提交人">{{ currentOrder.submit_user || currentOrder.create_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatDate(currentOrder.submit_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批人">{{ currentOrder.approve_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="审批时间">{{ formatDate(currentOrder.approve_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批意见" :span="2">{{ currentOrder.approve_comment || '-' }}</el-descriptions-item>
          <el-descriptions-item label="商品总额">¥{{ currentOrder.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="实付金额">¥{{ currentOrder.actual_payment }}</el-descriptions-item>
          <el-descriptions-item label="国补">¥{{ currentOrder.national_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="教补">¥{{ currentOrder.education_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentOrder.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">流程记录</h4>
        <el-timeline v-if="currentOrder.action_logs?.length">
          <el-timeline-item v-for="log in currentOrder.action_logs" :key="log.log_id" :timestamp="formatDate(log.create_time)">
            <strong>{{ actionLabel(log.action) }}</strong>
            <span style="margin-left: 10px; color: #606266">{{ log.actor_name || '-' }}</span>
            <span v-if="log.comment" style="margin-left: 10px; color: #909399">{{ log.comment }}</span>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无流程记录" :image-size="60" />

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentOrder.OrderItems || []" border size="small">
          <el-table-column prop="product_name" label="商品名称" />
          <el-table-column prop="pn_code" label="PN码" width="120" />
          <el-table-column prop="sn_code" label="SN码" width="150" />
          <el-table-column label="货品销售标签" min-width="190"><template #default="{row}">
            <el-tag v-if="row.resource_summary">{{ row.resource_summary.sales_resource_label }}</el-tag>
            <span v-else>-</span>
          </template></el-table-column>
          <el-table-column prop="sale_price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.sale_price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column prop="subtotal" label="小计" width="100">
            <template #default="{ row }">¥{{ row.subtotal }}</template>
          </el-table-column>
          <el-table-column v-if="orderCanSeeOriginalCost" prop="original_inventory_cost" label="原始成本" width="100">
            <template #default="{ row }">{{ row.original_inventory_cost === undefined ? '-' : `¥${row.original_inventory_cost || 0}` }}</template>
          </el-table-column>
          <el-table-column v-if="orderHasSettlementCost" prop="cost_adjustment_amount" label="政策调整" width="100">
            <template #default="{ row }">{{ row.sales_settlement_cost === null || row.sales_settlement_cost === undefined ? '-' : `-¥${row.cost_adjustment_amount || 0}` }}</template>
          </el-table-column>
          <el-table-column v-if="orderHasSettlementCost" prop="sales_settlement_cost" label="结算成本" width="100">
            <template #default="{ row }">{{ row.sales_settlement_cost === null || row.sales_settlement_cost === undefined ? '-' : `¥${row.sales_settlement_cost || 0}` }}</template>
          </el-table-column>
          <el-table-column v-if="orderHasSettlementCost" prop="sales_gross_profit" label="销售毛利" width="100">
            <template #default="{ row }">{{ row.sales_gross_profit === null || row.sales_gross_profit === undefined ? '-' : `¥${row.sales_gross_profit || 0}` }}</template>
          </el-table-column>
        </el-table>

        <h4 class="mt-20" v-if="currentOrder.OrderPayments?.length">支付记录</h4>
        <el-table :data="currentOrder.OrderPayments || []" border size="small">
          <el-table-column prop="payment_method" label="支付方式" />
          <el-table-column label="绑定定金单" width="190">
            <template #default="{ row }">{{ row.DepositOrder?.deposit_no || '-' }}</template>
          </el-table-column>
          <el-table-column prop="amount" label="金额" width="120">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="payment_time" label="支付时间" width="160" />
        </el-table>
      </div>
    </el-dialog>

    <!-- 拒绝原因对话框 -->
    <el-dialog v-model="rejectDialogVisible" title="拒绝原因" width="500px">
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="请输入拒绝原因" />
      <template #footer>
        <el-button @click="rejectDialogVisible = false">取消</el-button>
        <el-button type="danger" @click="confirmReject" :loading="rejectLoading">确认拒绝</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="depositDialogVisible" title="定金管理" width="1050px">
      <div class="filter-bar">
        <el-select v-model="depositQuery.status" placeholder="状态" clearable style="width: 140px">
          <el-option label="全部" value="" />
          <el-option label="可使用" value="available" />
          <el-option label="已提交" value="submitted" />
          <el-option label="已归档" value="archived" />
          <el-option label="已核销" value="redeemed" />
          <el-option label="已退款" value="refunded" />
        </el-select>
        <el-input v-model="depositQuery.customerPhone" placeholder="客户电话" clearable style="width: 180px" />
        <el-button type="primary" @click="loadDeposits">搜索</el-button>
        <el-button type="primary" @click="openDepositCreate">新建定金单</el-button>
      </div>
      <el-table :data="depositList" border stripe v-loading="depositListLoading">
        <el-table-column prop="deposit_no" label="定金单号" width="180" />
        <el-table-column label="门店" width="130">
          <template #default="{ row }">{{ row.Store?.name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="customer_name" label="客户" width="100" />
        <el-table-column prop="customer_phone" label="电话" width="120" />
        <el-table-column prop="amount" label="金额" width="100">
          <template #default="{ row }">¥{{ row.amount }}</template>
        </el-table-column>
        <el-table-column prop="payment_method" label="收款方式" width="130" />
        <el-table-column prop="create_user" label="收定金人" width="100" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getDepositStatusType(row.status)">{{ getDepositStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="create_time" label="创建时间" width="160">
          <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" fixed="right" width="160">
          <template #default="{ row }">
            <el-button v-if="row.status === 'submitted'" link type="success" @click="archiveDeposit(row)">归档</el-button>
            <el-button v-if="['available', 'submitted', 'archived'].includes(row.status)" link type="danger" @click="refundDeposit(row)">退款</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-model:current-page="depositQuery.page"
        v-model:page-size="depositQuery.pageSize"
        :total="depositTotal"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadDeposits"
        @current-change="loadDeposits"
      />
    </el-dialog>

    <el-dialog v-model="depositCreateVisible" title="新建定金单" width="560px" @close="resetDepositForm">
      <el-form :model="depositForm" label-width="90px">
        <el-form-item label="门店">
          <el-select v-model="depositForm.storeId" placeholder="选择门店" :disabled="isStoreUser()" v-loading="storesLoading">
            <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="客户姓名">
          <el-input v-model="depositForm.customerName" placeholder="请输入客户姓名" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="depositForm.customerPhone" placeholder="请输入联系电话" />
        </el-form-item>
        <el-form-item label="定金金额">
          <el-input v-model="depositForm.amount" placeholder="请输入定金金额" />
        </el-form-item>
        <el-form-item label="收款方式">
          <el-select v-model="depositForm.paymentMethod" placeholder="请选择收款方式" style="width: 100%">
            <el-option
              v-for="method in depositPaymentMethods"
              :key="method.method_id || method.name"
              :label="method.name"
              :value="method.name"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="depositForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="depositCreateVisible = false">取消</el-button>
        <el-button type="primary" @click="submitDeposit" :loading="depositSubmitLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { getStoreId, isStoreUser, isDistributorAccount, hasRole } from '../utils/user'

const route = useRoute()
const traceReadonly = computed(() => Boolean(route.query.orderId) && String(route.query.trace || '') === '1')
const stores = ref([])
const storesLoaded = ref(false)
const storesLoading = ref(false)
const paymentMethods = ref([])
const tableData = ref([])
const total = ref(0)
const loading = ref(false)
const exporting = ref(false)

const dialogVisible = ref(false)
const detailVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新建订单')
const currentOrder = ref(null)

const canExportOrders = computed(() => isDistributorAccount() || hasRole(['manager', 'store_manager']))
const actionLabel = (action) => ({
  created: '创建订单',
  draft_created: '创建销售草稿',
  draft_saved: '保存销售草稿',
  submitted: '提交订单',
  approved: '审批通过',
  approved_and_archived: '审批通过并自动归档',
  rejected: '审批拒绝',
  archive_pending_approval: '归档待审批',
  archived: '订单归档',
  cancelled: '订单取消',
  deleted: '删除草稿',
  status_updated: '状态变更'
}[action] || action || '操作')
const orderHasSettlementCost = computed(() => {
  return (currentOrder.value?.OrderItems || []).some(item => item.sales_settlement_cost !== null && item.sales_settlement_cost !== undefined)
})
const orderCanSeeOriginalCost = computed(() => {
  return (currentOrder.value?.OrderItems || []).some(item => item.original_inventory_cost !== undefined)
})

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  storeId: '',
  status: '',
  submitUser: '',
  customerName: '',
  orderNo: '',
  productName: '',
  productCode: ''
})
const dateRange = ref([])

const selectedPayments = ref([])
const paymentAmounts = reactive({})
const availableDepositList = ref([])
const depositLoading = ref(false)
const depositDialogVisible = ref(false)
const depositCreateVisible = ref(false)
const depositListLoading = ref(false)
const depositSubmitLoading = ref(false)
const depositList = ref([])
const depositTotal = ref(0)

const depositQuery = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  customerPhone: ''
})

const depositForm = reactive({
  storeId: '',
  customerName: '',
  customerPhone: '',
  amount: '',
  paymentMethod: '',
  remark: ''
})

const orderForm = reactive({
  orderId: null,
  storeId: '',
  customerName: '',
  customerPhone: '',
  customerSource: '',
  customerSourceL1: '',
  customerSourceL2: '',
  invoiceStatus: '不开票',
  depositId: '',
  items: [],
  nationalSubsidy: 0,
  educationSubsidy: 0,
  discountAmount: 0,
  remark: ''
})
const saleResourceCategories = ref([])

const rejectDialogVisible = ref(false)
const rejectLoading = ref(false)
const rejectReason = ref('')
const rejectOrderId = ref('')

const totalAmount = computed(() => {
  return orderForm.items.reduce((sum, item) => {
    return sum + ((item.salePrice || 0) * (item.quantity || 1))
  }, 0)
})

const actualPayment = computed(() => {
  return Math.max(0, totalAmount.value - (orderForm.nationalSubsidy || 0) - (orderForm.educationSubsidy || 0) - (orderForm.discountAmount || 0))
})

const selectedDeposit = computed(() => {
  return availableDepositList.value.find(item => item.deposit_id === orderForm.depositId) || null
})

onMounted(async () => {
  if (traceReadonly.value) {
    await openRouteOrderDetail()
    return
  }
  if (isStoreUser()) {
    queryParams.storeId = getStoreId()
  }
  await Promise.allSettled([
    loadData(),
    loadStores(),
    loadPaymentMethods(),
    loadCustomerSources(),
    loadSaleResourceCategories()
  ])
  await openRouteOrderDetail()
})

const loadSaleResourceCategories = async () => {
  try {
    const res = await api.getResourceCategories({ activeOnly: 1 })
    const rows = Array.isArray(res?.data) ? res.data : []
    saleResourceCategories.value = rows.filter(item => item.supports_sale_use)
  } catch (error) {
    console.error('[Sales] 加载资源类别失败:', error)
    saleResourceCategories.value = []
  }
}

watch(() => route.query.orderId, () => {
  openRouteOrderDetail()
})

watch(selectedPayments, (payments) => {
  const hasDeposit = payments.some(isDepositPaymentName)
  if (hasDeposit) {
    loadAvailableDeposits()
  } else {
    orderForm.depositId = ''
    Object.keys(paymentAmounts).forEach(key => {
      if (isDepositPaymentName(key)) delete paymentAmounts[key]
    })
  }
})

watch(() => [orderForm.customerPhone, orderForm.storeId], () => {
  if (selectedPayments.value.some(isDepositPaymentName)) {
    orderForm.depositId = ''
    Object.keys(paymentAmounts).forEach(key => {
      if (isDepositPaymentName(key)) paymentAmounts[key] = 0
    })
    loadAvailableDeposits()
  }
})

const getSalesQueryParams = (includePagination = true) => {
  const [startDate, endDate] = Array.isArray(dateRange.value) ? dateRange.value : []
  const params = {
    storeId: queryParams.storeId || undefined,
    status: queryParams.status || undefined,
    submitUser: queryParams.submitUser || undefined,
    customerName: queryParams.customerName || undefined,
    orderNo: queryParams.orderNo || undefined,
    productName: queryParams.productName || undefined,
    productCode: queryParams.productCode || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined
  }
  if (includePagination) {
    params.page = queryParams.page
    params.pageSize = queryParams.pageSize
  }
  return params
}

const handleSearch = () => {
  queryParams.page = 1
  loadData()
}

const loadData = async () => {
  if (loading.value) return
  loading.value = true
  try {
    const res = await api.getSalesList(getSalesQueryParams())
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载销售数据失败: ' + (err.message || ''))
  } finally {
    loading.value = false
  }
}

const handleExport = async () => {
  if (exporting.value) return
  exporting.value = true
  try {
    await api.exportSales(getSalesQueryParams(false))
    ElMessage.success('订单导出成功')
  } catch (err) {
    ElMessage.error(err.message || '订单导出失败')
  } finally {
    exporting.value = false
  }
}

const loadStores = async () => {
  if (storesLoaded.value) return stores.value
  storesLoading.value = true
  try {
    const res = await api.getAllStores()
    if (res && res.code === 0 && Array.isArray(res.data)) {
      stores.value = res.data
      storesLoaded.value = true
      return stores.value
    } else {
      stores.value = []
      return []
    }
  } catch (err) {
    ElMessage.error('加载门店列表失败: ' + (err.message || ''))
    stores.value = []
    return []
  } finally {
    storesLoading.value = false
  }
}

const loadPaymentMethods = async () => {
  try {
    const res = await api.getPaymentMethods()
    if (res.code === 0) {
      paymentMethods.value = res.data || []
      ensureDepositPaymentMethod()
    }
  } catch (err) {
    paymentMethods.value = [
      { method_id: '1', code: 'cash', name: '现金' },
      { method_id: '2', code: 'wechat', name: '微信支付' },
      { method_id: '3', code: 'alipay', name: '支付宝' },
      { method_id: '4', code: 'bank', name: '银行转账' },
      { method_id: 'PM_DEPOSIT', code: 'deposit', name: '定金' }
    ]
  }
}

const ensureDepositPaymentMethod = () => {
  if (!paymentMethods.value.some(pm => isDepositPaymentName(pm.name) || pm.code === 'deposit')) {
    paymentMethods.value.push({ method_id: 'PM_DEPOSIT', code: 'deposit', name: '定金' })
  }
}

const customerSourceL1List = ref([])
const customerSourceL2Options = ref([])

const loadCustomerSources = async () => {
  try {
    const res = await api.getCustomerSourceTree()
    if (res.code === 0) {
      customerSourceL1List.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load customer sources')
  }
}

const onCustomerSourceL1Change = (l1Id) => {
  orderForm.customerSourceL2 = ''
  if (l1Id) {
    const parent = customerSourceL1List.value.find(cs => cs.source_id === l1Id)
    customerSourceL2Options.value = parent?.children || []
  } else {
    customerSourceL2Options.value = []
  }
}

const getPaymentName = (name) => {
  const pm = paymentMethods.value.find(p => p.name === name)
  return pm ? pm.name : name
}

const isDepositPaymentName = (name) => {
  const value = String(name || '').trim().toLowerCase()
  return value === '定金' || value === 'deposit'
}

const depositPaymentMethods = computed(() => paymentMethods.value.filter(method => {
  const name = String(method.name || '')
  return !isDepositPaymentName(name) && !name.includes('政策补贴应收') && !name.includes('客户实收')
}))

const loadAvailableDeposits = async () => {
  if (!orderForm.customerPhone || !orderForm.storeId) {
    availableDepositList.value = []
    return
  }
  depositLoading.value = true
  try {
    const res = await api.getAvailableDeposits({
      customerPhone: orderForm.customerPhone,
      storeId: orderForm.storeId
    })
    if (res.code === 0) {
      availableDepositList.value = res.data || []
      if (orderForm.depositId) onDepositChange(orderForm.depositId)
    }
  } catch (err) {
    availableDepositList.value = []
  } finally {
    depositLoading.value = false
  }
}

const onDepositChange = (depositId) => {
  const deposit = availableDepositList.value.find(item => item.deposit_id === depositId)
  const methodName = selectedPayments.value.find(isDepositPaymentName) || '定金'
  paymentAmounts[methodName] = deposit ? Number(deposit.available_amount || deposit.amount || 0).toFixed(2) : 0
}

const handleCreate = async () => {
  await loadStores()
  if (!stores.value.length) {
    ElMessage.warning('当前账号没有可选门店，请先配置门店权限')
    return
  }
  dialogTitle.value = '新建订单'
  resetForm()
  if (isStoreUser()) {
    orderForm.storeId = getStoreId()
  }
  dialogVisible.value = true
}

const handleView = async (row) => {
  if (row.record_type === 'deposit') {
    currentOrder.value = {
      ...row,
      OrderItems: [],
      OrderPayments: [{
        payment_method: row.payment_method,
        amount: row.amount,
        payment_time: row.create_time
      }],
      action_logs: []
    }
    detailVisible.value = true
    return
  }
  await openOrderDetail(row.order_id)
}

const handleArchive = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认归档销售订单 ${row.order_no || ''}？归档后将执行库存、SN、毛利、返利和结算校验。`,
      '归档确认',
      { type: 'warning', confirmButtonText: '确认归档', cancelButtonText: '取消' }
    )
    const res = await api.updateSales(row.order_id, { order_status: '已归档' })
    if (res.status === 'pending_approval' || res.pendingApproval) {
      ElMessage.warning(res.message || '订单已进入负毛利审批')
    } else if (res.status === '已归档' || res.code === 0) {
      ElMessage.success(res.message || '订单已归档')
    } else {
      ElMessage.error(res.message || '归档失败')
    }
    await loadData()
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err.response?.data?.message || '归档失败')
  }
}

const openDepositManager = () => {
  depositDialogVisible.value = true
  loadDeposits()
}

const loadDeposits = async () => {
  depositListLoading.value = true
  try {
    const params = { ...depositQuery }
    const res = await api.getDepositList(params)
    if (res.code === 0) {
      depositList.value = res.data?.list || []
      depositTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载定金单失败')
  } finally {
    depositListLoading.value = false
  }
}

const openDepositCreate = async () => {
  await loadStores()
  if (!stores.value.length) {
    ElMessage.warning('当前账号没有可选门店，请先配置门店权限')
    return
  }
  resetDepositForm()
  if (isStoreUser()) {
    depositForm.storeId = getStoreId()
  }
  depositCreateVisible.value = true
}

const resetDepositForm = () => {
  depositForm.storeId = ''
  depositForm.customerName = ''
  depositForm.customerPhone = ''
  depositForm.amount = ''
  depositForm.paymentMethod = ''
  depositForm.remark = ''
}

const submitDeposit = async () => {
  if (!depositForm.storeId) {
    ElMessage.warning('请选择门店')
    return
  }
  if (!depositForm.customerName || !depositForm.customerPhone) {
    ElMessage.warning('请填写客户信息')
    return
  }
  if (Number(depositForm.amount || 0) <= 0) {
    ElMessage.warning('定金金额必须大于0')
    return
  }
  if (!depositForm.paymentMethod) {
    ElMessage.warning('请选择收款方式')
    return
  }
  depositSubmitLoading.value = true
  try {
    const res = await api.createDeposit({
      storeId: depositForm.storeId,
      customerName: depositForm.customerName,
      customerPhone: depositForm.customerPhone,
      amount: depositForm.amount,
      paymentMethod: depositForm.paymentMethod,
      remark: depositForm.remark
    })
    if (res.code === 0) {
      ElMessage.success(res.data?.message || '定金单已提交')
      depositCreateVisible.value = false
      loadDeposits()
    } else {
      ElMessage.error(res.message || '创建定金单失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '创建定金单失败')
  } finally {
    depositSubmitLoading.value = false
  }
}

const archiveDeposit = async (row) => {
  try {
    await ElMessageBox.confirm(`确认归档定金单 ${row.deposit_no}？`, '归档确认', { type: 'warning' })
    const res = await api.archiveDeposit(row.deposit_id)
    if (res.code === 0) {
      ElMessage.success(res.data?.message || '定金单已归档')
      loadDeposits()
    } else {
      ElMessage.error(res.message || '归档失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || '归档失败')
    }
  }
}

const refundDeposit = async (row) => {
  try {
    const { value } = await ElMessageBox.prompt('请输入退款原因', `退款记录 ${row.deposit_no}`, {
      inputType: 'textarea',
      confirmButtonText: '确认',
      cancelButtonText: '取消'
    })
    const res = await api.refundDeposit(row.deposit_id, {
      amount: row.amount,
      reason: value || ''
    })
    if (res.code === 0) {
      ElMessage.success(res.data?.message || '退款记录已生成')
      loadDeposits()
    } else {
      ElMessage.error(res.message || '退款失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || '退款失败')
    }
  }
}

const openRouteOrderDetail = async () => {
  const orderId = route.query.orderId
  if (orderId) {
    await openOrderDetail(orderId)
  }
}

const openOrderDetail = async (orderId) => {
  if (!orderId) return
  try {
    const res = await api.getSalesDetail(orderId, String(route.query.trace || '') === '1' ? { trace: '1' } : undefined)
    if (res.code === 0) {
      currentOrder.value = res.data
      detailVisible.value = true
    } else {
      ElMessage.error(res.message || '加载订单详情失败')
    }
  } catch (err) {
    ElMessage.error('加载订单详情失败')
  }
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  orderForm.orderId = null
  orderForm.storeId = ''
  orderForm.customerName = ''
  orderForm.customerPhone = ''
  orderForm.customerSource = ''
  orderForm.customerSourceL1 = ''
  orderForm.customerSourceL2 = ''
  orderForm.invoiceStatus = '不开票'
  orderForm.depositId = ''
  orderForm.items = []
  orderForm.nationalSubsidy = 0
  orderForm.educationSubsidy = 0
  orderForm.discountAmount = 0
  orderForm.remark = ''
  selectedPayments.value = []
  availableDepositList.value = []
  Object.keys(paymentAmounts).forEach(k => delete paymentAmounts[k])
}

const hydrateDraftForm = (order) => {
  orderForm.orderId = order.order_id
  orderForm.storeId = order.store_id || ''
  orderForm.customerName = order.customer_name || ''
  orderForm.customerPhone = order.customer_phone || ''
  orderForm.customerSource = order.customer_source || ''
  orderForm.invoiceStatus = order.invoice_status || '不开票'
  orderForm.depositId = ''
  orderForm.nationalSubsidy = Number(order.national_subsidy || 0)
  orderForm.educationSubsidy = Number(order.education_subsidy || 0)
  orderForm.discountAmount = Number(order.discount_amount || 0)
  orderForm.remark = order.remark || ''
  orderForm.items = (order.OrderItems || []).map(item => ({
    productId: item.product_id || '',
    productName: item.product_name || '',
    pnCode: item.pn_code || '',
    snCode: item.sn_code || '',
    snId: item.sn_id || '',
    supplierId: item.supplier_id || '',
    supplierName: item.supplier_name || '',
    salePrice: Number(item.sale_price || 0),
    quantity: Number(item.quantity || 1),
    subtotal: Number(item.subtotal || 0),
    needSn: isSnManaged(item.need_sn ?? item.needSn ?? item.Product?.need_sn) || Boolean(item.sn_code || item.sn_id),
    standardPrice: Number(item.sale_price || 0),
    searchLoading: false,
    searchOptions: item.product_id ? [{ product_id: item.product_id, name: item.product_name, need_sn: item.need_sn ?? item.Product?.need_sn }] : [],
    pnList: item.pn_code ? [item.pn_code] : [],
    snList: item.sn_code ? [{ sn_code: item.sn_code, sn_id: item.sn_id || '' }] : [],
    pnLoading: false,
    snLoading: false,
    selectedSn: item.sn_code ? { sn_code: item.sn_code, sn_id: item.sn_id || '' } : null,
    selectedResourceTypes: typeof item.selected_resource_types === 'string' ? (() => { try { return JSON.parse(item.selected_resource_types) } catch (_) { return [] } })() : (item.selected_resource_types || []),
    useGovSubsidy: Boolean(item.use_gov_subsidy),
    useEduSubsidy: Boolean(item.use_edu_subsidy),
    useSalesReport: Boolean(item.use_sales_report)
  }))
  selectedPayments.value = (order.OrderPayments || []).map(payment => payment.payment_method).filter(Boolean)
  Object.keys(paymentAmounts).forEach(key => delete paymentAmounts[key])
  ;(order.OrderPayments || []).forEach(payment => {
    paymentAmounts[payment.payment_method] = Number(payment.amount || 0)
    if (payment.deposit_id) orderForm.depositId = payment.deposit_id
  })
  let depositItems = order.deposit_items
  if (typeof depositItems === 'string') {
    try { depositItems = JSON.parse(depositItems) } catch (_) { depositItems = [] }
  }
  if (Array.isArray(depositItems) && depositItems.length) {
    const deposit = depositItems[0]
    if (!selectedPayments.value.some(isDepositPaymentName)) selectedPayments.value.push('定金')
    paymentAmounts['定金'] = Number(deposit.amount || 0)
    orderForm.depositId = deposit.depositId || deposit.deposit_id || ''
  }
}

const handleEditDraft = async (row) => {
  try {
    const res = await api.getSalesDetail(row.order_id)
    if (res.code !== 0) {
      ElMessage.error(res.message || '加载销售订单草稿失败')
      return
    }
    hydrateDraftForm(res.data)
    dialogTitle.value = '编辑销售订单草稿'
    dialogVisible.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载销售订单草稿失败')
  }
}

const handleSubmitDraft = async (row) => {
  try {
    await ElMessageBox.confirm(`提交销售订单草稿 ${row.order_no}？`, '提交订单', {
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.submitSalesDraft(row.order_id)
    if (res.code === 0) {
      ElMessage.success(res.data?.message || '销售订单已提交')
      await loadData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '提交失败')
  }
}

const handleDeleteDraft = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除销售订单草稿 ${row.order_no}？`, '删除草稿', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.deleteSalesDraft(row.order_id)
    if (res.code === 0) {
      ElMessage.success('销售订单草稿已删除')
      await loadData()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '删除失败')
  }
}

const addItem = () => {
  orderForm.items.push({
    productId: '',
    productName: '',
    pnCode: '',
    snCode: '',
    snId: '',
    supplierId: '',
    supplierName: '',
    salePrice: 0,
    quantity: 1,
    subtotal: 0,
    needSn: false,
    standardPrice: 0,
    searchLoading: false,
    searchOptions: [],
    pnList: [],
    snList: [],
    pnLoading: false,
    snLoading: false,
    selectedSn: null,
    selectedResourceTypes: [],
    useGovSubsidy: false,
    useEduSubsidy: false,
    useSalesReport: false
  })
}

const removeItem = (index) => {
  orderForm.items.splice(index, 1)
}

const remoteSearchProduct = async (query, index) => {
  if (!query || query.trim() === '') {
    orderForm.items[index].searchOptions = []
    return
  }
  orderForm.items[index].searchLoading = true
  try {
    const params = { keyword: query, pageSize: 10 }
    if (orderForm.storeId) params.storeId = orderForm.storeId
    const res = await api.searchProduct(params)
    if (res.code === 0) {
      orderForm.items[index].searchOptions = res.data?.list || []
    } else {
      orderForm.items[index].searchOptions = []
    }
  } catch {
    orderForm.items[index].searchOptions = []
  } finally {
    orderForm.items[index].searchLoading = false
  }
}

const formatProductOptionLabel = (product) => {
  const price = product.standard_price ?? 0
  let stockText = ''
  if (product.current_store_stock_qty > 0) {
    stockText = ` 当前门店库存:${product.current_store_stock_qty}`
  } else if (product.other_store_stock_qty > 0) {
    stockText = ` 其他门店库存:${product.other_store_stock_qty}`
  } else if (product.stock_qty != null || product.total_stock_qty != null) {
    stockText = ' 无库存'
  }
  return `${product.name} [${product.product_code}] ¥${price}${stockText}`
}

const normalizePnCodes = (value) => {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map(v => typeof v === 'string' ? v : (v?.pn_code || v?.pnCode || v?.pn || '')).filter(Boolean)
  }
  return String(value).split(new RegExp('[,\\s\\uFF0C\\u3001]+')).map(v => v.trim()).filter(Boolean)
}

const isSnManaged = (value) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true'

const getMatchedPnCodes = (product) => {
  const codes = [
    ...normalizePnCodes(product?.pn_list),
    ...normalizePnCodes(product?.pnList),
    ...normalizePnCodes(product?.pn_code),
    ...normalizePnCodes(product?.pn),
    ...normalizePnCodes(product?.manufacturer_code),
    ...normalizePnCodes(product?.manufacturerCode)
  ]
  return [...new Set(codes)]
}

const onProductChange = async (productId, index) => {
  const opts = orderForm.items[index].searchOptions || []
  const found = opts.find(p => p.product_id === productId)
  if (found) {
    const matchedPns = getMatchedPnCodes(found)
    orderForm.items[index].productName = found.name
    orderForm.items[index].salePrice = parseFloat(found.standard_price) || 0
    orderForm.items[index].needSn = isSnManaged(found.need_sn)
    orderForm.items[index].standardPrice = parseFloat(found.standard_price) || 0
    orderForm.items[index].pnCode = matchedPns[0] || ''
    orderForm.items[index].snCode = ''
    orderForm.items[index].pnList = matchedPns
    orderForm.items[index].snList = []
    orderForm.items[index].snId = ''
    orderForm.items[index].supplierId = ''
    orderForm.items[index].supplierName = ''
    orderForm.items[index].selectedSn = null
    orderForm.items[index].selectedResourceTypes = []
    orderForm.items[index].useGovSubsidy = false
    orderForm.items[index].useEduSubsidy = false
    orderForm.items[index].useSalesReport = false
    orderForm.items[index].stockQty = found.stock_qty

    if (orderForm.storeId && productId) {
      orderForm.items[index].pnLoading = true
      try {
        console.log('[onProductChange] fetching PNs for store:', orderForm.storeId, 'product:', productId)
        const pnRes = await api.getProductPns(orderForm.storeId, productId)
        console.log('[onProductChange] PN result:', pnRes)
        if (pnRes.code === 0 && pnRes.data && pnRes.data.length > 0) {
          const mergedPns = [...new Set([...matchedPns, ...pnRes.data])]
          orderForm.items[index].pnList = mergedPns
          if (!orderForm.items[index].pnCode) {
            orderForm.items[index].pnCode = mergedPns[0]
          }
          console.log('[onProductChange] set pnList:', mergedPns, 'default pnCode:', orderForm.items[index].pnCode)
          if (isSnManaged(found.need_sn)) {
            console.log('[onProductChange] product needs SN, loading SN list...')
            await loadSnList(index)
          }
        } else if (isSnManaged(found.need_sn) && orderForm.items[index].pnCode) {
          await loadSnList(index)
        }
      } catch (e) { console.error('[onProductChange] error loading PNs:', e) }
      finally { orderForm.items[index].pnLoading = false }
    }

  } else {
    orderForm.items[index].productName = ''
    orderForm.items[index].salePrice = 0
    orderForm.items[index].needSn = false
    orderForm.items[index].pnList = []
  }
}

const loadSnList = async (index) => {
  const item = orderForm.items[index]
  if (!orderForm.storeId || !item.productId) {
    console.log('[loadSnList] skipped, storeId:', orderForm.storeId, 'productId:', item.productId)
    return
  }
  item.snLoading = true
  try {
    console.log('[loadSnList] fetching SNs for store:', orderForm.storeId, 'product:', item.productId, 'pn:', item.pnCode)
    const snRes = await api.getProductSns(orderForm.storeId, item.productId, item.pnCode || '')
    console.log('[loadSnList] result:', snRes)
    if (snRes.code === 0) {
      item.snList = snRes.data || []
      console.log('[loadSnList] loaded', item.snList.length, 'SNs')
    } else {
      console.log('[loadSnList] api error:', snRes.message)
      item.snList = []
    }
  } catch (e) {
    console.error('[loadSnList] exception:', e)
    item.snList = []
  }
  finally { item.snLoading = false }
}

const onPnChange = async (index) => {
  const item = orderForm.items[index]
  item.snCode = ''
  item.snId = ''
  item.supplierId = ''
  item.supplierName = ''
  item.selectedSn = null
  item.selectedResourceTypes = []
  item.useGovSubsidy = false
  item.useEduSubsidy = false
  item.useSalesReport = false
  if (item.needSn) {
    console.log('[onPnChange] PN changed, reloading SN list for pn:', item.pnCode)
    await loadSnList(index)
  }
}

const onSnChange = (value, index) => {
  const item = orderForm.items[index]
  const snCode = String(value || '').trim()
  item.snCode = snCode
  const sn = (item.snList || []).find(row => row.sn_code === snCode)
  item.snId = sn?.sn_id || ''
  item.supplierId = sn?.supplier_id || ''
  item.supplierName = sn?.supplier_name || ''
  item.selectedSn = sn || null
  item.salePrice = sn
    ? (parseFloat(sn.effective_sale_price) || item.standardPrice || 0)
    : (item.standardPrice || 0)
  item.selectedResourceTypes = []
  item.useGovSubsidy = false
  item.useEduSubsidy = false
  item.useSalesReport = false
}

const resourceAvailable = (item, type) => {
  return item.selectedSn?.rights?.some(right => right.resource_type === type && right.current_status === 'AVAILABLE') || false
}

const onPnBlur = async (index) => {
  await onPnChange(index)
}

const buildSalesOrderPayload = (untaxedInvoiceConfirmed = false) => ({
  storeId: orderForm.storeId,
  customerName: orderForm.customerName,
  customerPhone: orderForm.customerPhone,
  customerSource: orderForm.customerSource,
  invoiceStatus: orderForm.invoiceStatus,
  untaxedInvoiceConfirmed,
  items: orderForm.items.map(item => ({
    productId: item.productId,
    productName: item.productName,
    pnCode: item.pnCode,
    snCode: item.snCode,
    snId: item.snId || '',
    supplierId: item.supplierId || '',
    supplierName: item.supplierName || '',
    salePrice: item.salePrice,
    quantity: item.quantity,
    subtotal: item.salePrice * item.quantity,
    useGovSubsidy: item.useGovSubsidy,
    useEduSubsidy: item.useEduSubsidy,
    useSalesReport: item.useSalesReport,
    selectedResourceTypes: item.selectedResourceTypes || []
  })),
  payments: selectedPayments.value.map(pm => ({
    method: pm,
    amount: paymentAmounts[pm] || 0,
    depositId: isDepositPaymentName(pm) ? orderForm.depositId : undefined
  })),
  nationalSubsidy: orderForm.nationalSubsidy,
  educationSubsidy: orderForm.educationSubsidy,
  discountAmount: orderForm.discountAmount,
  remark: orderForm.remark
})

const saveOrderDraft = async () => {
  if (!orderForm.storeId) {
    ElMessage.warning('请选择门店后再保存草稿')
    return
  }
  submitLoading.value = true
  try {
    const data = buildSalesOrderPayload()
    const res = orderForm.orderId
      ? await api.updateSalesDraft(orderForm.orderId, data)
      : await api.saveSalesDraft(data)
    if (res.code === 0) {
      orderForm.orderId = res.data?.orderId || orderForm.orderId
      ElMessage.success(res.data?.message || '销售订单草稿已保存')
      dialogVisible.value = false
      await loadData()
    } else {
      ElMessage.error(res.message || '保存草稿失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存草稿失败')
  } finally {
    submitLoading.value = false
  }
}

const handleSubmit = async () => {
  if (!orderForm.storeId) {
    ElMessage.warning('请选择门店')
    return
  }
  if (!orderForm.customerName || !orderForm.customerPhone) {
    ElMessage.warning('请填写客户信息')
    return
  }
  if (orderForm.items.length === 0) {
    ElMessage.warning('请添加商品')
    return
  }

  for (let i = 0; i < orderForm.items.length; i++) {
    const item = orderForm.items[i]
    if (!item.productId) {
      ElMessage.warning(`第 ${i + 1} 行未选择商品`)
      return
    }
  }

  const paymentTotal = selectedPayments.value.reduce((sum, pm) => sum + (Number(paymentAmounts[pm]) || 0), 0)
  if (Math.abs(paymentTotal - actualPayment.value) > 0.01) {
    ElMessage.warning('支付金额与实付金额不匹配')
    return
  }
  const depositPayment = selectedPayments.value.find(isDepositPaymentName)
  if (depositPayment && !orderForm.depositId) {
    ElMessage.warning('请选择需要核销的定金单')
    return
  }

  submitLoading.value = true
  try {
    let untaxedInvoiceConfirmed = false
    if (orderForm.invoiceStatus !== '不开票' && orderForm.items.some(item => item.selectedSn?.tax_type === 'UNTAXED')) {
      await ElMessageBox.confirm('该机器为未税库存，请确认是否允许开票销售。', '未税库存提醒', { type: 'warning', confirmButtonText: '确认继续', cancelButtonText: '返回修改' })
      untaxedInvoiceConfirmed = true
    }
    const data = buildSalesOrderPayload(untaxedInvoiceConfirmed)
    let res
    if (orderForm.orderId) {
      res = await api.updateSalesDraft(orderForm.orderId, data)
      if (res.code === 0) res = await api.submitSalesDraft(orderForm.orderId)
    } else {
      res = await api.createSales(data)
    }
    if (res.code === 0) {
      if (res.data?.negativeGrossProfit) {
        ElMessage.warning(res.data.message || '订单已提交，当前为负毛利，归档时将进入审批')
      } else {
        ElMessage.success(res.data?.message || '订单创建成功')
      }
      dialogVisible.value = false
      await loadData()
    } else {
      ElMessage.error(res.message || '创建失败')
    }
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    const msg = err.response?.data?.message || '创建订单失败'
    ElMessage.error(msg)
  } finally {
    submitLoading.value = false
  }
}

const handleApprove = async (row) => {
  try {
    await ElMessageBox.confirm('确认审批通过此订单？', '审批确认', { type: 'warning' })
    const res = await api.approveOrder(row.order_id)
    if (res.code === 0) {
      ElMessage.success(res.message || '审批通过')
      loadData()
    } else {
      ElMessage.error(res.message || '审批失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || '审批失败'
      ElMessage.error(msg)
    }
  }
}

const handleReject = (row) => {
  rejectOrderId.value = row.order_id
  rejectReason.value = ''
  rejectDialogVisible.value = true
}

const confirmReject = async () => {
  rejectLoading.value = true
  try {
    const res = await api.rejectOrder(rejectOrderId.value, { reason: rejectReason.value })
    if (res.code === 0) {
      ElMessage.success(res.message || '已拒绝')
      rejectDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || '操作失败'
    ElMessage.error(msg)
  } finally {
    rejectLoading.value = false
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

const getStatusType = (status) => {
  const types = { draft: 'info', completed: 'success', pending_approval: 'warning', cancelled: 'danger', return_pending: 'warning', returned: 'info', deposit_receipt: 'success' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { draft: '草稿', completed: '已完成', pending_approval: '待审批', cancelled: '已取消', return_pending: '退库处理中', returned: '已退单', deposit_receipt: '定金收款' }
  return texts[status] || status
}

const getDepositStatusType = (status) => {
  const types = {
    available: 'success',
    submitted: 'warning',
    archived: 'success',
    redeemed: 'info',
    refunded: 'danger',
    voided: 'danger'
  }
  return types[status] || 'info'
}

const getDepositStatusText = (status) => {
  const texts = {
    available: '可使用',
    submitted: '已提交',
    archived: '已归档',
    redeemed: '已核销',
    refunded: '已退款',
    voided: '已作废'
  }
  return texts[status] || status
}
</script>

<style scoped>
:global(.sales-order-dialog) {
  max-width: calc(100vw - 32px);
}
:global(.sales-order-dialog .el-dialog__body) {
  overflow-x: hidden;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.card-header > div {
  display: flex;
  flex-shrink: 0;
}
.sales-actions {
  align-items: center;
  gap: 8px;
}
.sales-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.sales-filter-control {
  width: 150px;
}
.sales-filter-product {
  width: 190px;
}
.sales-filter-status {
  width: 150px;
}
.sales-filter-date {
  width: 240px;
}
.sales-filter-date :deep(.el-range-input) {
  width: 76px;
}
.sales-filter-date :deep(.el-range-separator) {
  width: 24px;
}
.sales-page {
  width: 100%;
  min-width: 0;
}
.sales-table-scroll {
  position: relative;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--el-border-color-lighter);
}
.sales-order-table {
  width: 100%;
  min-width: 1120px;
  border-collapse: collapse;
  table-layout: fixed;
}
.sales-order-table .order-no-column {
  width: 150px;
}
.sales-order-table .order-no-cell {
  white-space: normal;
  vertical-align: middle;
}
.sales-order-table .order-no-text {
  display: -webkit-box;
  max-height: 40px;
  overflow: hidden;
  line-height: 20px;
  overflow-wrap: anywhere;
  word-break: break-all;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.sales-order-table th,
.sales-order-table td {
  box-sizing: border-box;
  height: 48px;
  padding: 0 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-regular);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sales-order-table th {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-weight: 600;
}
.sales-order-table tbody tr:nth-child(even) {
  background: var(--el-fill-color-lighter);
}
.sales-order-table tbody tr:hover {
  background: var(--el-fill-color-light);
}
.sales-order-table .money-column {
  width: 110px;
  text-align: right;
}
.sales-order-table .operation-column {
  width: 230px;
}
.sales-table-state {
  box-sizing: border-box;
  width: 100%;
  min-width: 1120px;
  padding: 42px 16px;
  color: var(--el-text-color-secondary);
  text-align: center;
  white-space: nowrap;
}
.items-table {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 12px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
  box-shadow: 0 1px 3px rgb(0 0 0 / 4%);
}
.product-details-item {
  align-items: flex-start;
}
.product-details-item :deep(.el-form-item__content) {
  min-width: 0;
  max-width: calc(100% - 90px);
}
.items-table :deep(.el-table) {
  width: 100% !important;
  max-width: 100%;
  border-radius: 6px;
}
.items-table :deep(.el-table__inner-wrapper),
.items-table :deep(.el-scrollbar),
.items-table :deep(.el-scrollbar__wrap) {
  max-width: 100%;
}
.items-table :deep(.el-table__header th) {
  background: var(--el-fill-color-light);
}
.items-table > .el-button {
  margin-top: 12px;
}
.mt-10 { margin-top: 10px; }
.mt-20 { margin-top: 20px; }
.ml-5 { margin-left: 5px; }
.payment-methods {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
}
.deposit-payment-row {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-right: 10px;
  margin-bottom: 8px;
}
.order-summary {
  background: #f5f7fa;
  padding: 15px;
  border-radius: 4px;
  margin-top: 20px;
}
.resource-checks { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.resource-warning { color: #e6a23c; font-size: 12px; line-height: 1.4; }
.muted { color: #909399; font-size: 12px; }
.summary-item {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
}
.summary-item.total {
  font-weight: bold;
  font-size: 16px;
  border-top: 1px solid #ddd;
  padding-top: 10px;
  margin-top: 10px;
}
.summary-item span { color: #f56c6c; }
</style>
