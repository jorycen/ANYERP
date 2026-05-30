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
                <el-popover placement="bottom" :width="260" trigger="hover" v-if="row.normal_qty > 0">
                  <template #default>
                    <div class="stock-breakdown">
                      <div class="breakdown-item">
                        <span class="breakdown-label">正规货：</span>
                        <span class="breakdown-value">{{ row.regular_qty || 0 }}</span>
                      </div>
                      <div class="breakdown-item">
                        <span class="breakdown-label">国补货：</span>
                        <span class="breakdown-value">{{ row.subsidy_qty || 0 }}</span>
                      </div>
                      <div class="breakdown-item">
                        <span class="breakdown-label">纯二批：</span>
                        <span class="breakdown-value">{{ row.second_qty || 0 }}</span>
                      </div>
                      <div v-if="row.store_stock_info && row.store_stock_info.length" class="breakdown-locations">
                        <div class="breakdown-title">门店 / 库位</div>
                        <div v-for="loc in row.store_stock_info" :key="`${loc.store_id}-${loc.location_id || 'none'}`" class="breakdown-item">
                          <span class="breakdown-label">{{ loc.store_name }} / {{ loc.location_name || '未指定库位' }}：</span>
                          <span class="breakdown-value">{{ loc.normal_qty || 0 }}</span>
                        </div>
                      </div>
                    </div>
                  </template>
                  <template #reference>
                    <span style="cursor: pointer; color: #409eff; text-decoration: underline;">{{ row.normal_qty }}</span>
                  </template>
                </el-popover>
                <span v-else>0</span>
              </template>
            </el-table-column>
            <el-table-column prop="display_qty" label="铺货仓库存" width="110" />
            <el-table-column prop="demo_qty" label="样机库存" width="100" />
            <el-table-column prop="unsellable_qty" label="不可售库存" width="110" />
            <el-table-column prop="pending_qty" label="待入库库存" width="110" />
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

        <!-- 入库单管理 -->
        <el-tab-pane label="入库单管理" name="inbound">
          <div class="filter-bar">
            <el-select v-model="inboundQuery.status" placeholder="状态" clearable style="width: 120px" @change="loadInboundList">
              <el-option label="全部" value="" />
              <el-option label="待入库" value="pending" />
              <el-option label="已完成" value="completed" />
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
                <el-button link type="danger" @click="executeReturn(row)" v-if="row.status === 'completed'">退库</el-button>
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
        </el-tab-pane>

        <el-tab-pane label="SN追踪" name="sn-trace">
          <SnTrace />
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
            <el-table-column label="入库库位" width="140">
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

          <!-- 非SN商品：按库位拆分数量 -->
          <el-table v-else :data="item.qtyRows" stripe border size="small" class="sn-table">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column label="入库库位" width="160">
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

          <!-- 非SN：添加库位行 -->
          <div v-if="!item.needSn" style="margin-top: 6px">
            <el-button size="small" type="primary" link @click="addQtyRow(item)">+ 添加库位</el-button>
            <span style="margin-left: 12px; font-size: 12px; color: #909399">
              已分配 {{ allocatedQty(item) }} / {{ item.quantity }}
              <span v-if="allocatedQty(item) !== item.quantity" style="color: #f56c6c">（数量不匹配）</span>
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="executeInboundVisible = false">取消</el-button>
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

    <!-- 执行退库对话框 -->
    <el-dialog v-model="executeReturnVisible" title="执行退库" width="600px">
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
        <el-button type="danger" @click="submitReturn" :loading="returnLoading">确认退库</el-button>
      </template>
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
        <el-table-column prop="location_name" label="库位" width="100" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="inbound_time" label="入库时间" width="160">
          <template #default="{ row }">{{ formatDate(row.inbound_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openSnTrace(row)">追踪</el-button>
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
        <el-button type="primary" @click="submitTransfer" :loading="transferLoading">确认调拨</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { getStoreId, isStoreUser } from '../utils/user'
import SnTrace from './SnTrace.vue'

const mainTab = ref('summary')
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

// 入库单
const inboundList = ref([])
const inboundTotal = ref(0)
const inboundQuery = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  storeId: ''
})

// 入库单详情
const inboundDetailVisible = ref(false)
const currentInbound = ref(null)

// 执行入库
const executeInboundVisible = ref(false)
const inboundLoading = ref(false)
const executeProducts = ref([])
const inboundLocations = ref([])
const addPnVisible = ref(false)
const addPnTarget = ref(null)
const addPnPnCode = ref('')

