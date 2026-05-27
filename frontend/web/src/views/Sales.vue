<template>
  <div class="sales-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>销售订单</span>
          <el-button type="primary" @click="handleCreate">新建订单</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-select v-model="queryParams.storeId" placeholder="门店" clearable style="width: 160px" v-loading="storesLoading">
          <el-option label="全部门店" :value="''" />
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
        </el-select>
        <el-select v-model="queryParams.status" placeholder="状态" clearable style="width: 120px">
          <el-option label="全部" value="" />
          <el-option label="已完成" value="completed" />
          <el-option label="待审批" value="pending_approval" />
          <el-option label="已取消" value="cancelled" />
        </el-select>
        <el-date-picker v-model="queryParams.date" type="date" placeholder="选择日期" style="width: 160px" />
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border>
        <el-table-column prop="order_no" label="订单号" width="180" />
        <el-table-column label="门店" width="130">
          <template #default="{ row }">{{ row.Store?.name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="create_time" label="创建时间" width="160">
          <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
        </el-table-column>
        <el-table-column prop="customer_name" label="客户姓名" width="100" />
        <el-table-column prop="customer_phone" label="联系电话" width="120" />
        <el-table-column prop="total_amount" label="订单金额" width="100">
          <template #default="{ row }">¥{{ row.total_amount }}</template>
        </el-table-column>
        <el-table-column prop="actual_payment" label="实付金额" width="100">
          <template #default="{ row }">¥{{ row.actual_payment }}</template>
        </el-table-column>
        <el-table-column prop="order_status" label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.order_status)">{{ getStatusText(row.order_status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleView(row)">查看</el-button>
            <el-button link type="success" @click="handleApprove(row)" v-if="row.order_status === 'pending_approval' && canApprove">审批通过</el-button>
            <el-button link type="danger" @click="handleReject(row)" v-if="row.order_status === 'pending_approval' && canApprove">拒绝</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
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
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="950px" @close="handleDialogClose">
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
        <el-form-item label="商品明细">
          <div class="items-table">
            <el-table :data="orderForm.items" border size="small">
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
                      :label="`${p.name} [${p.product_code}] ¥${p.standard_price}${p.stock_qty != null ? ' 库存:' + p.stock_qty : ''}`"
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
                    allow-create
                    style="width: 100%"
                    :loading="row.pnLoading"
                    @change="onPnChange($index)"
                  >
                    <el-option v-for="pn in (row.pnList || [])" :key="pn" :label="pn" :value="pn" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="SN码" width="200">
                <template #default="{ row, $index }">
                  <template v-if="row.needSn">
                    <el-select
                      v-model="row.snCode"
                      placeholder="选择SN"
                      size="small"
                      clearable
                      filterable
                      style="width: 100%"
                      :loading="row.snLoading"
                      @change="(val) => { const sn = (row.snList || []).find(s => s.sn_code === val); row.snId = sn ? sn.sn_id : ''; }"
                    >
                      <el-option
                        v-for="sn in (row.snList || [])"
                        :key="sn.sn_id"
                        :label="sn.sn_code + (sn.inventory_type && sn.inventory_type !== 'normal_qty' ? ' [' + sn.inventory_type + ']' : '')"
                        :value="sn.sn_code"
                      />
                    </el-select>
                  </template>
                  <el-input v-else v-model="row.snCode" placeholder="无SN" size="small" disabled />
                </template>
              </el-table-column>
              <el-table-column label="单价" width="120">
                <template #default="{ row }">
                  <el-input v-model="row.salePrice" size="small" style="width: 100%" @change="onPriceChange($index)" />
                  <div v-if="row.belowMinPrice" class="below-price-tip">低于定价!</div>
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
              <el-input
                v-for="pm in selectedPayments"
                :key="pm"
                v-model="paymentAmounts[pm]"
                :placeholder="getPaymentName(pm)"
                style="width: 150px; margin-right: 10px"
              />
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
          <div class="summary-item total">实付金额: <span>¥{{ actualPayment.toFixed(2) }}</span></div>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 订单详情对话框 -->
    <el-dialog v-model="detailVisible" title="订单详情" width="800px">
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
          <el-descriptions-item label="商品总额">¥{{ currentOrder.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="实付金额">¥{{ currentOrder.actual_payment }}</el-descriptions-item>
          <el-descriptions-item label="国补">¥{{ currentOrder.national_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="教补">¥{{ currentOrder.education_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentOrder.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentOrder.OrderItems || []" border size="small">
          <el-table-column prop="product_name" label="商品名称" />
          <el-table-column prop="pn_code" label="PN码" width="120" />
          <el-table-column prop="sn_code" label="SN码" width="150" />
          <el-table-column prop="sale_price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.sale_price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column prop="subtotal" label="小计" width="100">
            <template #default="{ row }">¥{{ row.subtotal }}</template>
          </el-table-column>
        </el-table>

        <h4 class="mt-20" v-if="currentOrder.OrderPayments?.length">支付记录</h4>
        <el-table :data="currentOrder.OrderPayments || []" border size="small">
          <el-table-column prop="payment_method" label="支付方式" />
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
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { getStoreId, isStoreUser, hasRole } from '../utils/user'

const stores = ref([])
const storesLoaded = ref(false)
const storesLoading = ref(false)
const paymentMethods = ref([])
const tableData = ref([])
const total = ref(0)

const dialogVisible = ref(false)
const detailVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新建订单')
const currentOrder = ref(null)

const canApprove = computed(() => hasRole(['manager']))

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  storeId: '',
  status: '',
  date: ''
})

const selectedPayments = ref([])
const paymentAmounts = reactive({})

const orderForm = reactive({
  orderId: null,
  storeId: '',
  customerName: '',
  customerPhone: '',
  customerSource: '',
  customerSourceL1: '',
  customerSourceL2: '',
  invoiceStatus: '不开票',
  items: [],
  nationalSubsidy: 0,
  educationSubsidy: 0,
  discountAmount: 0,
  remark: ''
})

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

onMounted(() => {
  if (isStoreUser()) {
    queryParams.storeId = getStoreId()
  }
  loadData()
  loadStores()
  loadPaymentMethods()
  loadCustomerSources()
})

const loadData = async () => {
  try {
    const params = { ...queryParams }
    if (params.date) {
      params.startDate = new Date(params.date).toISOString().split('T')[0]
      params.endDate = new Date(params.date).toISOString().split('T')[0]
      delete params.date
    }
    const res = await api.getSalesList(params)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载销售数据失败: ' + (err.message || ''))
  }
}

const loadStores = async () => {
  if (storesLoaded.value) return
  storesLoading.value = true
  try {
    const res = await api.getAllStores()
    if (res && res.code === 0 && Array.isArray(res.data)) {
      stores.value = res.data
      storesLoaded.value = true
    } else {
      stores.value = []
    }
  } catch (err) {
    ElMessage.error('加载门店列表失败: ' + (err.message || ''))
    stores.value = []
  } finally {
    storesLoading.value = false
  }
}

const loadPaymentMethods = async () => {
  try {
    const res = await api.getPaymentMethods()
    if (res.code === 0) {
      paymentMethods.value = res.data || []
    }
  } catch (err) {
    paymentMethods.value = [
      { method_id: '1', code: 'cash', name: '现金' },
      { method_id: '2', code: 'wechat', name: '微信支付' },
      { method_id: '3', code: 'alipay', name: '支付宝' },
      { method_id: '4', code: 'bank', name: '银行转账' }
    ]
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

const handleCreate = () => {
  dialogTitle.value = '新建订单'
  resetForm()
  if (isStoreUser()) {
    orderForm.storeId = getStoreId()
  }
  dialogVisible.value = true
}

const handleView = async (row) => {
  try {
    const res = await api.getSalesDetail(row.order_id)
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
  orderForm.items = []
  orderForm.nationalSubsidy = 0
  orderForm.educationSubsidy = 0
  orderForm.discountAmount = 0
  orderForm.remark = ''
  selectedPayments.value = []
  Object.keys(paymentAmounts).forEach(k => delete paymentAmounts[k])
}

const addItem = () => {
  orderForm.items.push({
    productId: '',
    productName: '',
    pnCode: '',
    snCode: '',
    snId: '',
    salePrice: 0,
    quantity: 1,
    subtotal: 0,
    needSn: false,
    standardPrice: 0,
    minSalePrice: 0,
    belowMinPrice: false,
    searchLoading: false,
    searchOptions: [],
    pnList: [],
    snList: [],
    pnLoading: false,
    snLoading: false
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

const onProductChange = async (productId, index) => {
  const opts = orderForm.items[index].searchOptions || []
  const found = opts.find(p => p.product_id === productId)
  if (found) {
    orderForm.items[index].productName = found.name
    orderForm.items[index].salePrice = parseFloat(found.standard_price) || 0
    orderForm.items[index].needSn = found.need_sn === 1
    orderForm.items[index].standardPrice = parseFloat(found.standard_price) || 0
    orderForm.items[index].minSalePrice = parseFloat(found.min_sale_price) || 0
    orderForm.items[index].belowMinPrice = false
    orderForm.items[index].pnCode = ''
    orderForm.items[index].snCode = ''
    orderForm.items[index].pnList = []
    orderForm.items[index].snList = []
    orderForm.items[index].snId = ''
    orderForm.items[index].stockQty = found.stock_qty

    if (orderForm.storeId && productId) {
      orderForm.items[index].pnLoading = true
      try {
        console.log('[onProductChange] fetching PNs for store:', orderForm.storeId, 'product:', productId)
        const pnRes = await api.getProductPns(orderForm.storeId, productId)
        console.log('[onProductChange] PN result:', pnRes)
        if (pnRes.code === 0 && pnRes.data && pnRes.data.length > 0) {
          orderForm.items[index].pnList = pnRes.data
          orderForm.items[index].pnCode = pnRes.data[0]
          console.log('[onProductChange] set pnList:', pnRes.data, 'default pnCode:', pnRes.data[0])
          if (found.need_sn === 1) {
            console.log('[onProductChange] product needs SN, loading SN list...')
            await loadSnList(index)
          }
        }
      } catch (e) { console.error('[onProductChange] error loading PNs:', e) }
      finally { orderForm.items[index].pnLoading = false }
    }

    onPriceChange(index)
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
  if (item.needSn) {
    console.log('[onPnChange] PN changed, reloading SN list for pn:', item.pnCode)
    await loadSnList(index)
  }
}

const onPriceChange = (index) => {
  const item = orderForm.items[index]
  const minPrice = item.minSalePrice || item.standardPrice
  if (minPrice > 0 && item.salePrice < minPrice) {
    item.belowMinPrice = true
  } else {
    item.belowMinPrice = false
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
    if (item.needSn && (!item.snCode || item.snCode.trim() === '')) {
      ElMessage.warning(`商品 ${item.productName} 需要SN管理，请填写SN码`)
      return
    }
  }

  const paymentTotal = selectedPayments.value.reduce((sum, pm) => sum + (Number(paymentAmounts[pm]) || 0), 0)
  if (Math.abs(paymentTotal - actualPayment.value) > 0.01) {
    ElMessage.warning('支付金额与实付金额不匹配')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      storeId: orderForm.storeId,
      customerName: orderForm.customerName,
      customerPhone: orderForm.customerPhone,
      customerSource: orderForm.customerSource,
      invoiceStatus: orderForm.invoiceStatus,
      items: orderForm.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        pnCode: item.pnCode,
        snCode: item.snCode,
        snId: item.snId || '',
        salePrice: item.salePrice,
        quantity: item.quantity,
        subtotal: item.salePrice * item.quantity
      })),
      payments: selectedPayments.value.map(pm => ({
        method: pm,
        amount: paymentAmounts[pm] || 0
      })),
      nationalSubsidy: orderForm.nationalSubsidy,
      educationSubsidy: orderForm.educationSubsidy,
      discountAmount: orderForm.discountAmount,
      remark: orderForm.remark
    }

    const res = await api.createSales(data)
    if (res.code === 0) {
      if (res.data?.needsApproval) {
        ElMessage.warning(res.data.message || '订单已创建，售价低于定价需审批')
      } else {
        ElMessage.success(res.data?.message || '订单创建成功')
      }
      dialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '创建失败')
    }
  } catch (err) {
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
  const types = { completed: 'success', pending_approval: 'warning', cancelled: 'danger' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { completed: '已完成', pending_approval: '待审批', cancelled: '已取消' }
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
}
.items-table {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
}
.mt-10 { margin-top: 10px; }
.mt-20 { margin-top: 20px; }
.ml-5 { margin-left: 5px; }
.payment-methods {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
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
  border-top: 1px solid #ddd;
  padding-top: 10px;
  margin-top: 10px;
}
.summary-item span { color: #f56c6c; }
.below-price-tip {
  color: #e6a23c;
  font-size: 11px;
  margin-top: 2px;
}
</style>
