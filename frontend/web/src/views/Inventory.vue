<template>
  <div class="inventory-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>库存管理</span>
        </div>
      </template>

      <el-tabs v-model="mainTab" @tab-change="onTabChange">
        <!-- 库存汇总 -->
        <el-tab-pane label="库存汇总" name="summary">
          <div class="inventory-resource-legend">
            <span class="legend-title">资源类型提示：</span>
            <span class="legend-item"><i class="legend-dot full-resource" />全资源货</span>
            <span class="legend-item"><i class="legend-dot subsidy-resource" />仅国补</span>
            <span class="legend-item"><i class="legend-dot no-subsidy-resource" />无法国补</span>
          </div>
          <div class="filter-bar">
            <el-input v-model="summaryQuery.keyword" placeholder="搜索商品名称/编码/厂商编码" clearable style="width: 240px" @keyup.enter="loadSummary" />
            <el-select v-model="summaryQuery.category" placeholder="商品类别" clearable style="width: 150px" @change="loadSummary">
              <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
            </el-select>
            <el-select v-model="summaryQuery.storeId" placeholder="门店" clearable style="width: 150px" @change="loadSummary">
          <el-option label="全部门店" :value="''" />
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadSummary">查询</el-button>
          </div>

          <el-table :data="summaryData" stripe border v-loading="summaryLoading">
            <el-table-column prop="category" label="类别" width="100" />
            <el-table-column prop="product_name" label="商品名称" min-width="140" />
            <el-table-column prop="spec" label="产品配置" width="130" />
            <el-table-column prop="product_code" label="商品编码" width="120" />
            <el-table-column prop="manufacturer_code" label="厂商编码" width="120" />
            <el-table-column prop="standard_price" label="销售定价" width="100">
              <template #default="{ row }">¥{{ row.standard_price }}</template>
            </el-table-column>
            <el-table-column prop="normal_qty" label="现有库存" width="100">
              <template #default="{ row }">
                <el-popover placement="bottom" :width="260" trigger="hover">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-title">各门店销售仓库存</div>
                      <div v-if="getStockBreakdownRows(row, 'normal_qty').length" class="breakdown-locations">
                        <div v-for="item in getStockBreakdownRows(row, 'normal_qty')" :key="item.key" class="breakdown-item">
                          <span class="breakdown-label">{{ item.store_name }}</span>
                          <span class="breakdown-value">{{ item.quantity }}</span>
                        </div>
                      </div>
                      <div v-else class="breakdown-empty">暂无库存明细</div>
                    </div>
                  </template>
                  <template #reference><span class="stock-quantity-reference">{{ row.normal_qty || 0 }}</span></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column prop="display_qty" label="铺货仓库存" width="110">
              <template #default="{ row }">
                <el-popover placement="bottom" :width="260" trigger="hover">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-title">各门店铺货仓库存</div>
                      <div v-if="getStockBreakdownRows(row, 'display_qty').length" class="breakdown-locations">
                        <div v-for="item in getStockBreakdownRows(row, 'display_qty')" :key="item.key" class="breakdown-item">
                          <span class="breakdown-label">{{ item.store_name }}</span>
                          <span class="breakdown-value">{{ item.quantity }}</span>
                        </div>
                      </div>
                      <div v-else class="breakdown-empty">暂无库存明细</div>
                    </div>
                  </template>
                  <template #reference><span class="stock-quantity-reference">{{ row.display_qty || 0 }}</span></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column prop="demo_qty" label="样品仓库存" width="110">
              <template #default="{ row }">
                <el-popover placement="bottom" :width="260" trigger="hover">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-title">各门店样品仓库存</div>
                      <div v-if="getStockBreakdownRows(row, 'demo_qty').length" class="breakdown-locations">
                        <div v-for="item in getStockBreakdownRows(row, 'demo_qty')" :key="item.key" class="breakdown-item">
                          <span class="breakdown-label">{{ item.store_name }}</span>
                          <span class="breakdown-value">{{ item.quantity }}</span>
                        </div>
                      </div>
                      <div v-else class="breakdown-empty">暂无库存明细</div>
                    </div>
                  </template>
                  <template #reference><span class="stock-quantity-reference">{{ row.demo_qty || 0 }}</span></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column prop="unsellable_qty" label="不可售库存" width="110">
              <template #default="{ row }">
                <el-popover placement="bottom" :width="260" trigger="hover">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-title">各门店不可售仓库存</div>
                      <div v-if="getStockBreakdownRows(row, 'unsellable_qty').length" class="breakdown-locations">
                        <div v-for="item in getStockBreakdownRows(row, 'unsellable_qty')" :key="item.key" class="breakdown-item">
                          <span class="breakdown-label">{{ item.store_name }}</span>
                          <span class="breakdown-value">{{ item.quantity }}</span>
                        </div>
                      </div>
                      <div v-else class="breakdown-empty">暂无库存明细</div>
                    </div>
                  </template>
                  <template #reference><span class="stock-quantity-reference">{{ row.unsellable_qty || 0 }}</span></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column prop="pending_qty" label="占用仓库存" width="110">
              <template #default="{ row }">
                <el-popover placement="bottom" :width="260" trigger="hover">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-title">各门店占用仓库存</div>
                      <div v-if="getStockBreakdownRows(row, 'pending_qty').length" class="breakdown-locations">
                        <div v-for="item in getStockBreakdownRows(row, 'pending_qty')" :key="item.key" class="breakdown-item">
                          <span class="breakdown-label">{{ item.store_name }}</span>
                          <span class="breakdown-value">{{ item.quantity }}</span>
                        </div>
                      </div>
                      <div v-else class="breakdown-empty">暂无库存明细</div>
                    </div>
                  </template>
                  <template #reference><span class="stock-quantity-reference">{{ row.pending_qty || 0 }}</span></template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column label="查看序列号" width="120">
              <template #default="{ row }">
                <el-button v-if="row.need_sn === 1" link type="primary" @click="openSnDialog(row)">查看序列号</el-button>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="summaryQuery.page"
            v-model:page-size="summaryQuery.pageSize"
            :total="summaryTotal"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSummary"
            @current-change="loadSummary"
          />
        </el-tab-pane>

        <!-- SN库存清单 -->
        <el-tab-pane label="SN库存清单" name="sn-inventory">
          <div class="filter-bar">
            <el-input
              v-model="snInventoryQuery.keyword"
              placeholder="搜索SN/PN/商品名称/编码"
              clearable
              style="width: 230px"
              @keyup.enter="querySnInventory"
            />
            <el-select v-model="snInventoryQuery.storeId" placeholder="门店" clearable style="width: 150px" @change="onSnInventoryStoreChange">
              <el-option label="全部门店" :value="''" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-select
              v-model="snInventoryQuery.locationId"
              placeholder="库位"
              clearable
              :disabled="!snInventoryQuery.storeId"
              style="width: 140px"
              @change="querySnInventory"
            >
              <el-option v-for="location in snInventoryLocations" :key="location.location_id" :label="location.name" :value="location.location_id" />
            </el-select>
            <el-select v-model="snInventoryQuery.resourceType" placeholder="资源类型" clearable style="width: 140px" @change="querySnInventory">
              <el-option v-for="resource in snInventoryResourceOptions" :key="resource.value" :label="resource.label" :value="resource.value" />
            </el-select>
            <el-select v-model="snInventoryQuery.resourceStatus" placeholder="资源状态" clearable style="width: 130px" @change="querySnInventory">
              <el-option v-for="status in resourceStatusOptions" :key="status.value" :label="status.label" :value="status.value" />
            </el-select>
            <el-select v-model="snInventoryQuery.specialOnly" placeholder="价格类型" clearable style="width: 130px" @change="querySnInventory">
              <el-option label="仅看特价SN" value="1" />
              <el-option label="全部SN" value="" />
            </el-select>
            <el-input-number v-model="snInventoryQuery.minAgeDays" :min="0" :max="9999" controls-position="right" placeholder="最小库龄" style="width: 125px" />
            <span class="age-separator">至</span>
            <el-input-number v-model="snInventoryQuery.maxAgeDays" :min="0" :max="9999" controls-position="right" placeholder="最大库龄" style="width: 125px" />
            <el-button type="primary" @click="querySnInventory">查询</el-button>
            <el-button @click="resetSnInventoryQuery">重置</el-button>
          </div>

          <el-table :data="snInventoryData" stripe border v-loading="snInventoryLoading">
            <el-table-column prop="sn_code" label="SN" min-width="170" fixed />
            <el-table-column prop="pn_code" label="PN" width="130" />
            <el-table-column prop="product_name" label="商品名称" min-width="180" show-overflow-tooltip />
            <el-table-column prop="store_name" label="所在门店" width="130" />
            <el-table-column prop="location_name" label="库位" width="120" />
            <el-table-column label="资源情况" min-width="220">
              <template #default="{ row }">
                <div v-if="row.resource_statuses?.length" class="resource-status-list">
                  <el-tag
                    v-for="resource in row.resource_statuses"
                    :key="`${resource.resource_type}-${resource.current_status}`"
                    :type="resourceStatusType(resource.current_status)"
                    size="small"
                  >{{ resource.resource_name }}：{{ resource.status_name }}</el-tag>
                </div>
                <span v-else class="muted">无可用资源</span>
              </template>
            </el-table-column>
            <el-table-column label="统一售价" width="110" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.unified_sale_price) }}</template>
            </el-table-column>
            <el-table-column label="SN特价" width="110" align="right">
              <template #default="{ row }">
                <el-tag v-if="row.is_special_price" type="danger">¥{{ formatMoney(row.special_price) }}</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="当前适用售价" width="125" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.effective_sale_price) }}</template>
            </el-table-column>
            <el-table-column label="库龄" width="90" align="right">
              <template #default="{ row }">{{ row.stock_age_days == null ? '未知' : `${row.stock_age_days}天` }}</template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
            <el-table-column v-if="canManageSnPrice" label="操作" width="190" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openSnSpecialPrice(row)">{{ row.is_special_price ? '修改特价' : '设为特价' }}</el-button>
                <el-button v-if="row.is_special_price" link type="danger" @click="cancelSnSpecialPrice(row)">取消特价</el-button>
                <el-button link type="info" @click="openSnPriceHistory(row)">记录</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="snInventoryQuery.page"
            v-model:page-size="snInventoryQuery.pageSize"
            :total="snInventoryTotal"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSnInventory"
            @current-change="loadSnInventory"
          />
        </el-tab-pane>

        <!-- 批量维护 -->
        <el-tab-pane label="批量维护" name="batch-maintenance">
          <div class="batch-maintenance-layout">
            <div class="batch-toolbar">
              <el-button type="primary" @click="openBatchImportDialog">导入生成申请</el-button>
            </div>

            <div class="filter-bar">
              <el-select v-model="batchQuery.status" placeholder="状态" clearable style="width: 130px" @change="loadBatchApplications">
                <el-option label="待审批" value="pending" />
                <el-option label="执行中" value="executing" />
                <el-option label="已执行" value="executed" />
                <el-option label="已拒绝" value="rejected" />
                <el-option label="执行失败" value="execute_failed" />
              </el-select>
              <el-select v-model="batchQuery.operationType" placeholder="操作类型" clearable style="width: 130px" @change="loadBatchApplications">
                <el-option label="批量入库" value="INBOUND" />
                <el-option label="批量出库" value="OUTBOUND" />
                <el-option label="数量调整" value="ADJUST" />
              </el-select>
              <el-button type="primary" @click="loadBatchApplications">查询</el-button>
            </div>

            <el-table :data="batchApplications" stripe border v-loading="batchLoading">
              <el-table-column prop="application_no" label="申请单号" width="190" />
              <el-table-column label="类型" width="100">
                <template #default="{ row }">{{ batchOperationText(row.operation_type) }}</template>
              </el-table-column>
              <el-table-column label="出库权益" width="90">
                <template #default="{ row }">{{ row.trigger_resource_rights ? '触发' : '-' }}</template>
              </el-table-column>
              <el-table-column prop="total_rows" label="行数" width="80" />
              <el-table-column prop="applicant_name" label="申请人" width="120" />
              <el-table-column prop="source_file_name" label="来源文件" min-width="180" show-overflow-tooltip />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="batchStatusType(row.status)">{{ batchStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="170">
                <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openBatchDetail(row)">详情</el-button>
                  <el-button v-if="canReviewBatch && row.status === 'pending'" link type="success" @click="reviewBatch(row, 'approve')">通过</el-button>
                  <el-button v-if="canReviewBatch && row.status === 'pending'" link type="danger" @click="reviewBatch(row, 'reject')">拒绝</el-button>
                </template>
              </el-table-column>
            </el-table>

            <el-pagination
              v-model:current-page="batchQuery.page"
              v-model:page-size="batchQuery.pageSize"
              :total="batchTotal"
              :page-sizes="[20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              @size-change="loadBatchApplications"
              @current-change="loadBatchApplications"
            />
          </div>
        </el-tab-pane>

        <!-- 入库单管理 -->
        <el-tab-pane label="入库单管理" name="inbound">
          <div class="filter-bar">
            <el-select v-model="inboundQuery.status" placeholder="状态" clearable style="width: 120px" @change="loadInboundList">
              <el-option label="全部" value="" />
              <el-option label="待入库" value="pending" />
              <el-option label="已完成" value="completed" />
              <el-option label="已取消" value="cancelled" />
              <el-option label="已退库" value="returned" />
            </el-select>
            <el-select v-model="inboundQuery.storeId" placeholder="门店" clearable style="width: 150px" @change="loadInboundList">
              <el-option label="全部门店" :value="''" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadInboundList">查询</el-button>
          </div>

          <el-table :data="inboundList" stripe border>
            <el-table-column prop="inbound_no" label="入库单号" width="180" />
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="source_no" label="来源单号" width="150" />
            <el-table-column prop="items_summary" label="商品摘要" min-width="200" show-overflow-tooltip />
            <el-table-column prop="total_quantity" label="总数量" width="100" />
            <el-table-column prop="total_amount" label="总金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getInboundStatusType(row.status)">{{ getInboundStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160">
              <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="240">
              <template #default="{ row }">
                <el-button link type="primary" @click="viewInboundDetail(row)">查看</el-button>
                <el-button link type="success" @click="openExecuteDialog(row)" v-if="row.status === 'pending'">入库</el-button>
                <el-button link type="danger" @click="openReturnRequestDialog(row)" v-if="row.status === 'completed'">申请退库</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="inboundQuery.page"
            v-model:page-size="inboundQuery.pageSize"
            :total="inboundTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadInboundList"
            @current-change="loadInboundList"
          />

          <div class="transfer-section mt-30">
            <div class="section-title">退库申请</div>
            <div class="filter-bar">
              <el-select v-model="returnQuery.status" placeholder="状态" clearable style="width: 140px" @change="loadReturnList">
                <el-option label="全部" value="" />
                <el-option label="待审批" value="pending" />
                <el-option label="待执行" value="approved" />
                <el-option label="已拒绝" value="rejected" />
                <el-option label="已退库" value="completed" />
              </el-select>
              <el-button @click="loadReturnList">刷新</el-button>
            </div>
            <el-table :data="returnList" stripe border>
              <el-table-column prop="return_no" label="退库单号" width="190" />
              <el-table-column prop="inbound_no" label="原入库单" width="180" />
              <el-table-column prop="store_name" label="门店" width="120" />
              <el-table-column prop="supplier_name" label="供应商" min-width="150" />
              <el-table-column prop="total_quantity" label="数量" width="80" />
              <el-table-column prop="total_amount" label="退库金额" width="120">
                <template #default="{ row }">¥{{ row.total_amount }}</template>
              </el-table-column>
              <el-table-column prop="status" label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="getReturnStatusType(row.status)">{{ getReturnStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="create_user" label="申请人" width="100" />
              <el-table-column prop="create_time" label="申请时间" width="160">
                <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="190">
                <template #default="{ row }">
                  <el-button v-if="row.status === 'pending'" link type="success" @click="approveReturn(row, 'approved')">通过</el-button>
                  <el-button v-if="row.status === 'pending'" link type="danger" @click="approveReturn(row, 'rejected')">拒绝</el-button>
                  <el-button v-if="row.status === 'approved'" link type="primary" @click="executeApprovedReturn(row)">执行退库</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-model:current-page="returnQuery.page"
              v-model:page-size="returnQuery.pageSize"
              :total="returnTotal"
              layout="total, sizes, prev, pager, next"
              @size-change="loadReturnList"
              @current-change="loadReturnList"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="SN追踪" name="sn-trace">
          <SnTrace />
        </el-tab-pane>

        <el-tab-pane v-if="canManageResourceRights" label="库存资源权益" name="resource-rights" lazy>
          <InventoryResourceRights />
        </el-tab-pane>

        <el-tab-pane label="调拨管理" name="transfer">
          <div class="filter-bar">
            <el-button type="primary" @click="openTransferApplyDialog">发起调拨申请</el-button>
            <el-button @click="loadTransferLists">刷新</el-button>
          </div>
          <div class="transfer-section">
            <div class="section-title">调拨出库</div>
            <el-table :data="transferOutList" stripe border>
              <el-table-column prop="transfer_no" label="调拨单号" width="200" />
              <el-table-column label="调出门店" width="130">
                <template #default="{ row }">{{ row.from_store_name }}</template>
              </el-table-column>
              <el-table-column label="调入门店" width="130">
                <template #default="{ row }">{{ row.to_store_name }}</template>
              </el-table-column>
              <el-table-column label="调拨商品" min-width="200">
                <template #default="{ row }">
                  <span v-for="(item, i) in (row.TransferItems || [])" :key="i">
                    {{ formatTransferItemLabel(item) }}{{ i < (row.TransferItems || []).length - 1 ? '、' : '' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="total_quantity" label="数量" width="80" />
              <el-table-column prop="apply_user" label="申请人" width="100" />
              <el-table-column prop="status" label="状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="getTransferStatusType(row.status)">{{ getTransferStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="create_time" label="创建时间" width="160">
                <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button v-if="row.status === 'pending'" link type="success" @click="handleConfirmTransferOut(row)">确认出库</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div class="transfer-section mt-30">
            <div class="section-title">调拨入库</div>
            <el-table :data="transferInList" stripe border>
              <el-table-column prop="transfer_no" label="调拨单号" width="200" />
              <el-table-column label="调出门店" width="130">
                <template #default="{ row }">{{ row.from_store_name }}</template>
              </el-table-column>
              <el-table-column label="调入门店" width="130">
                <template #default="{ row }">{{ row.to_store_name }}</template>
              </el-table-column>
              <el-table-column label="调拨商品" min-width="200">
                <template #default="{ row }">
                  <span v-for="(item, i) in (row.TransferItems || [])" :key="i">
                    {{ formatTransferItemLabel(item) }}{{ i < (row.TransferItems || []).length - 1 ? '、' : '' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="total_quantity" label="数量" width="80" />
              <el-table-column prop="apply_user" label="申请人" width="100" />
              <el-table-column prop="status" label="状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="getTransferStatusType(row.status)">{{ getTransferStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="create_time" label="创建时间" width="160">
                <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button v-if="row.status === 'out_confirmed'" link type="success" @click="handleConfirmTransferIn(row)">确认入库</el-button>
                </template>
              </el-table-column>
              </el-table>
          </div>

          <div class="transfer-section mt-30">
            <div class="section-title">历史调拨记录</div>
            <div class="filter-bar">
              <el-input v-model="transferHistoryQuery.transferNo" placeholder="调拨单号" clearable style="width: 180px" @keyup.enter="loadTransferHistory" />
              <el-select v-model="transferHistoryQuery.status" placeholder="全部状态" clearable style="width: 130px" @change="loadTransferHistory">
                <el-option label="全部状态" value="" />
                <el-option label="待出库" value="pending" />
                <el-option label="发货中" value="shipping" />
                <el-option label="待入库" value="out_confirmed" />
                <el-option label="已收货" value="received" />
                <el-option label="已完成" value="completed" />
                <el-option label="已取消" value="cancelled" />
              </el-select>
              <el-date-picker v-model="transferHistoryQuery.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" clearable style="width: 150px" />
              <el-date-picker v-model="transferHistoryQuery.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" clearable style="width: 150px" />
              <el-button type="primary" @click="loadTransferHistory">查询</el-button>
              <el-button @click="resetTransferHistoryQuery">重置</el-button>
            </div>
            <el-table :data="transferHistoryList" stripe border v-loading="transferHistoryLoading">
              <el-table-column prop="transfer_no" label="调拨单号" width="190" />
              <el-table-column prop="from_store_name" label="调出门店" width="130" />
              <el-table-column prop="to_store_name" label="调入门店" width="130" />
              <el-table-column label="调拨商品" min-width="200">
                <template #default="{ row }">
                  <span v-for="(item, i) in (row.TransferItems || [])" :key="i">
                    {{ formatTransferItemLabel(item) }}{{ i < (row.TransferItems || []).length - 1 ? '、' : '' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column prop="total_quantity" label="数量" width="80" />
              <el-table-column prop="apply_user" label="申请人" width="100" />
              <el-table-column label="参与人" width="160">
                <template #default="{ row }">
                  {{ [row.shipping_user || row.confirm_user, row.receiving_user || row.inbound_confirm_user].filter(Boolean).join('、') || '-' }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="getTransferStatusType(row.status)">{{ getTransferStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="create_time" label="创建时间" width="160">
                <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-if="transferHistoryTotal > 0"
              v-model:current-page="transferHistoryQuery.page"
              v-model:page-size="transferHistoryQuery.pageSize"
              :total="transferHistoryTotal"
              layout="total, sizes, prev, pager, next"
              @size-change="loadTransferHistory"
              @current-change="loadTransferHistory"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="拆装管理" name="conversion">
          <div class="filter-bar">
            <el-button type="primary" @click="openConversionDialog('split')">新建拆分</el-button>
            <el-button type="success" @click="openConversionDialog('assemble')">新建组装</el-button>
            <el-select v-model="conversionQuery.conversionType" placeholder="类型" clearable style="width: 120px" @change="loadConversionList">
              <el-option label="全部" value="" />
              <el-option label="拆分" value="split" />
              <el-option label="组装" value="assemble" />
            </el-select>
            <el-select v-model="conversionQuery.status" placeholder="状态" clearable style="width: 120px" @change="loadConversionList">
              <el-option label="全部" value="" />
              <el-option label="已完成" value="completed" />
              <el-option label="已冲销" value="voided" />
            </el-select>
            <el-select v-model="conversionQuery.storeId" placeholder="门店" clearable style="width: 150px" @change="loadConversionList">
              <el-option label="全部门店" :value="''" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button @click="loadConversionList">刷新</el-button>
          </div>

          <el-table :data="conversionList" stripe border v-loading="conversionLoading">
            <el-table-column prop="conversion_no" label="单号" width="190" />
            <el-table-column prop="conversion_type" label="类型" width="90">
              <template #default="{ row }">
                <el-tag :type="row.conversion_type === 'assemble' ? 'success' : 'primary'">{{ getConversionTypeText(row.conversion_type) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="store_name" label="门店" width="130" />
            <el-table-column prop="source_summary" label="来源商品" min-width="180" show-overflow-tooltip />
            <el-table-column prop="target_summary" label="目标商品" min-width="180" show-overflow-tooltip />
            <el-table-column prop="total_source_cost" label="来源成本" width="110">
              <template #default="{ row }">¥{{ row.total_source_cost || 0 }}</template>
            </el-table-column>
            <el-table-column prop="service_cost" label="服务成本" width="110">
              <template #default="{ row }">¥{{ row.service_cost || 0 }}</template>
            </el-table-column>
            <el-table-column prop="total_target_cost" label="目标成本" width="110">
              <template #default="{ row }">¥{{ row.total_target_cost || 0 }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'completed' ? 'success' : 'info'">{{ getConversionStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160">
              <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="viewConversionDetail(row)">查看</el-button>
                <el-button v-if="row.status === 'completed'" link type="danger" @click="handleVoidConversion(row)">冲销</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="conversionQuery.page"
            v-model:page-size="conversionQuery.pageSize"
            :total="conversionTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadConversionList"
            @current-change="loadConversionList"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 入库单详情对话框 -->
    <el-dialog v-model="inboundDetailVisible" title="入库单详情" width="800px">
      <div v-if="currentInbound">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="入库单号">{{ currentInbound.inbound_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getInboundStatusType(currentInbound.status)">{{ getInboundStatusText(currentInbound.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="门店">{{ currentInbound.store_name }}</el-descriptions-item>
          <el-descriptions-item label="来源单号">{{ currentInbound.source_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="总数量">{{ currentInbound.total_quantity }}</el-descriptions-item>
          <el-descriptions-item label="总金额">¥{{ currentInbound.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDate(currentInbound.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="创建人">{{ currentInbound.create_user }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentInbound.items || []" stripe border size="small">
          <el-table-column label="商品名称" min-width="140">
            <template #default="{ row }">{{ row.product_name }}</template>
          </el-table-column>
          <el-table-column label="PN码" width="140">
            <template #default="{ row }">{{ row.pn_code || '-' }}</template>
          </el-table-column>
          <el-table-column prop="unit_price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.unit_price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column label="是否SN管理" width="110">
            <template #default="{ row }">
              <el-tag :type="row.need_sn === 1 ? 'warning' : 'info'" size="small">
                {{ row.need_sn === 1 ? '是' : '否' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <!-- 执行入库对话框 -->
    <el-dialog v-model="executeInboundVisible" title="执行入库" width="900px" @close="resetInboundForm">
      <div v-if="currentInbound">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="入库单号">{{ currentInbound.inbound_no }}</el-descriptions-item>
          <el-descriptions-item label="门店">{{ currentInbound.store_name }}</el-descriptions-item>
        </el-descriptions>

        <div v-for="(item, idx) in executeProducts" :key="idx" class="execute-item-section">
          <div class="execute-item-header">
            <span class="item-label">{{ item.productName }}</span>
            <el-tag :type="item.needSn ? 'warning' : 'info'" size="small">{{ item.needSn ? 'SN管理' : '无SN' }}</el-tag>
            <span class="item-qty">待入库: {{ item.quantity }}</span>
            <span class="item-location">库位：{{ item.locationName || '未指定库位' }}</span>
          </div>

          <!-- PN厂商编码选择 -->
          <div class="pn-select-row">
            <span class="pn-label">厂商编码：</span>
            <el-select v-model="item.pnCode" placeholder="选择或输入厂商编码" size="small" clearable filterable allow-create style="width: 220px">
              <el-option v-for="pn in (item.pns || [])" :key="pn.pn_id || pn.pn_code" :label="pn.pn_code" :value="pn.pn_code" />
            </el-select>
            <el-button size="small" type="primary" link @click="openAddPnDialog(item)">新增</el-button>
          </div>

          <!-- SN商品：每行一个SN -->
          <el-table v-if="item.needSn" :data="item.snRows" stripe border size="small" class="sn-table">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column label="PN码" width="160">
              <template #default>
                <span class="shared-pn">{{ item.pnCode || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="SN码" width="180">
              <template #default="{ row: r }">
                <el-input v-model="r.snCode" placeholder="SN码" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="库存类型" width="140">
              <template #default="{ row: r }">
                <el-select v-model="r.inventoryType" size="small" style="width: 120px">
                  <el-option v-for="it in INVENTORY_TYPES" :key="it.value" :label="it.label" :value="it.value" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="备注" min-width="140">
              <template #default="{ row: r }">
                <el-input v-model="r.remark" placeholder="备注" size="small" />
              </template>
            </el-table-column>
          </el-table>

          <!-- 非SN商品：按库存类型拆分数量 -->
          <el-table v-else :data="item.qtyRows" stripe border size="small" class="sn-table">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column label="库存类型" width="160">
              <template #default="{ row: r }">
                <el-select v-model="r.inventoryType" size="small" style="width: 140px">
                  <el-option v-for="it in INVENTORY_TYPES" :key="it.value" :label="it.label" :value="it.value" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="入库数量" width="140">
              <template #default="{ row: r, $index: ri }">
                <el-input v-model="r.quantity" size="small" style="width: 120px" @change="onQtyChange(item)" />
              </template>
            </el-table-column>
            <el-table-column label="备注" min-width="140">
              <template #default="{ row: r }">
                <el-input v-model="r.remark" placeholder="备注" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70" align="center">
              <template #default="{ $index: ri }">
                <el-button v-if="item.qtyRows.length > 1" size="small" type="danger" link @click="item.qtyRows.splice(ri, 1)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- 非SN：添加库存类型行 -->
          <div v-if="!item.needSn" style="margin-top: 6px">
            <el-button size="small" type="primary" link @click="addQtyRow(item)">+ 添加库存类型</el-button>
            <span style="margin-left: 12px; font-size: 12px; color: #909399">
              已分配 {{ allocatedQty(item) }} / {{ item.quantity }}
              <span v-if="allocatedQty(item) !== item.quantity" style="color: #f56c6c">（数量不匹配）</span>
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="executeInboundVisible = false">取消</el-button>
        <el-button type="info" @click="saveInboundDraft">保存草稿</el-button>
        <el-button type="primary" @click="submitInbound" :loading="inboundLoading">确认入库</el-button>
      </template>
    </el-dialog>

    <!-- 新增PN对话框 -->
    <el-dialog v-model="addPnVisible" title="新增厂商编码" width="420px">
      <el-form label-width="80px">
        <el-form-item label="商品">
          <el-input :model-value="addPnTarget?.productName || ''" disabled />
        </el-form-item>
        <el-form-item label="厂商编码">
          <el-input v-model="addPnPnCode" placeholder="请输入新的厂商编码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addPnVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmAddPn">确认新增</el-button>
      </template>
    </el-dialog>

    <!-- 发起退库申请对话框 -->
    <el-dialog v-model="executeReturnVisible" title="发起退库申请" width="600px">
      <div v-if="currentInbound">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="入库单号">{{ currentInbound.inbound_no }}</el-descriptions-item>
          <el-descriptions-item label="门店">{{ currentInbound.store_name }}</el-descriptions-item>
          <el-descriptions-item label="总数量">{{ currentInbound.total_quantity }}</el-descriptions-item>
          <el-descriptions-item label="总金额">¥{{ currentInbound.total_amount }}</el-descriptions-item>
        </el-descriptions>

        <el-form label-width="80px" class="mt-20">
          <el-form-item label="退库原因">
            <el-input v-model="returnReason" type="textarea" :rows="3" placeholder="请输入退库原因" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="executeReturnVisible = false">取消</el-button>
        <el-button type="danger" @click="submitReturn" :loading="returnLoading">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- SN特价设置 -->
    <el-dialog v-model="snSpecialPriceVisible" :title="snSpecialPriceForm.isSpecial ? '修改SN特价' : '设置SN特价'" width="520px">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="SN">{{ snSpecialPriceForm.snCode }}</el-descriptions-item>
        <el-descriptions-item label="商品">{{ snSpecialPriceForm.productName }}</el-descriptions-item>
        <el-descriptions-item label="统一售价">¥{{ formatMoney(snSpecialPriceForm.unifiedSalePrice) }}</el-descriptions-item>
        <el-descriptions-item label="最低售价">¥{{ formatMoney(snSpecialPriceForm.minSalePrice) }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="90px" class="mt-20">
        <el-form-item label="SN特价" required>
          <el-input-number v-model="snSpecialPriceForm.specialPrice" :min="0.01" :precision="2" :step="100" style="width: 100%" />
        </el-form-item>
        <el-alert
          v-if="snSpecialPriceBelowMinimum"
          title="该特价低于最低售价，销售开单时仍会进入现有低价审批。"
          type="warning"
          :closable="false"
          show-icon
          class="price-warning"
        />
        <el-form-item label="调价备注">
          <el-input v-model="snSpecialPriceForm.remark" type="textarea" :rows="3" maxlength="512" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="snSpecialPriceVisible = false">取消</el-button>
        <el-button type="primary" :loading="snSpecialPriceSaving" @click="saveSnSpecialPrice">保存</el-button>
      </template>
    </el-dialog>

    <!-- SN特价变更记录 -->
    <el-dialog v-model="snPriceHistoryVisible" :title="`SN特价记录 - ${snPriceHistorySnCode}`" width="760px">
      <el-table :data="snPriceHistoryData" border stripe v-loading="snPriceHistoryLoading">
        <el-table-column label="操作" width="90">
          <template #default="{ row }">{{ snPriceActionText(row.action) }}</template>
        </el-table-column>
        <el-table-column label="调整前" width="110" align="right">
          <template #default="{ row }">{{ row.old_price == null ? '-' : `¥${formatMoney(row.old_price)}` }}</template>
        </el-table-column>
        <el-table-column label="调整后" width="110" align="right">
          <template #default="{ row }">{{ row.new_price == null ? '-' : `¥${formatMoney(row.new_price)}` }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        <el-table-column prop="operator_name" label="操作人" width="100" />
        <el-table-column label="操作时间" width="165">
          <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 序列号查看对话框 -->
    <el-dialog v-model="snDialogVisible" :title="'序列号 - ' + snProductName" width="1100px">
      <div class="filter-bar">
        <el-select v-model="snFilter.status" placeholder="状态" clearable style="width: 120px" @change="loadSnData">
          <el-option label="全部" value="" />
          <el-option label="在库" value="in_stock" />
          <el-option label="已售" value="sold" />
          <el-option label="已退库" value="returned" />
        </el-select>
        <el-input v-model="snFilter.snCode" placeholder="搜索SN码" clearable style="width: 180px" @keyup.enter="loadSnData" />
        <el-button type="primary" @click="loadSnData">查询</el-button>
        <el-button v-if="!snEditing" type="warning" @click="startSnEdit">修改SN</el-button>
        <el-button v-else type="success" @click="finishSnEdit">完成</el-button>
        <el-button v-if="snEditing" @click="cancelSnEdit">取消</el-button>
      </div>

      <el-table :data="snTableData" stripe border v-loading="snLoading">
        <el-table-column label="SN码" width="180">
          <template #default="{ row }">
            <el-input v-if="snEditing" v-model="row.sn_code" size="small" />
            <span v-else>{{ row.sn_code }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="pn_code" label="PN码" width="130" />
        <el-table-column prop="store_name" label="门店" width="120" />
        <el-table-column label="库位" width="120">
          <template #default="{ row }">{{ row.location_name || '未指定库位' }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="inbound_time" label="入库时间" width="160">
          <template #default="{ row }">{{ formatDate(row.inbound_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openSnTrace(row)">追踪</el-button>
            <el-button
              v-if="row.status === 'in_stock'"
              size="small"
              type="warning"
              link
              @click="openSnLocationDialog(row)"
            >调整库位</el-button>
            <el-button
              v-if="row.status === 'in_stock'"
              size="small"
              type="warning"
              link
              @click="openTransferDialog(row)"
            >调拨</el-button>
            <el-button
              v-if="row.status === 'sold'"
              size="small"
              type="success"
              link
              @click="goToOrder(row)"
            >查看订单</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="snFilter.page"
        v-model:page-size="snFilter.pageSize"
        :total="snTotal"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadSnData"
        @current-change="loadSnData"
        small
        class="mt-20"
      />
    </el-dialog>

    <!-- 同门店库位调整对话框 -->
    <el-dialog v-model="snLocationDialogVisible" title="调整SN库位" width="560px">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="商品">{{ snLocationForm.productName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="SN">{{ snLocationForm.snCode || '-' }}</el-descriptions-item>
        <el-descriptions-item label="PN">{{ snLocationForm.pnCode || '-' }}</el-descriptions-item>
        <el-descriptions-item label="门店">{{ snLocationForm.storeName || snLocationForm.storeId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="当前库位" :span="2">{{ snLocationForm.currentLocationName || '未指定库位' }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="90px" style="margin-top: 20px">
        <el-form-item label="目标库位" required>
          <el-select
            v-model="snLocationForm.targetLocationId"
            placeholder="请选择目标库位"
            filterable
            style="width: 100%"
            :loading="snLocationLoading"
          >
            <el-option
              v-for="location in snLocationOptions"
              :key="location.location_id"
              :label="location.name"
              :value="location.location_id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="snLocationDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="snLocationSaving" @click="saveSnLocation">确定调整</el-button>
      </template>
    </el-dialog>

    <!-- SN追踪对话框 -->
    <el-dialog v-model="traceDialogVisible" :title="'SN追踪 - ' + traceSnCode" width="700px">
      <div v-if="traceLoading" v-loading="traceLoading" style="min-height:200px" />
      <div v-else>
        <div class="trace-info">
          <el-tag :type="traceCurrentStatus === 'in_stock' ? 'success' : traceCurrentStatus === 'sold' ? 'danger' : 'info'">
            {{ getStatusText(traceCurrentStatus) }}
          </el-tag>
          <span style="margin-left:8px">商品: {{ traceProductName }}</span>
        </div>
        <el-timeline style="margin-top:20px">
          <el-timeline-item
            v-for="(event, idx) in traceTimeline"
            :key="idx"
            :timestamp="formatDate(event.time)"
            :color="event.type === 'inbound' ? '#67C23A' : event.type === 'sale' ? '#F56C6C' : event.type === 'return' ? '#E6A23C' : event.type === 'modify_sn' ? '#409EFF' : event.type === 'transfer' ? '#9B59B6' : event.type === 'transfer_out' || event.type === 'transfer_out_confirm' ? '#8E44AD' : event.type === 'transfer_in_confirm' ? '#3498DB' : '#909399'"
            :type="event.type === 'inbound' ? 'success' : event.type === 'sale' ? 'danger' : event.type === 'return' ? 'warning' : event.type === 'modify_sn' ? 'primary' : ''"
          >
            <div>
              <strong>{{ event.label }}</strong>
              <span style="margin-left:8px;color:#909399">{{ event.description }}</span>
              <span v-if="event.oldSnCode" style="margin-left:8px;color:#E6A23C">(原: {{ event.oldSnCode }})</span>
            </div>
            <div style="font-size:12px;color:#c0c4cc">
              {{ event.user }}
              <template v-if="event.type === 'sale' && event.ref_id">
                <el-button size="small" type="primary" link @click="goToOrderFromTrace(event.ref_id)" style="margin-left:8px">查看订单</el-button>
              </template>
            </div>
          </el-timeline-item>
          <el-timeline-item v-if="traceTimeline.length === 0" timestamp="" color="#909399">
            <span style="color:#909399">暂无追踪记录</span>
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-dialog>

    <!-- 新增调拨对话框 -->
    <el-dialog v-model="transferDialogVisible" title="新增调拨" width="600px" @close="resetTransferForm">
      <el-form label-width="100px">
        <el-form-item label="调出门店">
          <el-select
            v-model="transferForm.fromStoreId"
            placeholder="请选择调出门店"
            style="width: 100%"
            :disabled="transferFromStoreDisabled"
            @change="onTransferFromStoreChange"
          >
            <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="调入门店">
          <el-select v-model="transferForm.toStoreId" placeholder="请选择调入门店" style="width: 100%">
            <el-option v-for="store in availableStores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="添加商品">
          <div class="transfer-add-row">
            <el-select
              v-model="transferAddForm.productId"
              placeholder="搜索调拨商品"
              filterable
              remote
              clearable
              :remote-method="searchTransferProducts"
              @change="onTransferProductChange"
              style="flex: 1"
              :disabled="!transferForm.fromStoreId"
            >
              <el-option
                v-for="item in transferProductOptions"
                :key="item.product_id"
                :label="(item.product_name || item.product_id) + ' / ' + (item.need_sn === 1 ? 'SN' : '\u6570\u91cf') + ' / \u5e93\u5b58 ' + (item.normal_qty || 0)"
                :value="item.product_id"
              />
            </el-select>
                        <el-input-number v-model="transferAddForm.quantity" :min="1" :precision="0" style="width: 120px" />
            <el-button type="primary" @click="addTransferProductItem">添加</el-button>
          </div>
        </el-form-item>
      </el-form>

      <h4 class="mt-20">调拨商品</h4>
      <el-table :data="transferForm.items" stripe border size="small">
        <el-table-column label="商品名称" min-width="140">
          <template #default="{ row: item }">{{ item.productName }}</template>
        </el-table-column>
        <el-table-column label="SN码" width="180">
          <template #default="{ row: item }">{{ item.snCode || '\u6309\u5546\u54c1\u6570\u91cf\u7533\u8bf7' }}</template>
        </el-table-column>
        <el-table-column label="数量" width="100">
          <template #default="{ row: item }">{{ item.quantity }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ $index: idx }">
            <el-button size="small" type="danger" link @click="transferForm.items.splice(idx, 1)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="transferDialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveTransferDraft">保存草稿</el-button>
        <el-button type="primary" @click="submitTransfer" :loading="transferLoading">确认调拨</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="transferOutConfirmVisible" title="确认调拨出库" width="760px" @close="resetTransferOutConfirm">
      <div v-if="transferOutConfirmRow">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 14px;">
          <el-descriptions-item label="调拨单号">{{ transferOutConfirmRow.transfer_no }}</el-descriptions-item>
          <el-descriptions-item label="调出门店">{{ transferOutConfirmRow.from_store_name }}</el-descriptions-item>
          <el-descriptions-item label="调入门店">{{ transferOutConfirmRow.to_store_name }}</el-descriptions-item>
          <el-descriptions-item label="数量">{{ transferOutConfirmRow.total_quantity }}</el-descriptions-item>
        </el-descriptions>

        <el-table :data="transferOutSnRows" stripe border size="small" v-loading="transferOutSnLoading">
          <el-table-column prop="productName" label="商品名称" min-width="180" />
          <el-table-column label="选择SN" min-width="240">
            <template #default="{ row }">
              <el-select v-model="row.snId" placeholder="请选择SN" filterable clearable style="width: 100%">
                <el-option
                  v-for="sn in row.snOptions"
                  :key="sn.sn_id"
                  :label="`${sn.sn_code}${sn.pn_code ? ' / PN:' + sn.pn_code : ''}`"
                  :value="sn.sn_id"
                  :disabled="isConfirmSnDisabled(sn.sn_id, row)"
                />
              </el-select>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <el-button @click="transferOutConfirmVisible = false">取消</el-button>
        <el-button type="primary" @click="submitConfirmTransferOut" :loading="transferOutConfirmLoading">确认出库</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conversionDialogVisible" :title="conversionForm.conversionType === 'assemble' ? '新建组装单' : '新建拆分单'" width="1100px" @close="resetConversionForm">
      <el-form label-width="100px">
        <el-form-item label="转换门店">
          <el-select v-model="conversionForm.storeId" placeholder="请选择门店" style="width: 260px" :disabled="isStoreUser()" @change="onConversionStoreChange">
            <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="conversionForm.conversionType === 'assemble'" label="服务成本">
          <el-input-number v-model="conversionForm.serviceCost" :min="0" :precision="2" style="width: 180px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="conversionForm.remark" type="textarea" :rows="2" placeholder="可填写拆分/组装原因" />
        </el-form-item>
      </el-form>

      <div class="conversion-grid">
        <div>
          <div class="section-title">{{ conversionForm.conversionType === 'assemble' ? '组件商品' : '被拆商品' }}</div>
          <div class="conversion-add-row">
            <el-select
              v-model="conversionSourceAdd.productId"
              placeholder="搜索来源商品"
              filterable
              remote
              clearable
              :remote-method="searchConversionSourceProducts"
              @change="onConversionSourceProductChange"
              style="flex: 1"
              :disabled="!conversionForm.storeId"
            >
              <el-option
                v-for="item in conversionSourceOptions"
                :key="item.product_id"
                :label="`${item.product_name || item.name || item.product_id} / 库存 ${item.normal_qty || 0}`"
                :value="item.product_id"
              />
            </el-select>
            <el-select v-if="selectedConversionSourceProduct?.need_sn === 1" v-model="conversionSourceAdd.snId" placeholder="选择SN" filterable clearable style="width: 210px" @change="onConversionSourceSnChange">
              <el-option v-for="sn in conversionSourceSnOptions" :key="sn.sn_id" :label="`${sn.sn_code}${sn.pn_code ? ' / PN:' + sn.pn_code : ''} / 成本:${sn.inbound_price || 0}`" :value="sn.sn_id" />
            </el-select>
            <el-input-number v-else v-model="conversionSourceAdd.quantity" :min="1" :precision="0" :disabled="conversionForm.conversionType === 'split'" style="width: 110px" />
            <el-input-number v-model="conversionSourceAdd.unitCost" :min="0" :precision="2" :controls="false" placeholder="成本" style="width: 130px" />
            <el-button type="primary" @click="addConversionSourceItem">添加</el-button>
          </div>

          <el-table :data="conversionForm.sourceItems" stripe border size="small">
            <el-table-column prop="productName" label="商品" min-width="150" />
            <el-table-column prop="snCode" label="SN" width="150">
              <template #default="{ row }">{{ row.snCode || '-' }}</template>
            </el-table-column>
            <el-table-column prop="pnCode" label="PN" width="130">
              <template #default="{ row }">{{ row.pnCode || '-' }}</template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="70" />
            <el-table-column prop="unitCost" label="单位成本" width="110">
              <template #default="{ row }">¥{{ row.unitCost || 0 }}</template>
            </el-table-column>
            <el-table-column prop="totalCost" label="总成本" width="110">
              <template #default="{ row }">¥{{ row.totalCost || 0 }}</template>
            </el-table-column>
            <el-table-column label="操作" width="70">
              <template #default="{ $index }">
                <el-button link type="danger" @click="conversionForm.sourceItems.splice($index, 1)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div>
          <div class="section-title">{{ conversionForm.conversionType === 'assemble' ? '组装成品' : '拆出商品' }}</div>
          <div class="conversion-add-row">
            <el-select
              v-model="conversionTargetAdd.productId"
              placeholder="搜索目标商品"
              filterable
              remote
              clearable
              :remote-method="searchConversionTargetProducts"
              @change="onConversionTargetProductChange"
              style="flex: 1"
            >
              <el-option v-for="item in conversionTargetOptions" :key="item.product_id" :label="item.name || item.product_name || item.product_id" :value="item.product_id" />
            </el-select>
            <el-input v-if="selectedConversionTargetProduct?.need_sn === 1" v-model="conversionTargetAdd.snCode" placeholder="目标SN" style="width: 180px" />
            <el-input v-model="conversionTargetAdd.pnCode" placeholder="PN" style="width: 150px" />
            <el-input-number v-if="selectedConversionTargetProduct?.need_sn !== 1" v-model="conversionTargetAdd.quantity" :min="1" :precision="0" style="width: 110px" />
            <el-input-number v-model="conversionTargetAdd.unitCost" :min="0" :precision="2" :controls="false" placeholder="请输入商品价格" style="width: 130px" />
            <el-button @click="openConversionProductDialog">新建商品</el-button>
            <el-button type="primary" @click="addConversionTargetItem">添加</el-button>
          </div>

          <el-table :data="conversionForm.targetItems" stripe border size="small">
            <el-table-column prop="productName" label="商品" min-width="150" />
            <el-table-column prop="snCode" label="SN" width="150">
              <template #default="{ row }">{{ row.snCode || '-' }}</template>
            </el-table-column>
            <el-table-column prop="pnCode" label="PN" width="130">
              <template #default="{ row }">{{ row.pnCode || '-' }}</template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="70" />
            <el-table-column prop="unitCost" label="单位成本" width="110">
              <template #default="{ row }">¥{{ row.unitCost || 0 }}</template>
            </el-table-column>
            <el-table-column prop="totalCost" label="总成本" width="110">
              <template #default="{ row }">¥{{ row.totalCost || 0 }}</template>
            </el-table-column>
            <el-table-column label="操作" width="70">
              <template #default="{ $index }">
                <el-button link type="danger" @click="conversionForm.targetItems.splice($index, 1)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div class="conversion-cost-check" :class="{ invalid: !conversionCostMatched }">
        <template v-if="conversionForm.conversionType === 'split'">
          来源成本：¥{{ conversionSourceTotal }}　
          拆出金额：¥{{ conversionTargetTotal }}　
          拆分后原商品成本：¥{{ conversionSplitRemainingCost }}
        </template>
        <template v-else>
          来源成本：¥{{ conversionSourceTotal }}　
          服务成本：¥{{ conversionServiceCost }}　
          目标成本：¥{{ conversionTargetTotal }}　
          应等于：¥{{ conversionExpectedTargetTotal }}
        </template>
      </div>

      <template #footer>
        <el-button @click="conversionDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!conversionCostMatched" :loading="conversionSubmitLoading" @click="submitConversion">确认执行</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conversionProductDialogVisible" title="新建目标商品" width="750px" @close="resetConversionProductForm">
      <el-form :model="conversionProductForm" label-width="100px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商品编码">
              <el-input model-value="(系统自动生成)" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品分类">
              <el-tree-select
                v-model="conversionProductForm.categoryId"
                :data="conversionProductCategoryTree"
                :props="{ label: 'name', value: 'category_id', children: 'children' }"
                placeholder="请选择分类"
                clearable
                check-strictly
                style="width: 100%"
                @change="onConversionProductCategoryChange"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">商品属性</el-divider>
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="品牌" label-width="75px">
              <el-input v-model="conversionProductForm.brand" placeholder="如：联想" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="系列" label-width="75px">
              <el-input v-model="conversionProductForm.series" placeholder="如：拯救者" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="型号" label-width="75px">
              <el-input v-model="conversionProductForm.model" placeholder="如：Y9000P" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="处理器" label-width="75px">
              <el-input v-model="conversionProductForm.processor" placeholder="如：Ultra9 285" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="内存" label-width="75px">
              <el-input v-model="conversionProductForm.memory" placeholder="如：32GB" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="存储" label-width="75px">
              <el-input v-model="conversionProductForm.storage" placeholder="如：2T" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="颜色" label-width="75px">
              <el-input v-model="conversionProductForm.color" placeholder="如：黑" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="显卡" label-width="75px">
              <el-input v-model="conversionProductForm.gpu" placeholder="如：RTX4090" size="small" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="配件类别" label-width="75px">
              <el-input v-model="conversionProductForm.accessory_type" placeholder="如：贴膜/保护壳" size="small" />
            </el-form-item>
          </el-col>
        </el-row>

        <div v-if="conversionProductCategoryFields.length > 0" style="margin-bottom: 12px; padding: 10px; background: #f5f7fa; border-radius: 4px;">
          <el-divider content-position="left" style="margin: 0 0 10px 0;">{{ conversionProductCategoryFieldName }} 补充字段</el-divider>
          <el-row :gutter="16">
            <el-col :span="8" v-for="field in conversionProductExtraFields" :key="field.field_key">
              <el-form-item :label="field.field_label" :required="field.required" label-width="75px">
                <el-select
                  v-if="field.field_type === 'select'"
                  v-model="conversionProductForm.attributes[field.field_key]"
                  :placeholder="field.placeholder || ('请选择' + field.field_label)"
                  size="small"
                  clearable
                  style="width: 100%"
                >
                  <el-option v-for="opt in field.options" :key="opt" :label="opt" :value="opt" />
                </el-select>
                <el-input
                  v-else
                  v-model="conversionProductForm.attributes[field.field_key]"
                  :placeholder="field.placeholder || field.field_label"
                  size="small"
                />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <el-form-item label="商品名称">
          <span style="font-weight: 600; font-size: 14px;">{{ conversionProductName || '（请填写上方属性）' }}</span>
        </el-form-item>
        <el-form-item label="商品简称">
          <el-input v-model="conversionProductForm.customName" placeholder="如需覆盖自动拼装名称，请在此输入" size="small" style="width: 300px;" />
        </el-form-item>
        <el-form-item label="厂商商品名称">
          <el-input v-model="conversionProductForm.config" placeholder="厂商商品名称" />
        </el-form-item>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="需要SN码">
              <el-switch v-model="conversionProductForm.needSn" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态">
              <el-switch v-model="conversionProductForm.status" :active-value="1" :inactive-value="0" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="单位">
              <el-input v-model="conversionProductForm.unit" placeholder="台" size="small" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="详细配置">
          <el-input v-model="conversionProductForm.remark" type="textarea" rows="2" placeholder="详细配置信息" />
        </el-form-item>

        <el-divider content-position="left">厂商编码 / 69码</el-divider>
        <div style="display: flex; gap: 10px; margin-bottom: 10px;">
          <el-input v-model="conversionProductNewBarcode" placeholder="条码内容" style="width: 180px" @keyup.enter="addConversionProductBarcode" />
          <el-select v-model="conversionProductBarcodeType" style="width: 120px">
            <el-option label="厂商编码" value="manufacturer" />
            <el-option label="69码" value="barcode69" />
          </el-select>
          <el-button type="primary" @click="addConversionProductBarcode">添加</el-button>
        </div>
        <el-table :data="conversionProductForm.barcodes" stripe border size="small" max-height="200" v-if="conversionProductForm.barcodes.length > 0">
          <el-table-column label="类型" width="100">
            <template #default="{ row }">
              <el-tag :type="row.type === 'manufacturer' ? '' : 'success'" size="small">
                {{ row.type === 'manufacturer' ? '厂商编码' : '69码' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="条码内容" />
          <el-table-column label="操作" width="60">
            <template #default="{ $index }">
              <el-button link type="danger" size="small" @click="conversionProductForm.barcodes.splice($index, 1)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂未添加条码" :image-size="40" />
      </el-form>
      <template #footer>
        <el-button @click="conversionProductDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="conversionProductSubmitLoading" @click="submitConversionProduct">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conversionDetailVisible" title="拆装单详情" width="900px">
      <div v-if="currentConversion">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="单号">{{ currentConversion.conversion_no }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ getConversionTypeText(currentConversion.conversion_type) }}</el-descriptions-item>
          <el-descriptions-item label="门店">{{ currentConversion.store_name }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ getConversionStatusText(currentConversion.status) }}</el-descriptions-item>
          <el-descriptions-item label="来源成本">¥{{ currentConversion.total_source_cost || 0 }}</el-descriptions-item>
          <el-descriptions-item label="目标成本">¥{{ currentConversion.total_target_cost || 0 }}</el-descriptions-item>
          <el-descriptions-item label="服务成本">¥{{ currentConversion.service_cost || 0 }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDate(currentConversion.create_time) }}</el-descriptions-item>
        </el-descriptions>
        <h4 class="mt-20">明细</h4>
        <el-table :data="currentConversion.items || []" stripe border size="small">
          <el-table-column label="行类型" width="90">
            <template #default="{ row }">{{ getConversionLineRoleText(row.line_role) }}</template>
          </el-table-column>
          <el-table-column prop="product_name" label="商品" min-width="160" />
          <el-table-column prop="pn_code" label="PN" width="130" />
          <el-table-column prop="sn_code" label="SN" width="150" />
          <el-table-column prop="source_sn_code" label="来源SN" width="150" />
          <el-table-column prop="quantity" label="数量" width="70" />
          <el-table-column prop="unit_cost" label="单位成本" width="110">
            <template #default="{ row }">¥{{ row.unit_cost || 0 }}</template>
          </el-table-column>
          <el-table-column prop="total_cost" label="总成本" width="110">
            <template #default="{ row }">¥{{ row.total_cost || 0 }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="batchImportDialogVisible" title="批量维护导入" width="760px">
      <el-form :model="batchForm" label-width="96px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="操作类型" required>
              <el-select v-model="batchForm.operationType" style="width: 100%">
                <el-option label="批量入库" value="INBOUND" />
                <el-option label="批量出库" value="OUTBOUND" />
                <el-option label="数量调整" value="ADJUST" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="导入类型" required>
              <el-radio-group v-model="batchForm.importMode">
                <el-radio-button v-for="item in batchImportModeOptions" :key="item.value" :label="item.value">{{ item.label }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="统一仓位" required>
              <el-select v-model="batchForm.inventoryType" style="width: 100%">
                <el-option v-for="item in INVENTORY_TYPES" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="资源权益" :required="batchForm.operationType === 'INBOUND' || (batchForm.operationType === 'OUTBOUND' && batchForm.triggerResourceRights)">
              <el-select v-model="batchForm.resourceTypes" multiple collapse-tags collapse-tags-tooltip clearable style="width: 100%">
                <el-option v-for="resource in snInventoryResourceOptions" :key="resource.value" :label="resource.label" :value="resource.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="出库权益">
              <el-switch
                v-model="batchForm.triggerResourceRights"
                :disabled="batchForm.operationType !== 'OUTBOUND'"
                active-text="触发"
                inactive-text="不触发"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="备注">
              <el-input v-model="batchForm.remark" clearable />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <div class="import-tips">
        <el-button type="primary" size="small" @click="downloadBatchTemplate">下载当前模板</el-button>
      </div>
      <div class="upload-area">
        <el-upload :auto-upload="false" :show-file-list="false" accept=".xlsx,.xls" :on-change="handleBatchFileChange" drag>
          <el-icon class="el-icon--upload"><Upload /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或 <em>点击上传</em></div>
        </el-upload>
        <div v-if="batchImportFile" class="selected-file">
          <el-tag closable @close="clearBatchImportFile">{{ batchImportFile.name }}</el-tag>
        </div>
      </div>

      <el-alert
        v-if="batchImportResult.visible"
        :type="batchImportResult.failed > 0 ? 'warning' : 'success'"
        :closable="false"
        style="margin-top: 16px;"
      >
        导入完成：成功 <strong>{{ batchImportResult.success }}</strong> 行，
        异常 <strong>{{ batchImportResult.failed }}</strong> 行
      </el-alert>
      <el-table
        v-if="batchImportErrors.length > 0"
        :data="batchImportErrors"
        stripe
        size="small"
        max-height="240"
        style="margin-top: 12px;"
      >
        <el-table-column prop="rowNo" label="行号" width="90" />
        <el-table-column prop="message" label="异常原因" min-width="220" />
      </el-table>

      <template #footer>
        <el-button @click="batchImportDialogVisible = false">关闭</el-button>
        <el-button v-if="batchImportErrors.length > 0" @click="downloadBatchImportErrors">下载异常记录</el-button>
        <el-button type="primary" :loading="batchImportLoading" :disabled="!batchImportFile" @click="submitBatchImport">立即导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDetailVisible" title="批量维护申请详情" width="980px">
      <div v-if="currentBatchApplication">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="申请单号">{{ currentBatchApplication.application_no }}</el-descriptions-item>
          <el-descriptions-item label="操作类型">{{ batchOperationText(currentBatchApplication.operation_type) }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ batchStatusText(currentBatchApplication.status) }}</el-descriptions-item>
          <el-descriptions-item label="申请人">{{ currentBatchApplication.applicant_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="审批人">{{ currentBatchApplication.reviewer_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDate(currentBatchApplication.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批意见" :span="3">{{ currentBatchApplication.review_comment || '-' }}</el-descriptions-item>
          <el-descriptions-item v-if="currentBatchApplication.execute_error" label="执行失败原因" :span="3">{{ currentBatchApplication.execute_error }}</el-descriptions-item>
        </el-descriptions>
        <h4 class="mt-20">明细</h4>
        <el-table :data="currentBatchApplication.items || []" stripe border size="small" max-height="420">
          <el-table-column prop="row_no" label="行号" width="70" />
          <el-table-column prop="product_code" label="商品编码" width="110" />
          <el-table-column prop="product_name" label="商品" min-width="160" show-overflow-tooltip />
          <el-table-column prop="pn_code" label="PN" width="120" />
          <el-table-column prop="sn_code" label="SN" width="150" show-overflow-tooltip />
          <el-table-column prop="store_id" label="门店ID" width="110" />
          <el-table-column prop="location_id" label="库位ID" width="110" />
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column prop="before_qty" label="调整前" width="80" />
          <el-table-column prop="after_qty" label="调整后" width="80" />
          <el-table-column label="资源权益" min-width="150">
            <template #default="{ row }">{{ parseResourceTypesText(row.resource_types) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="batchDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import api from '../api'
import { getStoreId, hasRole, isStoreUser } from '../utils/user'
import SnTrace from './SnTrace.vue'
import InventoryResourceRights from '../components/InventoryResourceRights.vue'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'

const router = useRouter()
const TRANSFER_DRAFT_KEY = 'inventory-transfer-create'
const inboundDraftKey = () => currentInbound.value?.inbound_id ? `inventory-inbound-execute:${currentInbound.value.inbound_id}` : ''
const mainTab = ref('summary')
const canManageResourceRights = computed(() => hasRole(['finance', 'manager']))
const canManageSnPrice = computed(() => hasRole(['admin']))
const stores = ref([])
const storesLoaded = ref(false)
const categories = ref([])

// 库存汇总
const summaryData = ref([])
const summaryTotal = ref(0)
const summaryLoading = ref(false)
const summaryQuery = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  category: '',
  storeId: ''
})

// SN库存清单
const snInventoryData = ref([])
const snInventoryTotal = ref(0)
const snInventoryLoading = ref(false)
const snInventoryLocations = ref([])
const snInventoryResourceOptions = ref([])
const resourceStatusOptions = [
  { label: '可用', value: 'AVAILABLE' },
  { label: '已锁定', value: 'LOCKED' },
  { label: '已核销', value: 'USED' },
  { label: '已套回', value: 'CLAIMED_BACK' },
  { label: '异常', value: 'EXCEPTION' }
]
const snInventoryQuery = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  storeId: '',
  locationId: '',
  resourceType: '',
  resourceStatus: '',
  specialOnly: '',
  minAgeDays: undefined,
  maxAgeDays: undefined
})
const snSpecialPriceVisible = ref(false)
const snSpecialPriceSaving = ref(false)
const snSpecialPriceForm = reactive({
  snId: '',
  snCode: '',
  productName: '',
  unifiedSalePrice: 0,
  minSalePrice: 0,
  specialPrice: 0,
  remark: '',
  isSpecial: false
})
const snSpecialPriceBelowMinimum = computed(() => (
  Number(snSpecialPriceForm.minSalePrice || 0) > 0 &&
  Number(snSpecialPriceForm.specialPrice || 0) < Number(snSpecialPriceForm.minSalePrice || 0)
))
const snPriceHistoryVisible = ref(false)
const snPriceHistoryLoading = ref(false)
const snPriceHistorySnCode = ref('')
const snPriceHistoryData = ref([])

// 批量维护
const canReviewBatch = computed(() => hasRole(['admin']))
const batchApplications = ref([])
const batchTotal = ref(0)
const batchLoading = ref(false)
const batchImportLoading = ref(false)
const batchImportDialogVisible = ref(false)
const batchImportFile = ref(null)
const batchImportErrors = ref([])
const batchImportResult = reactive({ visible: false, success: 0, failed: 0 })
const batchDetailVisible = ref(false)
const currentBatchApplication = ref(null)
const batchForm = reactive({
  operationType: 'INBOUND',
  importMode: 'SN',
  inventoryType: 'normal_qty',
  resourceTypes: [],
  triggerResourceRights: false,
  remark: ''
})
const batchImportModeOptions = [
  { label: 'SN商品', value: 'SN' },
  { label: '非SN商品', value: 'NON_SN' }
]
const batchQuery = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  operationType: ''
})

// 入库单
const inboundList = ref([])
const inboundTotal = ref(0)
const inboundQuery = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  storeId: ''
})

const returnList = ref([])
const returnTotal = ref(0)
const returnQuery = reactive({
  page: 1,
  pageSize: 20,
  status: ''
})

// 入库单详情
const inboundDetailVisible = ref(false)
const currentInbound = ref(null)

// 执行入库
const executeInboundVisible = ref(false)
const inboundLoading = ref(false)
const executeProducts = ref([])
const addPnVisible = ref(false)
const addPnTarget = ref(null)
const addPnPnCode = ref('')

const INVENTORY_TYPES = [
  { value: 'normal_qty', label: '销售仓' },
  { value: 'demo_qty', label: '样品仓' },
  { value: 'display_qty', label: '铺货仓' },
  { value: 'unsellable_qty', label: '不可售仓' },
  { value: 'pending_qty', label: '占用仓' }
]

// 执行退库
const executeReturnVisible = ref(false)
const returnLoading = ref(false)
const returnReason = ref('')

// SN弹窗
const snDialogVisible = ref(false)
const snProductId = ref('')
const snProductName = ref('')
const snTableData = ref([])
const snTotal = ref(0)
const snLoading = ref(false)
const snFilter = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  snCode: ''
})

const snEditing = ref(false)
const snOriginalCodes = ref({})
const snLocationDialogVisible = ref(false)
const snLocationLoading = ref(false)
const snLocationSaving = ref(false)
const snLocationOptions = ref([])
const snLocationForm = reactive({
  snId: '',
  snCode: '',
  pnCode: '',
  productName: '',
  storeId: '',
  storeName: '',
  currentLocationId: '',
  currentLocationName: '',
  targetLocationId: ''
})
// SN追踪对话框
const traceDialogVisible = ref(false)
const traceSnCode = ref('')
const traceLoading = ref(false)
const traceTimeline = ref([])
const traceCurrentStatus = ref('')
const traceProductName = ref('')

// 调拨
const transferDialogVisible = ref(false)
const transferLoading = ref(false)
const transferOutList = ref([])
const transferInList = ref([])
const transferHistoryList = ref([])
const transferHistoryTotal = ref(0)
const transferHistoryLoading = ref(false)
const transferHistoryQuery = reactive({
  page: 1,
  pageSize: 20,
  transferNo: '',
  status: '',
  startDate: '',
  endDate: ''
})
const transferProductOptions = ref([])
const transferSnOptions = ref([])
const transferOutConfirmVisible = ref(false)
const transferOutConfirmLoading = ref(false)
const transferOutSnLoading = ref(false)
const transferOutConfirmRow = ref(null)
const transferOutSnRows = ref([])
const transferForm = reactive({
  fromStoreId: '',
  fromStoreName: '',
  toStoreId: '',
  items: []
})
const transferAddForm = reactive({
  productId: '',
  snId: '',
  quantity: 1
})

const availableStores = computed(() => {
  return stores.value.filter(s => s.store_id !== transferForm.fromStoreId)
})

const transferFromStoreDisabled = computed(() => {
  return isStoreUser() || transferForm.items.length > 0
})

const selectedTransferProduct = computed(() => {
  return transferProductOptions.value.find(item => item.product_id === transferAddForm.productId) || null
})

// 拆分/组装
const conversionLoading = ref(false)
const conversionSubmitLoading = ref(false)
const conversionDialogVisible = ref(false)
const conversionDetailVisible = ref(false)
const conversionList = ref([])
const conversionTotal = ref(0)
const currentConversion = ref(null)
const conversionSourceOptions = ref([])
const conversionTargetOptions = ref([])
const conversionSourceSnOptions = ref([])
const conversionProductDialogVisible = ref(false)
const conversionProductSubmitLoading = ref(false)
const conversionProductCategoryTree = ref([])
const conversionProductCategoryFields = ref([])
const conversionProductCategoryFieldName = ref('')
const conversionProductNewBarcode = ref('')
const conversionProductBarcodeType = ref('manufacturer')
const conversionQuery = reactive({
  page: 1,
  pageSize: 20,
  conversionType: '',
  status: '',
  storeId: ''
})
const conversionForm = reactive({
  conversionType: 'split',
  storeId: '',
  serviceCost: 0,
  remark: '',
  sourceItems: [],
  targetItems: []
})
const conversionSourceAdd = reactive({
  productId: '',
  snId: '',
  quantity: 1,
  unitCost: 0
})
const conversionTargetAdd = reactive({
  productId: '',
  pnCode: '',
  snCode: '',
  quantity: 1,
  unitCost: 0
})
const conversionProductForm = reactive({
  categoryId: '',
  config: '',
  brand: '',
  series: '',
  model: '',
  processor: '',
  memory: '',
  storage: '',
  color: '',
  gpu: '',
  accessory_type: '',
  unit: '台',
  needSn: false,
  needImei: false,
  remark: '',
  status: 1,
  barcodes: [],
  attributes: {},
  customName: ''
})
const selectedConversionSourceProduct = computed(() => {
  return conversionSourceOptions.value.find(item => item.product_id === conversionSourceAdd.productId) || null
})
const selectedConversionTargetProduct = computed(() => {
  return conversionTargetOptions.value.find(item => item.product_id === conversionTargetAdd.productId) || null
})
const conversionSourceTotal = computed(() => roundMoney(conversionForm.sourceItems.reduce((sum, item) => sum + Number(item.totalCost || 0), 0)))
const conversionTargetTotal = computed(() => roundMoney(conversionForm.targetItems.reduce((sum, item) => sum + Number(item.totalCost || 0), 0)))
const conversionServiceCost = computed(() => conversionForm.conversionType === 'assemble' ? roundMoney(conversionForm.serviceCost || 0) : 0)
const conversionExpectedTargetTotal = computed(() => roundMoney(conversionSourceTotal.value + conversionServiceCost.value))
const conversionSplitRemainingCost = computed(() => roundMoney(conversionSourceTotal.value - conversionTargetTotal.value))
const conversionProductStandardFields = ['brand', 'series', 'model', 'processor', 'memory', 'storage', 'color', 'gpu', 'accessory_type']
const conversionProductExtraFields = computed(() => {
  return conversionProductCategoryFields.value.filter(field => !conversionProductStandardFields.includes(field.field_key))
})
const conversionProductName = computed(() => {
  if (conversionProductForm.customName) return conversionProductForm.customName
  const parts = []
  for (const field of conversionProductStandardFields) {
    if (conversionProductForm[field]) parts.push(conversionProductForm[field])
  }
  for (const field of conversionProductCategoryFields.value) {
    if (!conversionProductStandardFields.includes(field.field_key) && conversionProductForm.attributes[field.field_key]) {
      parts.push(conversionProductForm.attributes[field.field_key])
    }
  }
  return parts.join(' ')
})
const conversionCostMatched = computed(() => {
  if (conversionForm.sourceItems.length === 0 || conversionForm.targetItems.length === 0) return false
  if (conversionForm.conversionType === 'split') {
    return conversionForm.sourceItems.length === 1 &&
      conversionTargetTotal.value > 0 &&
      conversionTargetTotal.value <= conversionSourceTotal.value &&
      conversionSplitRemainingCost.value >= 0
  }
  return Math.abs(conversionTargetTotal.value - conversionExpectedTargetTotal.value) <= 0.01
})

onMounted(() => {
  if (isStoreUser()) {
    inboundQuery.storeId = getStoreId()
    summaryQuery.storeId = getStoreId()
    snInventoryQuery.storeId = getStoreId()
    conversionQuery.storeId = getStoreId()
    conversionForm.storeId = getStoreId()
  }
  loadStores()
  loadCategories()
  if (mainTab.value === 'summary') {
    loadSummary()
  } else if (mainTab.value === 'inbound') {
    loadInboundList()
    loadReturnList()
  }
})

const onTabChange = (tabName) => {
  if (tabName === 'summary') {
    if (summaryData.value.length === 0) {
      loadSummary()
    }
  } else if (tabName === 'inbound') {
    if (inboundList.value.length === 0) {
      loadInboundList()
    }
    if (returnList.value.length === 0) {
      loadReturnList()
    }
  } else if (tabName === 'sn-inventory') {
    if (snInventoryResourceOptions.value.length === 0) {
      loadSnInventoryResourceOptions()
    }
    if (snInventoryQuery.storeId && snInventoryLocations.value.length === 0) {
      loadSnInventoryLocations()
    }
    if (snInventoryData.value.length === 0) {
      loadSnInventory()
    }
  } else if (tabName === 'batch-maintenance') {
    if (batchApplications.value.length === 0) {
      loadBatchApplications()
    }
  } else if (tabName === 'transfer') {
    if (transferOutList.value.length === 0 && transferInList.value.length === 0 && transferHistoryList.value.length === 0) {
      loadTransferLists()
    }
  } else if (tabName === 'conversion') {
    if (conversionList.value.length === 0) {
      loadConversionList()
    }
  }
  // sn-trace tab does not need preloading
}

const loadStores = async () => {
  if (storesLoaded.value) return
  try {
    const res = await api.getAllStores()
    if (res && res.code === 0 && Array.isArray(res.data)) {
      stores.value = res.data
      storesLoaded.value = true
    } else {
      stores.value = []
    }
  } catch (err) {
    stores.value = []
  }
}

const loadCategories = async () => {
  try {
    const res = await api.getProductList({ page: 1, pageSize: 500 })
    if (res.code === 0) {
      const cats = new Set()
      ;(res.data?.list || []).forEach(p => { if (p.category) cats.add(p.category) })
      categories.value = [...cats].sort()
    }
  } catch (err) {
    console.error('Failed to load categories')
  }
}

// 库存汇总
const getStockBreakdownRows = (row, field) => {
  const source = Array.isArray(row?.store_stock_info) ? row.store_stock_info : []
  const grouped = new Map()

  source.forEach(item => {
    const quantity = Number(item?.[field] || 0)
    if (quantity <= 0) return
    const key = String(item.store_id || item.store_name || 'unknown')
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        store_name: item.store_name || item.store_id || '未知门店',
        quantity: 0
      })
    }
    grouped.get(key).quantity += quantity
  })

  return [...grouped.values()].sort((a, b) => b.quantity - a.quantity)
}

const loadSummary = async () => {
  summaryLoading.value = true
  try {
    const res = await api.getInventoryList(summaryQuery)
    if (res.code === 0) {
      summaryData.value = res.data?.list || []
      summaryTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载库存数据失败')
  } finally {
    summaryLoading.value = false
  }
}

const loadSnInventoryResourceOptions = async () => {
  try {
    const res = await api.getResourceCategories({ activeOnly: 1 })
    snInventoryResourceOptions.value = (res.data || []).map(row => ({
      label: row.short_name || row.name,
      value: row.category_code
    }))
  } catch (err) {
    snInventoryResourceOptions.value = []
  }
}

const loadSnInventoryLocations = async () => {
  snInventoryLocations.value = []
  if (!snInventoryQuery.storeId) return
  try {
    const res = await api.getLocationsByStore(snInventoryQuery.storeId)
    snInventoryLocations.value = res.data || []
  } catch (err) {
    ElMessage.error('加载库位失败')
  }
}

const loadSnInventory = async () => {
  snInventoryLoading.value = true
  try {
    const params = {
      ...snInventoryQuery,
      minAgeDays: snInventoryQuery.minAgeDays ?? '',
      maxAgeDays: snInventoryQuery.maxAgeDays ?? ''
    }
    const res = await api.getSnInventoryList(params)
    if (res.code === 0) {
      snInventoryData.value = res.data?.list || []
      snInventoryTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载SN库存清单失败')
  } finally {
    snInventoryLoading.value = false
  }
}

const batchOperationText = (type) => ({
  INBOUND: '批量入库',
  OUTBOUND: '批量出库',
  ADJUST: '数量调整'
})[type] || type || '-'

const batchStatusText = (status) => ({
  pending: '待审批',
  executing: '执行中',
  executed: '已执行',
  rejected: '已拒绝',
  execute_failed: '执行失败'
})[status] || status || '-'

const batchStatusType = (status) => ({
  pending: 'warning',
  executing: 'primary',
  executed: 'success',
  rejected: 'info',
  execute_failed: 'danger'
})[status] || ''

const parseResourceTypesText = (value) => {
  if (!value) return '-'
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length ? parsed.join('、') : '-'
  } catch (err) {
    return String(value)
  }
}

const loadBatchApplications = async () => {
  batchLoading.value = true
  try {
    const res = await api.getInventoryBatchApplications(batchQuery)
    if (res.code === 0) {
      batchApplications.value = res.data?.list || []
      batchTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载批量维护申请失败')
  } finally {
    batchLoading.value = false
  }
}

const openBatchImportDialog = async () => {
  batchImportDialogVisible.value = true
  batchImportFile.value = null
  batchImportErrors.value = []
  batchImportResult.visible = false
  batchImportResult.success = 0
  batchImportResult.failed = 0
  if (snInventoryResourceOptions.value.length === 0) {
    await loadSnInventoryResourceOptions()
  }
}

const downloadBatchTemplate = () => {
  const isSn = batchForm.importMode === 'SN'
  const baseHeaders = isSn
    ? ['门店ID', '商品编码', 'PN', 'SN', '提货价', '备注']
    : ['门店ID', '商品编码', 'PN', '数量', '提货价', '备注']
  const example = isSn ? {
    门店ID: stores.value[0]?.store_id || '',
    商品编码: '',
    PN: '',
    SN: 'SN商品必填',
    提货价: batchForm.operationType === 'INBOUND' ? 0 : '',
    备注: ''
  } : {
    门店ID: stores.value[0]?.store_id || '',
    商品编码: '',
    PN: '',
    数量: batchForm.operationType === 'ADJUST' ? '正数增加，负数减少' : 1,
    提货价: batchForm.operationType === 'INBOUND' ? 0 : '',
    备注: ''
  }
  const ws = XLSX.utils.json_to_sheet([example], { header: baseHeaders })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '批量维护')
  XLSX.writeFile(wb, `${batchOperationText(batchForm.operationType)}_${isSn ? 'SN商品' : '非SN商品'}模板.xlsx`)
}

const handleBatchFileChange = async (uploadFile) => {
  batchImportFile.value = uploadFile.raw || null
  batchImportErrors.value = []
  batchImportResult.visible = false
}

const clearBatchImportFile = () => {
  batchImportFile.value = null
  batchImportErrors.value = []
  batchImportResult.visible = false
}

const validateBatchImportForm = () => {
  if (!batchForm.operationType) return '请选择操作类型'
  if (!batchForm.importMode) return '请选择导入类型'
  if (!batchForm.inventoryType) return '请选择统一仓位'
  if ((batchForm.operationType === 'INBOUND' || (batchForm.operationType === 'OUTBOUND' && batchForm.triggerResourceRights)) && batchForm.resourceTypes.length === 0) {
    return '请选择资源权益'
  }
  if (!batchImportFile.value) return '请选择导入文件'
  return ''
}

const submitBatchImport = async () => {
  const message = validateBatchImportForm()
  if (message) {
    ElMessage.warning(message)
    return
  }
  batchImportLoading.value = true
  try {
    const res = await api.importInventoryBatchApplication(batchImportFile.value, {
      operationType: batchForm.operationType,
      importMode: batchForm.importMode,
      inventoryType: batchForm.inventoryType,
      resourceTypes: (batchForm.operationType === 'INBOUND' || (batchForm.operationType === 'OUTBOUND' && batchForm.triggerResourceRights)) ? batchForm.resourceTypes.join(',') : '',
      triggerResourceRights: batchForm.operationType === 'OUTBOUND' && batchForm.triggerResourceRights ? 1 : 0,
      remark: batchForm.remark || ''
    })
    if (res.code === 0) {
      const data = res.data || {}
      batchImportErrors.value = data.errors || []
      batchImportResult.visible = true
      batchImportResult.success = data.validRows || 0
      batchImportResult.failed = data.errorRows || 0
      ElMessage.success(data.message || res.message || '批量维护申请已生成')
      if (batchImportResult.failed === 0) batchImportDialogVisible.value = false
      batchImportFile.value = null
      loadBatchApplications()
    }
  } catch (err) {
    const data = err.response?.data?.data
    batchImportErrors.value = data?.errors || []
    batchImportResult.visible = batchImportErrors.value.length > 0
    batchImportResult.success = 0
    batchImportResult.failed = batchImportErrors.value.length
    const first = batchImportErrors.value.slice(0, 3).map(item => `第${item.rowNo}行：${item.message}`).join('；')
    const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || String(err.message || '').includes('timeout')
    ElMessage.error(first || err.response?.data?.message || (isTimeout ? '导入处理时间较长，请先刷新申请列表确认结果，勿重复提交' : '导入失败'))
  } finally {
    batchImportLoading.value = false
  }
}

const downloadBatchImportErrors = () => {
  if (batchImportErrors.value.length === 0) return
  const rows = batchImportErrors.value.map(item => ({
    行号: item.rowNo,
    异常原因: item.message,
    ...(item.raw || {})
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '异常记录')
  XLSX.writeFile(wb, '批量维护导入异常记录.xlsx')
}

const openBatchDetail = async (row) => {
  try {
    const res = await api.getInventoryBatchApplicationDetail(row.application_id)
    if (res.code === 0) {
      currentBatchApplication.value = res.data
      batchDetailVisible.value = true
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载批量维护详情失败')
  }
}

const reviewBatch = async (row, action) => {
  const title = action === 'approve' ? '通过批量维护申请' : '拒绝批量维护申请'
  try {
    const { value } = await ElMessageBox.prompt('审批意见', title, {
      confirmButtonText: action === 'approve' ? '确认通过并执行' : '确认拒绝',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: action === 'approve' ? '可选' : '请输入拒绝原因'
    })
    if (action === 'reject' && !String(value || '').trim()) {
      ElMessage.warning('拒绝时必须填写原因')
      return
    }
    const res = await api.reviewInventoryBatchApplication(row.application_id, { action, comment: value || '' })
    if (res.code === 0) {
      ElMessage.success(res.data?.message || res.message || '审批完成')
      loadBatchApplications()
      if (batchDetailVisible.value && currentBatchApplication.value?.application_id === row.application_id) {
        batchDetailVisible.value = false
      }
    }
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err.response?.data?.message || '审批失败')
  }
}

const querySnInventory = () => {
  snInventoryQuery.page = 1
  loadSnInventory()
}

const onSnInventoryStoreChange = async () => {
  snInventoryQuery.locationId = ''
  await loadSnInventoryLocations()
  querySnInventory()
}

const resetSnInventoryQuery = async () => {
  Object.assign(snInventoryQuery, {
    page: 1,
    keyword: '',
    storeId: isStoreUser() ? getStoreId() : '',
    locationId: '',
    resourceType: '',
    resourceStatus: '',
    specialOnly: '',
    minAgeDays: undefined,
    maxAgeDays: undefined
  })
  await loadSnInventoryLocations()
  loadSnInventory()
}

const openSnSpecialPrice = (row) => {
  Object.assign(snSpecialPriceForm, {
    snId: row.sn_id,
    snCode: row.sn_code,
    productName: row.product_name,
    unifiedSalePrice: Number(row.unified_sale_price || 0),
    minSalePrice: Number(row.min_sale_price || 0),
    specialPrice: Number(row.special_price || row.effective_sale_price || 0),
    remark: row.special_price_remark || '',
    isSpecial: Boolean(row.is_special_price)
  })
  snSpecialPriceVisible.value = true
}

const saveSnSpecialPrice = async () => {
  if (!Number(snSpecialPriceForm.specialPrice) || Number(snSpecialPriceForm.specialPrice) <= 0) {
    ElMessage.warning('请输入大于0的SN特价')
    return
  }
  snSpecialPriceSaving.value = true
  try {
    const res = await api.setSnSpecialPrice(snSpecialPriceForm.snId, {
      specialPrice: snSpecialPriceForm.specialPrice,
      remark: snSpecialPriceForm.remark
    })
    ElMessage.success(res.data?.requiresPriceApproval ? '特价已保存；销售时将进入低价审批' : 'SN特价已保存')
    snSpecialPriceVisible.value = false
    loadSnInventory()
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存SN特价失败')
  } finally {
    snSpecialPriceSaving.value = false
  }
}

const cancelSnSpecialPrice = async (row) => {
  try {
    const { value } = await ElMessageBox.prompt(
      `取消 ${row.sn_code} 的SN特价后，将立即回退为最新统一售价。`,
      '取消SN特价',
      { inputPlaceholder: '可填写取消原因', confirmButtonText: '确认取消', cancelButtonText: '返回' }
    )
    await api.cancelSnSpecialPrice(row.sn_id, { remark: value || '' })
    ElMessage.success('SN特价已取消')
    loadSnInventory()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '取消SN特价失败')
  }
}

const openSnPriceHistory = async (row) => {
  snPriceHistoryVisible.value = true
  snPriceHistoryLoading.value = true
  snPriceHistorySnCode.value = row.sn_code
  snPriceHistoryData.value = []
  try {
    const res = await api.getSnSpecialPriceHistory(row.sn_id)
    snPriceHistoryData.value = res.data || []
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载SN特价记录失败')
  } finally {
    snPriceHistoryLoading.value = false
  }
}

const formatMoney = value => Number(value || 0).toFixed(2)
const resourceStatusType = status => ({
  AVAILABLE: 'success',
  LOCKED: 'warning',
  USED: 'info',
  CLAIMED_BACK: 'danger',
  EXCEPTION: 'danger'
}[status] || 'info')
const snPriceActionText = action => ({ SET: '设置', UPDATE: '修改', CANCEL: '取消' }[action] || action)

// 入库单列表
const loadInboundList = async () => {
  try {
    const res = await api.getInboundList(inboundQuery)
    if (res.code === 0) {
      inboundList.value = res.data?.list || []
      inboundTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载入库单列表失败')
  }
}

const loadReturnList = async () => {
  try {
    const res = await api.getReturnList(returnQuery)
    if (res.code === 0) {
      returnList.value = res.data?.list || []
      returnTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载退库申请失败')
  }
}

const viewInboundDetail = async (row) => {
  try {
    const res = await api.getInboundDetail(row.inbound_id)
    if (res.code === 0) {
      currentInbound.value = res.data
      inboundDetailVisible.value = true
    }
  } catch (err) {
    ElMessage.error('获取详情失败')
  }
}

// 打开执行入库对话框
const openExecuteDialog = async (row) => {
  try {
    const res = await api.getInboundDetail(row.inbound_id)
    if (res.code === 0) {
      currentInbound.value = res.data

      const pnMap = res.data.product_pns || {}

      const productGroups = []
      for (const item of (res.data.items || [])) {
        const needSn = item.need_sn === 1
        const qty = Number(item.quantity) || 1
        const pns = pnMap[item.product_id] || []

        const group = {
          inboundItemId: item.item_id,
          productId: item.product_id,
          productName: item.product_name,
          needSn,
          quantity: qty,
          locationId: item.location_id || '',
          locationName: item.location_name || '',
          pnCode: item.pn_code || (pns.length > 0 ? pns[0].pn_code : ''),
          pns: pns,
          snRows: [],
          qtyRows: []
        }

          if (needSn) {
            for (let i = 0; i < qty; i++) {
              group.snRows.push({
              snCode: item.sn_code || item.snCode || '',
              inventoryType: 'normal_qty',
                locationId: item.location_id || '',
                remark: ''
              })
            }
        } else {
          group.qtyRows.push({
            inventoryType: 'normal_qty',
            locationId: item.location_id || '',
            quantity: qty,
            remark: ''
          })
        }

        productGroups.push(group)
      }

      executeProducts.value = productGroups
      restoreInboundDraft()
      executeInboundVisible.value = true
    }
  } catch (err) {
    ElMessage.error('获取详情失败')
  }
}

const addQtyRow = (item) => {
  const remaining = item.quantity - allocatedQty(item)
  item.qtyRows.push({
    inventoryType: 'normal_qty',
    locationId: '',
    quantity: Math.max(1, remaining),
    remark: ''
  })
}

const onQtyChange = (item) => {
  // Vue reactivity handles this; computed allocation shown in template
}

const allocatedQty = (item) => {
  return (item.qtyRows || []).reduce((sum, r) => sum + (parseInt(r.quantity) || 0), 0)
}

const openAddPnDialog = (item) => {
  addPnTarget.value = item
  addPnPnCode.value = ''
  addPnVisible.value = true
}

const confirmAddPn = async () => {
  const target = addPnTarget.value
  if (!addPnPnCode.value.trim()) {
    ElMessage.warning('请输入厂商编码')
    return
  }
  if (!target || !target.productId) {
    ElMessage.warning('商品信息异常，请关闭后重试')
    return
  }
  try {
    const res = await api.addPn({
      productId: target.productId,
      pnCode: addPnPnCode.value.trim()
    })
    if (res.code === 0) {
      ElMessage.success('厂商编码添加成功')
      const newPn = { pn_id: res.pnId || '', pn_code: addPnPnCode.value.trim() }
      if (!target.pns) target.pns = []
      target.pns.push(newPn)
      if (!target.pnCode) {
        target.pnCode = newPn.pn_code
      }
      addPnVisible.value = false
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '添加失败'
    ElMessage.error(msg)
  }
}

const submitInbound = async () => {
  const items = []

  for (const product of executeProducts.value) {
    if (product.needSn) {
      for (const snRow of product.snRows) {
        if (!snRow.snCode || snRow.snCode.trim() === '') {
          ElMessage.warning(`商品 ${product.productName} 需要SN管理，请填写SN码`)
          return
        }
        items.push({
          inboundItemId: product.inboundItemId,
          productId: product.productId,
          pnCode: product.pnCode || '',
          snCode: snRow.snCode,
          quantity: 1,
          inventoryType: snRow.inventoryType || 'normal_qty',
          locationId: snRow.locationId || '',
          remark: snRow.remark
        })
      }
    } else {
      for (const qtyRow of product.qtyRows) {
        const qty = parseInt(qtyRow.quantity) || 0
        if (qty <= 0) continue
        items.push({
          inboundItemId: product.inboundItemId,
          productId: product.productId,
          pnCode: product.pnCode || '',
          snCode: '',
          quantity: qty,
          inventoryType: qtyRow.inventoryType || 'normal_qty',
          locationId: qtyRow.locationId || '',
          remark: qtyRow.remark
        })
      }

      const totalAllocated = allocatedQty(product)
      if (totalAllocated !== product.quantity) {
        ElMessage.warning(`商品 ${product.productName} 分配数量(${totalAllocated})与待入库数量(${product.quantity})不一致`)
        return
      }
    }
  }

  if (items.length === 0) {
    ElMessage.warning('没有可入库的商品')
    return
  }

  inboundLoading.value = true
  try {
    const res = await api.executeInbound({
      inboundId: currentInbound.value.inbound_id,
      items
    })

    if (res.code === 0) {
      ElMessage.success('入库完成')
      clearDraft(inboundDraftKey())
      executeInboundVisible.value = false
      loadInboundList()
    } else {
      ElMessage.error(res.message || '入库失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '入库失败'
    ElMessage.error(msg)
  } finally {
    inboundLoading.value = false
  }
}

const resetInboundForm = () => {
  executeProducts.value = []
}

const saveInboundDraft = () => {
  const key = inboundDraftKey()
  if (!key) return
  saveDraft(key, cloneDraft(executeProducts.value))
  ElMessage.success('草稿已保存')
}

const restoreInboundDraft = () => {
  const key = inboundDraftKey()
  if (!key) return
  const draft = loadDraft(key)
  if (!draft) return
  executeProducts.value = Array.isArray(draft) ? draft : executeProducts.value
  ElMessage.success('已恢复上次草稿')
}

const openReturnRequestDialog = (row) => {
  currentInbound.value = row
  returnReason.value = ''
  executeReturnVisible.value = true
}

const submitReturn = async () => {
  returnLoading.value = true
  try {
    const res = await api.requestReturn({
      inboundId: currentInbound.value.inbound_id,
      reason: returnReason.value
    })

    if (res.code === 0) {
      ElMessage.success(res.message || '退库申请已提交')
      executeReturnVisible.value = false
      loadInboundList()
      loadReturnList()
    } else {
      ElMessage.error(res.message || '退库申请失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '退库申请失败'
    ElMessage.error(msg)
  } finally {
    returnLoading.value = false
  }
}

const approveReturn = async (row, action) => {
  const isReject = action === 'rejected'
  try {
    const result = await ElMessageBox.prompt(
      isReject ? '请输入拒绝原因' : '可填写审批备注',
      isReject ? '拒绝退库申请' : '审批退库申请',
      {
        confirmButtonText: isReject ? '确认拒绝' : '确认通过',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '审批备注'
      }
    )
    const res = await api.approveReturn({
      returnId: row.return_id,
      action,
      comment: result.value || ''
    })
    if (res.code === 0) {
      ElMessage.success(res.message || '审批成功')
      loadReturnList()
    } else {
      ElMessage.error(res.message || '审批失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || err.message || '审批失败'
      ElMessage.error(msg)
    }
  }
}

const executeApprovedReturn = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认执行退库申请 ${row.return_no} 吗？执行后将扣减库存，并生成负向应付冲减供应商结算。`,
      '执行退库',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    )
    returnLoading.value = true
    const res = await api.executeReturn({ returnId: row.return_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '退库执行成功')
      loadReturnList()
      loadInboundList()
      loadSummary()
    } else {
      ElMessage.error(res.message || '退库执行失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || err.message || '退库执行失败'
      ElMessage.error(msg)
    }
  } finally {
    returnLoading.value = false
  }
}

// 查看序列号
const openSnDialog = (row) => {
  snProductId.value = row.product_id
  snProductName.value = row.product_name
  snFilter.page = 1
  snFilter.status = ''
  snFilter.snCode = ''
  snDialogVisible.value = true
  loadSnData()
}

const openSnLocationDialog = async (row) => {
  snLocationForm.snId = row.sn_id || ''
  snLocationForm.snCode = row.sn_code || ''
  snLocationForm.pnCode = row.pn_code || ''
  snLocationForm.productName = row.product_name || snProductName.value || ''
  snLocationForm.storeId = row.store_id || ''
  snLocationForm.storeName = row.store_name || ''
  snLocationForm.currentLocationId = row.location_id || ''
  snLocationForm.currentLocationName = row.location_name || '未指定库位'
  snLocationForm.targetLocationId = ''
  snLocationOptions.value = []
  snLocationDialogVisible.value = true
  snLocationLoading.value = true
  try {
    const res = await api.getLocationsByStore(snLocationForm.storeId)
    if (res.code === 0) {
      snLocationOptions.value = res.data || []
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载库位失败')
  } finally {
    snLocationLoading.value = false
  }
}

const saveSnLocation = async () => {
  if (!snLocationForm.targetLocationId) {
    ElMessage.warning('请选择目标库位')
    return
  }
  if (snLocationForm.targetLocationId === snLocationForm.currentLocationId) {
    ElMessage.warning('目标库位与当前库位相同')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认将 SN ${snLocationForm.snCode} 调整到“${snLocationOptions.value.find(item => item.location_id === snLocationForm.targetLocationId)?.name || ''}”吗？`,
      '确认调整库位',
      { type: 'warning' }
    )
  } catch (err) {
    return
  }

  snLocationSaving.value = true
  try {
    const res = await api.adjustSnLocation(snLocationForm.snId, {
      storeId: snLocationForm.storeId,
      locationId: snLocationForm.targetLocationId
    })
    if (res.code === 0) {
      ElMessage.success(res.message || '库位调整成功')
      snLocationDialogVisible.value = false
      loadSnData()
      loadSnInventory()
      loadSummary()
    } else {
      ElMessage.error(res.message || '库位调整失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '库位调整失败')
  } finally {
    snLocationSaving.value = false
  }
}

const loadSnData = async () => {
  snLoading.value = true
  try {
    const res = await api.getSnList({
      productId: snProductId.value,
      status: snFilter.status,
      snCode: snFilter.snCode,
      page: snFilter.page,
      pageSize: snFilter.pageSize
    })
    if (res.code === 0) {
      snTableData.value = res.data?.list || []
      snTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载SN数据失败')
  } finally {
    snLoading.value = false
  }
}

const startSnEdit = () => {
  snOriginalCodes.value = {}
  snTableData.value.forEach((row, idx) => {
    snOriginalCodes.value[row.sn_id || idx] = row.sn_code
  })
  snEditing.value = true
}

const cancelSnEdit = () => {
  for (const key in snOriginalCodes.value) {
    const row = snTableData.value.find(r => (r.sn_id || '') === key || snTableData.value.indexOf(r) === Number(key))
    if (row) {
      row.sn_code = snOriginalCodes.value[key]
    }
  }
  snEditing.value = false
}

const finishSnEdit = async () => {
  const changed = []
  for (const row of snTableData.value) {
    const original = snOriginalCodes.value[row.sn_id] || snOriginalCodes.value[snTableData.value.indexOf(row)]
    if (original !== undefined && original !== row.sn_code) {
      if (!row.sn_code || row.sn_code.trim() === '') {
        ElMessage.warning('SN码不能为空')
        return
      }
      changed.push({ snId: row.sn_id, oldCode: original, newCode: row.sn_code.trim() })
    }
  }

  if (changed.length === 0) {
    snEditing.value = false
    return
  }

  ElMessage.info(`正在更新 ${changed.length} 条SN记录...`)
  let successCount = 0
  for (const ch of changed) {
    try {
      const res = await api.updateSn(ch.snId, { newSnCode: ch.newCode })
      if (res.code === 0) {
        successCount++
      } else {
        ElMessage.error(`SN ${ch.oldCode} 修改失败: ${res.message || '未知错误'}`)
      }
    } catch (err) {
      ElMessage.error(`SN ${ch.oldCode} 修改异常`)
    }
  }

  if (successCount > 0) {
    ElMessage.success(`成功修改 ${successCount} 条SN记录`)
  }
  snEditing.value = false
  loadSnData()
}

const openSnTrace = async (row) => {
  traceSnCode.value = row.sn_code
  traceDialogVisible.value = true
  traceLoading.value = true
  traceTimeline.value = []
  try {
    const res = await api.snTrace(row.sn_code, { pnCode: row.pn_code || '' })
    if (res.code === 0) {
      traceTimeline.value = res.data?.timeline || []
      traceCurrentStatus.value = res.data?.currentStatus || ''
      traceProductName.value = res.data?.productName || row.product_name || row.product_id || '-'
    }
  } catch (err) {
    ElMessage.error('查询SN追踪失败')
  } finally {
    traceLoading.value = false
  }
}

const goToOrder = async (row) => {
  traceSnCode.value = row.sn_code
  traceLoading.value = true
  try {
    const res = await api.snTrace(row.sn_code, { pnCode: row.pn_code || '' })
    if (res.code === 0) {
      const saleEvents = (res.data?.timeline || []).filter(e => e.type === 'sale')
      if (saleEvents.length > 0 && saleEvents[0].ref_id) {
        goToOrderFromTrace(saleEvents[0].ref_id)
      } else {
        ElMessage.info('未找到关联的销售订单')
      }
    }
  } catch (err) {
    ElMessage.error('查询订单失败')
  } finally {
    traceLoading.value = false
  }
}

const goToOrderFromTrace = (orderId) => {
  if (!orderId) return
  traceDialogVisible.value = false
  router.push({ name: 'Sales', query: { orderId } })
}

const getStoreName = (storeId) => {
  return stores.value.find(store => store.store_id === storeId)?.name || ''
}

const openTransferApplyDialog = async () => {
  resetTransferForm()
  if (isStoreUser()) {
    transferForm.fromStoreId = getStoreId()
    transferForm.fromStoreName = getStoreName(transferForm.fromStoreId)
  }
  restoreTransferDraft()
  transferDialogVisible.value = true
  if (transferForm.fromStoreId) {
    await searchTransferProducts('')
  }
}

const onTransferFromStoreChange = async (storeId) => {
  transferForm.fromStoreName = getStoreName(storeId)
  transferForm.toStoreId = transferForm.toStoreId === storeId ? '' : transferForm.toStoreId
  transferForm.items = []
  transferAddForm.productId = ''
  transferAddForm.snId = ''
  transferAddForm.quantity = 1
  transferProductOptions.value = []
  transferSnOptions.value = []
  if (storeId) {
    await searchTransferProducts('')
  }
}

const searchTransferProducts = async (keyword = '') => {
  if (!transferForm.fromStoreId) {
    transferProductOptions.value = []
    return
  }
  try {
    const res = await api.getInventoryList({
      storeId: transferForm.fromStoreId,
      keyword,
      page: 1,
      pageSize: 50
    })
    if (res.code === 0) {
      transferProductOptions.value = (res.data?.list || []).filter(item => Number(item.normal_qty || 0) > 0)
    }
  } catch (err) {
    ElMessage.error('搜索可调拨商品失败')
  }
}

const onTransferProductChange = async () => {
  transferAddForm.snId = ''
  transferAddForm.quantity = 1
  transferSnOptions.value = []
}

const loadTransferProductSns = async () => {
  if (!transferForm.fromStoreId || !transferAddForm.productId) return
  try {
    const res = await api.getSnList({
      productId: transferAddForm.productId,
      storeId: transferForm.fromStoreId,
      status: 'in_stock',
      page: 1,
      pageSize: 100
    })
    if (res.code === 0) {
      transferSnOptions.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('加载可调拨SN失败')
  }
}

const addTransferProductItem = () => {
  if (!transferForm.fromStoreId) {
    ElMessage.warning('\u8bf7\u9009\u62e9\u8c03\u51fa\u95e8\u5e97')
    return
  }
  const product = transferProductOptions.value.find(item => item.product_id === transferAddForm.productId)
  if (!product) {
    ElMessage.warning('\u8bf7\u9009\u62e9\u8c03\u62e8\u5546\u54c1')
    return
  }

  const quantity = Number(transferAddForm.quantity || 0)
  const availableQty = Number(product.normal_qty || 0)
  if (quantity <= 0) {
    ElMessage.warning('\u8bf7\u8f93\u5165\u8c03\u62e8\u6570\u91cf')
    return
  }
  if (quantity > availableQty) {
    ElMessage.warning('\u8c03\u62e8\u6570\u91cf\u4e0d\u80fd\u8d85\u8fc7\u5e93\u5b58 ' + availableQty)
    return
  }

  const existing = transferForm.items.find(item => !item.snId && item.productId === product.product_id)
  if (existing) {
    const nextQty = Number(existing.quantity || 0) + quantity
    if (nextQty > availableQty) {
      ElMessage.warning('\u8be5\u5546\u54c1\u7d2f\u8ba1\u8c03\u62e8\u6570\u91cf\u4e0d\u80fd\u8d85\u8fc7\u5e93\u5b58 ' + availableQty)
      return
    }
    existing.quantity = nextQty
  } else {
    transferForm.items.push({
      snId: null,
      snCode: '',
      productId: product.product_id,
      productName: product.product_name || product.name || '',
      quantity
    })
  }

  transferAddForm.productId = ''
  transferAddForm.snId = ''
  transferAddForm.quantity = 1
  transferSnOptions.value = []
}

const openTransferDialog = (row) => {
  const existingIdx = transferForm.items.findIndex(i => i.snId === row.sn_id)
  if (existingIdx >= 0) {
    transferForm.items.splice(existingIdx, 1)
    return
  }
  if (transferForm.items.length === 0) {
    transferForm.fromStoreId = row.store_id || ''
    transferForm.fromStoreName = row.store_name || ''
  }
  if (transferForm.fromStoreId && transferForm.items.length > 0 && row.store_id !== transferForm.fromStoreId) {
    ElMessage.warning('只能调拨同一门店的商品')
    return
  }
  if (!transferForm.fromStoreId) {
    transferForm.fromStoreId = row.store_id || ''
    transferForm.fromStoreName = row.store_name || ''
  }
  transferForm.items.push({
    snId: row.sn_id,
    snCode: row.sn_code,
    productId: row.product_id,
    productName: row.product_name || '',
    quantity: 1
  })
  transferDialogVisible.value = true
}

const formatTransferItemLabel = (item) => {
  const name = item.product_name || item.productName || item.product_id || '-'
  const pn = item.pn_code || item.pnCode || '-'
  const sn = item.sn_code || item.snCode || (Number(item.need_sn || item.needSn || 0) === 1 ? '待出库确认' : '不适用')
  return `${name} / PN:${pn} / SN:${sn} x${item.quantity || 0}`
}

const resetTransferForm = () => {
  transferForm.fromStoreId = ''
  transferForm.fromStoreName = ''
  transferForm.toStoreId = ''
  transferForm.items = []
  transferAddForm.productId = ''
  transferAddForm.snId = ''
  transferAddForm.quantity = 1
  transferProductOptions.value = []
  transferSnOptions.value = []
}

const saveTransferDraft = () => {
  saveDraft(TRANSFER_DRAFT_KEY, cloneDraft(transferForm))
  ElMessage.success('草稿已保存')
}

const restoreTransferDraft = () => {
  const draft = loadDraft(TRANSFER_DRAFT_KEY)
  if (!draft) return
  Object.assign(transferForm, draft)
  transferForm.items = Array.isArray(draft.items) ? draft.items : []
  ElMessage.success('已恢复上次草稿')
}

const submitTransfer = async () => {
  if (!transferForm.fromStoreId) {
    ElMessage.warning('请选择调出门店')
    return
  }
  if (!transferForm.toStoreId) {
    ElMessage.warning('请选择调入门店')
    return
  }
  if (transferForm.items.length === 0) {
    ElMessage.warning('请添加调拨商品')
    return
  }
  transferLoading.value = true
  try {
    const res = await api.transfer({
      fromStoreId: transferForm.fromStoreId,
      toStoreId: transferForm.toStoreId,
      items: transferForm.items
    })
    if (res.code === 0) {
      ElMessage.success('调拨申请已创建')
      clearDraft(TRANSFER_DRAFT_KEY)
      transferDialogVisible.value = false
      resetTransferForm()
      loadSnData()
      loadTransferLists()
    } else {
      ElMessage.error(res.message || '调拨失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '调拨失败'
    ElMessage.error(msg)
  } finally {
    transferLoading.value = false
  }
}

const loadTransferLists = async () => {
  try {
    const [outRes, inRes] = await Promise.all([
      api.getTransferList({ status: 'pending', page: 1, pageSize: 100 }),
      api.getTransferList({ status: 'out_confirmed', page: 1, pageSize: 100 })
    ])
    if (outRes.code === 0) {
      transferOutList.value = outRes.data?.list || []
    }
    if (inRes.code === 0) {
      transferInList.value = inRes.data?.list || []
    }
    await loadTransferHistory()
  } catch (err) {
    ElMessage.error('加载调拨列表失败')
  }
}

const loadTransferHistory = async () => {
  transferHistoryLoading.value = true
  try {
    const res = await api.getTransferList({
      history: 1,
      page: transferHistoryQuery.page,
      pageSize: transferHistoryQuery.pageSize,
      transferNo: transferHistoryQuery.transferNo || undefined,
      status: transferHistoryQuery.status || undefined,
      startDate: transferHistoryQuery.startDate || undefined,
      endDate: transferHistoryQuery.endDate || undefined
    })
    if (res.code === 0) {
      transferHistoryList.value = res.data?.list || []
      transferHistoryTotal.value = Number(res.data?.total || 0)
    }
  } catch (err) {
    ElMessage.error('加载历史调拨记录失败')
  } finally {
    transferHistoryLoading.value = false
  }
}

const resetTransferHistoryQuery = () => {
  Object.assign(transferHistoryQuery, {
    page: 1,
    pageSize: 20,
    transferNo: '',
    status: '',
    startDate: '',
    endDate: ''
  })
  loadTransferHistory()
}

const handleConfirmTransferOut = async (row) => {
  const snItems = (row.TransferItems || []).filter(item => Number(item.need_sn || 0) === 1 && !item.sn_id)
  if (snItems.length > 0) {
    transferOutConfirmRow.value = row
    transferOutSnRows.value = snItems.map(item => ({
      itemId: item.item_id,
      productId: item.product_id,
      productName: item.product_name || item.product_id || '-',
      snId: '',
      snOptions: []
    }))
    transferOutConfirmVisible.value = true
    await loadTransferOutSnOptions(row)
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认将调拨单 ${row.transfer_no} 的商品从「${row.from_store_name}」出库吗？`,
      '确认调拨出库',
      { confirmButtonText: '确认出库', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.confirmTransferOut({ transferId: row.transfer_id })
    if (res.code === 0) {
      ElMessage.success('调拨出库确认成功')
      loadTransferLists()
    } else {
      ElMessage.error(res.message || '确认出库失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || err.message || '确认出库失败'
      ElMessage.error(msg)
    }
  }
}

const loadTransferOutSnOptions = async (row) => {
  transferOutSnLoading.value = true
  try {
    const productIds = [...new Set(transferOutSnRows.value.map(item => item.productId).filter(Boolean))]
    const optionsMap = {}
    await Promise.all(productIds.map(async (productId) => {
      const res = await api.getSnList({
        productId,
        storeId: row.from_store_id,
        status: 'in_stock',
        page: 1,
        pageSize: 500
      })
      optionsMap[productId] = res.code === 0 ? (res.data?.list || []) : []
    }))
    transferOutSnRows.value.forEach(item => {
      item.snOptions = optionsMap[item.productId] || []
    })
  } catch (err) {
    ElMessage.error('加载可选SN失败')
  } finally {
    transferOutSnLoading.value = false
  }
}

const isConfirmSnDisabled = (snId, currentRow) => {
  return transferOutSnRows.value.some(row => row !== currentRow && row.snId === snId)
}

const submitConfirmTransferOut = async () => {
  if (!transferOutConfirmRow.value) return
  const missing = transferOutSnRows.value.find(row => !row.snId)
  if (missing) {
    ElMessage.warning(`请选择 ${missing.productName} 的SN`)
    return
  }

  transferOutConfirmLoading.value = true
  try {
    const res = await api.confirmTransferOut({
      transferId: transferOutConfirmRow.value.transfer_id,
      items: transferOutSnRows.value.map(row => ({ itemId: row.itemId, snId: row.snId }))
    })
    if (res.code === 0) {
      ElMessage.success('调拨出库确认成功')
      transferOutConfirmVisible.value = false
      resetTransferOutConfirm()
      loadTransferLists()
      loadSummary()
      loadSnData()
    } else {
      ElMessage.error(res.message || '确认出库失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '确认出库失败'
    ElMessage.error(msg)
  } finally {
    transferOutConfirmLoading.value = false
  }
}

const resetTransferOutConfirm = () => {
  transferOutConfirmRow.value = null
  transferOutSnRows.value = []
  transferOutSnLoading.value = false
  transferOutConfirmLoading.value = false
}

const handleConfirmTransferIn = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将调拨单 ${row.transfer_no} 的商品入库到「${row.to_store_name}」吗？`,
      '确认调拨入库',
      { confirmButtonText: '确认入库', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.confirmTransferIn({ transferId: row.transfer_id })
    if (res.code === 0) {
      ElMessage.success('调拨入库确认成功，调拨完成')
      loadTransferLists()
    } else {
      ElMessage.error(res.message || '确认入库失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || err.message || '确认入库失败'
      ElMessage.error(msg)
    }
  }
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100
}

const loadConversionList = async () => {
  conversionLoading.value = true
  try {
    const res = await api.getConversionList(conversionQuery)
    if (res.code === 0) {
      conversionList.value = res.data?.list || []
      conversionTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载拆装单失败')
  } finally {
    conversionLoading.value = false
  }
}

const openConversionDialog = async (type) => {
  resetConversionForm()
  conversionForm.conversionType = type
  if (isStoreUser()) {
    conversionForm.storeId = getStoreId()
  }
  conversionDialogVisible.value = true
  if (conversionForm.storeId) {
    await searchConversionSourceProducts('')
  }
  await searchConversionTargetProducts('')
}

const resetConversionForm = () => {
  conversionForm.conversionType = conversionForm.conversionType || 'split'
  conversionForm.storeId = isStoreUser() ? getStoreId() : ''
  conversionForm.serviceCost = 0
  conversionForm.remark = ''
  conversionForm.sourceItems = []
  conversionForm.targetItems = []
  conversionSourceAdd.productId = ''
  conversionSourceAdd.snId = ''
  conversionSourceAdd.quantity = 1
  conversionSourceAdd.unitCost = 0
  conversionTargetAdd.productId = ''
  conversionTargetAdd.pnCode = ''
  conversionTargetAdd.snCode = ''
  conversionTargetAdd.quantity = 1
  conversionTargetAdd.unitCost = 0
  conversionSourceOptions.value = []
  conversionTargetOptions.value = []
  conversionSourceSnOptions.value = []
}

const onConversionStoreChange = async () => {
  conversionForm.sourceItems = []
  conversionSourceAdd.productId = ''
  conversionSourceAdd.snId = ''
  conversionSourceOptions.value = []
  conversionSourceSnOptions.value = []
  if (conversionForm.storeId) {
    await searchConversionSourceProducts('')
  }
}

const searchConversionSourceProducts = async (keyword = '') => {
  if (!conversionForm.storeId) {
    conversionSourceOptions.value = []
    return
  }
  try {
    const res = await api.getInventoryList({
      storeId: conversionForm.storeId,
      keyword,
      page: 1,
      pageSize: 50
    })
    if (res.code === 0) {
      conversionSourceOptions.value = (res.data?.list || []).filter(item => Number(item.normal_qty || 0) > 0)
    }
  } catch (err) {
    ElMessage.error('搜索来源商品失败')
  }
}

const searchConversionTargetProducts = async (keyword = '') => {
  try {
    const res = await api.getProductList({
      keyword,
      page: 1,
      pageSize: 50
    })
    if (res.code === 0) {
      conversionTargetOptions.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('搜索目标商品失败')
  }
}

const loadConversionProductCategoryTree = async () => {
  if (conversionProductCategoryTree.value.length > 0) return
  try {
    const res = await api.getCategoryTree()
    if (res.code === 0) conversionProductCategoryTree.value = res.data || []
  } catch (err) {
    ElMessage.error('加载商品分类失败')
  }
}

const onConversionProductCategoryChange = async (value) => {
  conversionProductForm.attributes = {}
  conversionProductCategoryFields.value = []
  conversionProductCategoryFieldName.value = ''
  if (!value) return

  try {
    const res = await api.getCategoryFieldConfig(value)
    if (res.code === 0 && res.data?.fields) {
      conversionProductCategoryFields.value = res.data.fields
      conversionProductCategoryFieldName.value = res.data.categoryName || ''
    }
  } catch (err) {
    ElMessage.error('加载分类字段失败')
  }
}

const resetConversionProductForm = () => {
  conversionProductForm.categoryId = ''
  conversionProductForm.config = ''
  conversionProductForm.brand = ''
  conversionProductForm.series = ''
  conversionProductForm.model = ''
  conversionProductForm.processor = ''
  conversionProductForm.memory = ''
  conversionProductForm.storage = ''
  conversionProductForm.color = ''
  conversionProductForm.gpu = ''
  conversionProductForm.accessory_type = ''
  conversionProductForm.unit = '台'
  conversionProductForm.needSn = false
  conversionProductForm.needImei = false
  conversionProductForm.remark = ''
  conversionProductForm.status = 1
  conversionProductForm.barcodes = []
  conversionProductForm.attributes = {}
  conversionProductForm.customName = ''
  conversionProductCategoryFields.value = []
  conversionProductCategoryFieldName.value = ''
  conversionProductNewBarcode.value = ''
  conversionProductBarcodeType.value = 'manufacturer'
}

const openConversionProductDialog = async () => {
  resetConversionProductForm()
  await loadConversionProductCategoryTree()
  conversionProductDialogVisible.value = true
}

const addConversionProductBarcode = () => {
  const code = conversionProductNewBarcode.value.trim()
  if (!code) {
    ElMessage.warning('请输入条码')
    return
  }
  conversionProductForm.barcodes.push({ type: conversionProductBarcodeType.value, code })
  conversionProductNewBarcode.value = ''
}

const buildConversionProductPayload = () => {
  const finalName = conversionProductName.value
  if (!finalName) {
    ElMessage.warning('请填写商品属性或商品简称')
    return null
  }

  const attributes = {}
  for (const field of conversionProductStandardFields) {
    if (conversionProductForm[field]) attributes[field] = conversionProductForm[field]
  }
  for (const [key, value] of Object.entries(conversionProductForm.attributes)) {
    if (!conversionProductStandardFields.includes(key) && value) attributes[key] = value
  }

  return {
    name: finalName,
    categoryId: conversionProductForm.categoryId || null,
    config: conversionProductForm.config,
    unit: conversionProductForm.unit,
    needSn: conversionProductForm.needSn ? 1 : 0,
    needImei: conversionProductForm.needImei ? 1 : 0,
    remark: conversionProductForm.remark,
    status: conversionProductForm.status,
    barcodes: conversionProductForm.barcodes,
    attributes: Object.keys(attributes).length > 0 ? attributes : null
  }
}

const selectNewConversionTargetProduct = async (productId, fallbackProduct) => {
  await searchConversionTargetProducts(fallbackProduct.name || '')
  let product = conversionTargetOptions.value.find(item => item.product_id === productId)
  if (!product) {
    product = fallbackProduct
    conversionTargetOptions.value.unshift(product)
  }
  conversionTargetAdd.productId = product.product_id
  onConversionTargetProductChange()
}

const submitConversionProduct = async () => {
  const data = buildConversionProductPayload()
  if (!data) return

  conversionProductSubmitLoading.value = true
  try {
    const res = await api.createProduct(data)
    if (res.code === 0) {
      if (res.pendingApproval) {
        conversionProductDialogVisible.value = false
        ElMessage.success('新建商品申请已提交，审批通过后才能作为拆装目标商品')
        return
      }
      const productId = res.productId || res.data?.productId
      const manufacturerCode = data.barcodes
        .filter(item => item.type === 'manufacturer' && item.code)
        .map(item => item.code)
        .join(', ')
      await selectNewConversionTargetProduct(productId, {
        product_id: productId,
        name: data.name,
        product_name: data.name,
        manufacturer_code: manufacturerCode,
        need_sn: data.needSn ? 1 : 0,
        cost_price: 0
      })
      conversionProductDialogVisible.value = false
      ElMessage.success('商品创建成功，已自动选择')
    } else {
      ElMessage.error(res.message || '商品创建失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '商品创建失败')
  } finally {
    conversionProductSubmitLoading.value = false
  }
}

const onConversionSourceProductChange = async () => {
  conversionSourceAdd.snId = ''
  conversionSourceAdd.quantity = 1
  conversionSourceAdd.unitCost = 0
  conversionSourceSnOptions.value = []
  const product = selectedConversionSourceProduct.value
  if (product?.need_sn === 1 && conversionForm.storeId) {
    try {
      const res = await api.getSnList({
        productId: product.product_id,
        storeId: conversionForm.storeId,
        status: 'in_stock',
        page: 1,
        pageSize: 200
      })
      if (res.code === 0) {
        conversionSourceSnOptions.value = res.data?.list || []
      }
    } catch (err) {
      ElMessage.error('加载来源SN失败')
    }
  } else if (product) {
    conversionSourceAdd.unitCost = roundMoney(product.cost_price || 0)
  }
}

const onConversionSourceSnChange = () => {
  const sn = conversionSourceSnOptions.value.find(item => item.sn_id === conversionSourceAdd.snId)
  conversionSourceAdd.unitCost = roundMoney(sn?.inbound_price || 0)
}

const onConversionTargetProductChange = () => {
  const product = selectedConversionTargetProduct.value
  conversionTargetAdd.pnCode = product?.manufacturer_code ? String(product.manufacturer_code).split(/[,，\s]+/)[0] : ''
  conversionTargetAdd.snCode = ''
  conversionTargetAdd.quantity = 1
  conversionTargetAdd.unitCost = roundMoney(product?.cost_price || 0)
}

const addConversionSourceItem = () => {
  const product = selectedConversionSourceProduct.value
  if (!product) {
    ElMessage.warning('请选择来源商品')
    return
  }

  let sn = null
  let quantity = Number(conversionSourceAdd.quantity || 1)
  let unitCost = roundMoney(conversionSourceAdd.unitCost || 0)
  if (product.need_sn === 1) {
    sn = conversionSourceSnOptions.value.find(item => item.sn_id === conversionSourceAdd.snId)
    if (!sn) {
      ElMessage.warning('请选择来源SN')
      return
    }
    if (conversionForm.sourceItems.some(item => item.snId === sn.sn_id)) {
      ElMessage.warning('该SN已添加')
      return
    }
    quantity = 1
    unitCost = unitCost > 0 ? unitCost : roundMoney(sn.inbound_price || 0)
  }

  if (conversionForm.conversionType === 'split' && conversionForm.sourceItems.length > 0) {
    ElMessage.warning('拆分单一次只能选择一个被拆商品')
    return
  }
  if (conversionForm.conversionType === 'split' && quantity !== 1) {
    ElMessage.warning('拆分单被拆商品数量只能为1')
    return
  }
  if (quantity <= 0 || unitCost <= 0) {
    ElMessage.warning('数量和成本必须大于0')
    return
  }
  if (product.need_sn !== 1 && quantity > Number(product.normal_qty || 0)) {
    ElMessage.warning(`来源商品库存不足，可用 ${product.normal_qty || 0}`)
    return
  }

  conversionForm.sourceItems.push({
    productId: product.product_id,
    productName: product.product_name || product.name || '',
    pnCode: sn?.pn_code || (product.manufacturer_code ? String(product.manufacturer_code).split(/[,，\s]+/)[0] : ''),
    snId: sn?.sn_id || '',
    snCode: sn?.sn_code || '',
    quantity,
    unitCost,
    totalCost: roundMoney(quantity * unitCost),
    inventoryType: sn?.inventory_type || 'normal_qty',
    locationId: sn?.location_id || ''
  })

  conversionSourceAdd.productId = ''
  conversionSourceAdd.snId = ''
  conversionSourceAdd.quantity = 1
  conversionSourceAdd.unitCost = 0
  conversionSourceSnOptions.value = []
}

const addConversionTargetItem = () => {
  const product = selectedConversionTargetProduct.value
  if (!product) {
    ElMessage.warning('请选择目标商品')
    return
  }

  const quantity = product.need_sn === 1 ? 1 : Number(conversionTargetAdd.quantity || 1)
  const unitCost = roundMoney(conversionTargetAdd.unitCost || 0)
  if (quantity <= 0 || unitCost <= 0) {
    ElMessage.warning('数量和成本必须大于0')
    return
  }
  if (product.need_sn === 1 && !conversionTargetAdd.snCode.trim()) {
    ElMessage.warning('目标商品需要录入SN')
    return
  }

  conversionForm.targetItems.push({
    productId: product.product_id,
    productName: product.name || product.product_name || '',
    pnCode: conversionTargetAdd.pnCode,
    snCode: conversionTargetAdd.snCode.trim(),
    quantity,
    unitCost,
    totalCost: roundMoney(quantity * unitCost),
    inventoryType: 'normal_qty',
    locationId: ''
  })

  conversionTargetAdd.productId = ''
  conversionTargetAdd.pnCode = ''
  conversionTargetAdd.snCode = ''
  conversionTargetAdd.quantity = 1
  conversionTargetAdd.unitCost = 0
}

const submitConversion = async () => {
  if (!conversionForm.storeId) {
    ElMessage.warning('请选择转换门店')
    return
  }
  if (!conversionCostMatched.value) {
    ElMessage.warning(conversionForm.conversionType === 'split' ? '拆出金额不能超过来源成本' : '成本不守恒，不能执行')
    return
  }

  conversionSubmitLoading.value = true
  try {
    const res = await api.createConversion({
      conversionType: conversionForm.conversionType,
      storeId: conversionForm.storeId,
      serviceCost: conversionForm.serviceCost,
      remark: conversionForm.remark,
      sourceItems: conversionForm.sourceItems,
      targetItems: conversionForm.targetItems
    })
    if (res.code === 0) {
      ElMessage.success(res.message || '库存转换已完成')
      conversionDialogVisible.value = false
      loadConversionList()
      loadSummary()
    } else {
      ElMessage.error(res.message || '库存转换失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '库存转换失败'
    ElMessage.error(msg)
  } finally {
    conversionSubmitLoading.value = false
  }
}

const viewConversionDetail = async (row) => {
  try {
    const res = await api.getConversionDetail(row.conversion_id)
    if (res.code === 0) {
      currentConversion.value = res.data
      conversionDetailVisible.value = true
    }
  } catch (err) {
    ElMessage.error('加载拆装单详情失败')
  }
}

const handleVoidConversion = async (row) => {
  try {
    const result = await ElMessageBox.prompt(
      `确认冲销拆装单 ${row.conversion_no} 吗？已销售或占用的目标SN不能冲销。`,
      '冲销拆装单',
      { confirmButtonText: '确认冲销', cancelButtonText: '取消', inputPlaceholder: '冲销原因' }
    )
    const res = await api.voidConversion(row.conversion_id, { reason: result.value || '' })
    if (res.code === 0) {
      ElMessage.success(res.message || '冲销成功')
      loadConversionList()
      loadSummary()
    } else {
      ElMessage.error(res.message || '冲销失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const msg = err.response?.data?.message || err.message || '冲销失败'
      ElMessage.error(msg)
    }
  }
}

const getConversionTypeText = (type) => {
  return type === 'assemble' ? '组装' : '拆分'
}

const getConversionStatusText = (status) => {
  const map = { completed: '已完成', voided: '已冲销' }
  return map[status] || status
}

const getConversionLineRoleText = (role) => {
  const map = { source: '来源', target: '目标', service: '服务' }
  return map[role] || role
}

const getTransferStatusType = (status) => {
  const types = { pending: 'warning', shipping: 'info', out_confirmed: 'info', received: 'success', completed: 'success', cancelled: 'danger' }
  return types[status] || 'info'
}

const getTransferStatusText = (status) => {
  const texts = { pending: '待出库', shipping: '发货中', out_confirmed: '待入库', received: '已收货', completed: '已完成', cancelled: '已取消' }
  return texts[status] || status
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
  const types = { in_stock: 'success', sold: 'warning', damaged: 'danger', available: 'success', used: 'warning', scrapped: 'danger', returned: 'info', return_pending: 'warning' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { in_stock: '在库', sold: '已售', damaged: '损坏', available: '可用', used: '已使用', scrapped: '已报废', returned: '已退库', return_pending: '退库待入库' }
  return texts[status] || status
}

const getInboundStatusType = (status) => {
  const types = { pending: 'warning', completed: 'success', cancelled: 'info', returned: 'danger' }
  return types[status] || 'info'
}

const getInboundStatusText = (status) => {
  const texts = { pending: '待入库', completed: '已完成', cancelled: '已取消', returned: '已退库' }
  return texts[status] || status
}

const getReturnStatusType = (status) => {
  const types = { pending: 'warning', approved: 'primary', rejected: 'danger', completed: 'success' }
  return types[status] || 'info'
}

const getReturnStatusText = (status) => {
  const texts = { pending: '待审批', approved: '待执行', rejected: '已拒绝', completed: '已退库' }
  return texts[status] || status
}
</script>

<style scoped>
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
.batch-maintenance-layout {
  min-width: 0;
}
.batch-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.age-separator {
  align-self: center;
  color: #909399;
}
.resource-status-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.muted {
  color: #909399;
}
.price-warning {
  margin: -4px 0 18px 90px;
  width: calc(100% - 90px);
}
.execute-item-section {
  margin-bottom: 20px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 12px;
}
.execute-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.item-label {
  font-weight: 600;
  font-size: 14px;
}
.item-qty {
  color: #666;
  font-size: 13px;
  margin-left: auto;
}
.item-location {
  color: #409eff;
  font-size: 13px;
}
.sn-table {
  margin-top: 8px;
}
.no-sn-item {
  padding: 8px 0;
}
.mt-20 {
  margin-top: 20px;
}
.mt-30 {
  margin-top: 30px;
}
.transfer-section {
  margin-bottom: 20px;
}
.conversion-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.conversion-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.conversion-cost-check {
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  background: #f5f7fa;
  color: #303133;
  font-weight: 600;
}
.conversion-cost-check.invalid {
  border-color: #f56c6c;
  background: #fef0f0;
  color: #c45656;
}
.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  padding-left: 8px;
  border-left: 3px solid #409eff;
}
.stock-breakdown {
  font-size: 13px;
  line-height: 2;
}
.inventory-resource-legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fafafa;
  color: #606266;
  font-size: 13px;
}
.legend-title {
  color: #303133;
  font-weight: 600;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.full-resource {
  background: #67c23a;
}
.subsidy-resource {
  background: #e6a23c;
}
.no-subsidy-resource {
  background: #f56c6c;
}
.stock-quantity-reference {
  cursor: help;
  color: #409eff;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
.breakdown-locations {
  border-top: 1px solid #ebeef5;
  margin-top: 6px;
  padding-top: 6px;
}
.breakdown-title {
  color: #606266;
  font-weight: 600;
}
.breakdown-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.breakdown-location {
  margin-top: 6px;
}
.breakdown-label {
  color: #909399;
}
.breakdown-value {
  color: #303133;
  font-weight: 600;
}
.breakdown-empty {
  color: #909399;
}
.warehouse-values {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: #303133;
  font-weight: 600;
}
</style>