const INVENTORY_TYPES = [
  { value: 'normal_qty', label: '销售仓' },
  { value: 'display_qty', label: '铺货仓' },
  { value: 'demo_qty', label: '样机仓' },
  { value: 'unsellable_qty', label: '不可售仓' },
  { value: 'pending_qty', label: '待入库仓' }
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
const transferProductOptions = ref([])
const transferSnOptions = ref([])
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

onMounted(() => {
  if (isStoreUser()) {
    inboundQuery.storeId = getStoreId()
    summaryQuery.storeId = getStoreId()
  }
  loadStores()
  loadCategories()
  if (mainTab.value === 'summary') {
    loadSummary()
  } else if (mainTab.value === 'inbound') {
    loadInboundList()
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
  } else if (tabName === 'transfer') {
    if (transferOutList.value.length === 0 && transferInList.value.length === 0) {
      loadTransferLists()
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
      inboundLocations.value = []
      try {
        const locRes = await api.getLocationsByStore(res.data.store_id)
        if (locRes.code === 0) inboundLocations.value = locRes.data || []
      } catch (err) {
        inboundLocations.value = []
      }

      const pnMap = res.data.product_pns || {}

      const productGroups = []
      for (const item of (res.data.items || [])) {
        const needSn = item.need_sn === 1
        const qty = Number(item.quantity) || 1
        const pns = pnMap[item.product_id] || []

        const group = {
          productId: item.product_id,
          productName: item.product_name,
          needSn,
          quantity: qty,
          pnCode: item.pn_code || (pns.length > 0 ? pns[0].pn_code : ''),
          pns: pns,
          snRows: [],
          qtyRows: []
        }

        if (needSn) {
          for (let i = 0; i < qty; i++) {
            group.snRows.push({
              snCode: '',
              inventoryType: 'normal_qty',
              locationId: inboundLocations.value[0]?.location_id || '',
              remark: ''
            })
          }
        } else {
          group.qtyRows.push({
            inventoryType: 'normal_qty',
            locationId: inboundLocations.value[0]?.location_id || '',
            quantity: qty,
            remark: ''
          })
        }

        productGroups.push(group)
      }

      executeProducts.value = productGroups
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
    locationId: inboundLocations.value[0]?.location_id || '',
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

const executeReturn = (row) => {
  currentInbound.value = row
  returnReason.value = ''
  executeReturnVisible.value = true
}

const submitReturn = async () => {
  returnLoading.value = true
  try {
    const res = await api.executeReturn({
      inboundId: currentInbound.value.inbound_id,
      reason: returnReason.value
    })

    if (res.code === 0) {
      ElMessage.success('退库完成')
      executeReturnVisible.value = false
      loadInboundList()
      loadSummary()
    } else {
      ElMessage.error(res.message || '退库失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '退库失败'
    ElMessage.error(msg)
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
        window.open(`/#/sales?orderId=${saleEvents[0].ref_id}`, '_blank')
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
  window.open(`/#/sales?orderId=${orderId}`, '_blank')
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
  if (item.sn_code) return `${name} / SN:${item.sn_code}`
  return `${name} x${item.quantity || 0}`
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
  } catch (err) {
    ElMessage.error('加载调拨列表失败')
  }
}

const handleConfirmTransferOut = async (row) => {
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

const getTransferStatusType = (status) => {
  const types = { pending: 'warning', out_confirmed: 'info', completed: 'success', cancelled: 'danger' }
  return types[status] || 'info'
}

const getTransferStatusText = (status) => {
  const texts = { pending: '待出库', out_confirmed: '待入库', completed: '已完成', cancelled: '已取消' }
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
  const types = { in_stock: 'success', sold: 'warning', damaged: 'danger', available: 'success', used: 'warning', scrapped: 'danger', returned: 'info' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { in_stock: '在库', sold: '已售', damaged: '损坏', available: '可用', used: '已使用', scrapped: '已报废', returned: '已退库' }
  return texts[status] || status
}

const getInboundStatusType = (status) => {
  const types = { pending: 'warning', completed: 'success', returned: 'danger' }
  return types[status] || 'info'
}

const getInboundStatusText = (status) => {
  const texts = { pending: '待入库', completed: '已完成', returned: '已退库' }
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
.breakdown-label {
  color: #909399;
}
.breakdown-value {
  color: #303133;
  font-weight: 600;
}
</style>
