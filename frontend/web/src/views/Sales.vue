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
        <el-select v-model="queryParams.storeId" placeholder="选择门店" clearable>
          <el-option label="全部门店" :value="''" />
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
        </el-select>
        <el-date-picker v-model="queryParams.date" type="date" placeholder="选择日期" />
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border>
        <el-table-column prop="order_no" label="订单号" width="180" />
        <el-table-column prop="create_time" label="创建时间" width="160" />
        <el-table-column prop="customer_name" label="客户姓名" width="120" />
        <el-table-column prop="customer_phone" label="联系电话" width="130" />
        <el-table-column prop="total_amount" label="订单金额" width="120">
          <template #default="{ row }">¥{{ row.total_amount }}</template>
        </el-table-column>
        <el-table-column prop="actual_payment" label="实付金额" width="120">
          <template #default="{ row }">¥{{ row.actual_payment }}</template>
        </el-table-column>
        <el-table-column prop="order_status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.order_status)">{{ row.order_status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleView(row)">查看</el-button>
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
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
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="900px" @close="handleDialogClose">
      <el-form :model="orderForm" label-width="100px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户姓名">
              <el-input v-model="orderForm.customerName" placeholder="请输入客户姓名" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="联系电话">
              <el-input v-model="orderForm.customerPhone" placeholder="请输入联系电话" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户来源">
              <el-select v-model="orderForm.customerSource" placeholder="请选择" clearable>
                <el-option label="自然进店" value="自然进店" />
                <el-option label="老客户推荐" value="老客户推荐" />
                <el-option label="线上推广" value="线上推广" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
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
              <el-table-column label="商品名称" width="200">
                <template #default="{ row, $index }">
                  <el-select v-model="row.productId" placeholder="选择商品" filterable @change="onProductChange($index)">
                    <el-option v-for="p in products" :key="p.product_id" :label="p.name" :value="p.product_id" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="PN码" width="120">
                <template #default="{ row }">
                  <el-input v-model="row.pnCode" placeholder="PN码" />
                </template>
              </el-table-column>
              <el-table-column label="SN码" width="120">
                <template #default="{ row }">
                  <el-input v-model="row.snCode" placeholder="SN码" />
                </template>
              </el-table-column>
              <el-table-column label="单价" width="100">
                <template #default="{ row }">
                  <el-input-number v-model="row.salePrice" :min="0" :precision="2" size="small" />
                </template>
              </el-table-column>
              <el-table-column label="数量" width="80">
                <template #default="{ row }">
                  <el-input-number v-model="row.quantity" :min="1" size="small" />
                </template>
              </el-table-column>
              <el-table-column label="小计" width="100">
                <template #default="{ row }">
                  ¥{{ (row.salePrice * row.quantity || 0).toFixed(2) }}
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
              <el-input-number v-model="orderForm.nationalSubsidy" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="教补金额">
              <el-input-number v-model="orderForm.educationSubsidy" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="折扣金额">
              <el-input-number v-model="orderForm.discountAmount" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 支付方式 -->
        <el-form-item label="支付方式">
          <div class="payment-methods">
            <el-checkbox-group v-model="selectedPayments">
              <el-checkbox v-for="pm in paymentMethods" :key="pm.method_id" :label="pm.code">
                {{ pm.name }}
              </el-checkbox>
            </el-checkbox-group>
            <div class="payment-amounts mt-10">
              <el-input-number
                v-for="pm in selectedPayments"
                :key="pm"
                v-model="paymentAmounts[pm]"
                :min="0"
                :precision="2"
                :placeholder="getPaymentName(pm)"
                style="width: 150px; margin-right: 10px"
              />
            </div>
          </div>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="orderForm.remark" type="textarea" rows="2" />
        </el-form-item>

        <!-- 金额汇总 -->
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
            <el-tag :type="getStatusType(currentOrder.order_status)">{{ currentOrder.order_status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="客户姓名">{{ currentOrder.customer_name }}</el-descriptions-item>
          <el-descriptions-item label="联系电话">{{ currentOrder.customer_phone }}</el-descriptions-item>
          <el-descriptions-item label="客户来源">{{ currentOrder.customer_source }}</el-descriptions-item>
          <el-descriptions-item label="发票类型">{{ currentOrder.invoice_status }}</el-descriptions-item>
          <el-descriptions-item label="商品总额">¥{{ currentOrder.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="实付金额">¥{{ currentOrder.actual_payment }}</el-descriptions-item>
          <el-descriptions-item label="国补">¥{{ currentOrder.national_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="教补">¥{{ currentOrder.education_subsidy }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ currentOrder.create_time }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentOrder.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentOrder.OrderItems" border size="small">
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

        <h4 class="mt-20">支付记录</h4>
        <el-table :data="currentOrder.OrderPayments" border size="small">
          <el-table-column prop="payment_method" label="支付方式" />
          <el-table-column prop="amount" label="金额" width="120">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="payment_time" label="支付时间" width="160" />
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const stores = ref([])
const products = ref([])
const paymentMethods = ref([])
const tableData = ref([])
const total = ref(0)

const dialogVisible = ref(false)
const detailVisible = ref(false)
const submitLoading = ref(false)
const dialogTitle = ref('新建订单')
const currentOrder = ref(null)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  storeId: '',
  date: ''
})

const selectedPayments = ref([])
const paymentAmounts = reactive({})

const orderForm = reactive({
  orderId: null,
  customerName: '',
  customerPhone: '',
  customerSource: '',
  invoiceStatus: '不开票',
  items: [],
  nationalSubsidy: 0,
  educationSubsidy: 0,
  discountAmount: 0,
  remark: ''
})

const totalAmount = computed(() => {
  return orderForm.items.reduce((sum, item) => {
    return sum + (item.salePrice * item.quantity || 0)
  }, 0)
})

const actualPayment = computed(() => {
  return Math.max(0, totalAmount.value - orderForm.nationalSubsidy - orderForm.educationSubsidy - orderForm.discountAmount)
})

onMounted(() => {
  loadData()
  loadStores()
  loadProducts()
  loadPaymentMethods()
})

const loadData = async () => {
  try {
    const res = await api.getSalesList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadStores = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) {
      stores.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load stores')
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

const loadPaymentMethods = async () => {
  try {
    const res = await api.getPaymentMethods()
    if (res.code === 0) {
      paymentMethods.value = res.data || []
    }
  } catch (err) {
    // 使用默认值
    paymentMethods.value = [
      { method_id: '1', code: 'cash', name: '现金' },
      { method_id: '2', code: 'wechat', name: '微信支付' },
      { method_id: '3', code: 'alipay', name: '支付宝' },
      { method_id: '4', code: 'bank', name: '银行转账' }
    ]
  }
}

const getPaymentName = (code) => {
  const pm = paymentMethods.value.find(p => p.code === code)
  return pm ? pm.name : code
}

const handleCreate = () => {
  dialogTitle.value = '新建订单'
  resetForm()
  dialogVisible.value = true
}

const handleEdit = (row) => {
  dialogTitle.value = '编辑订单'
  ElMessage.info('编辑订单功能: ' + row.order_no)
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
  orderForm.customerName = ''
  orderForm.customerPhone = ''
  orderForm.customerSource = ''
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
    salePrice: 0,
    quantity: 1,
    subtotal: 0
  })
}

const removeItem = (index) => {
  orderForm.items.splice(index, 1)
}

const onProductChange = (index) => {
  const product = products.value.find(p => p.product_id === orderForm.items[index].productId)
  if (product) {
    orderForm.items[index].productName = product.name
    orderForm.items[index].salePrice = product.standard_price || 0
  }
}

const handleSubmit = async () => {
  if (!orderForm.customerName || !orderForm.customerPhone) {
    ElMessage.warning('请填写客户信息')
    return
  }
  if (orderForm.items.length === 0) {
    ElMessage.warning('请添加商品')
    return
  }

  // 检查支付总额是否匹配
  const paymentTotal = selectedPayments.value.reduce((sum, pm) => sum + (paymentAmounts[pm] || 0), 0)
  if (Math.abs(paymentTotal - actualPayment.value) > 0.01) {
    ElMessage.warning('支付金额与实付金额不匹配')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      customerName: orderForm.customerName,
      customerPhone: orderForm.customerPhone,
      customerSource: orderForm.customerSource,
      invoiceStatus: orderForm.invoiceStatus,
      items: orderForm.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        pnCode: item.pnCode,
        snCode: item.snCode,
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
      ElMessage.success('订单创建成功')
      dialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '创建失败')
    }
  } catch (err) {
    ElMessage.error('创建订单失败')
  } finally {
    submitLoading.value = false
  }
}

const getStatusType = (status) => {
  const types = { completed: 'success', pending: 'warning', cancelled: 'danger' }
  return types[status] || 'info'
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

.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

.items-table {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
}

.mt-10 {
  margin-top: 10px;
}

.mt-20 {
  margin-top: 20px;
}

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

.summary-item span {
  color: #f56c6c;
}
</style>
