<template>
  <div class="finance-page">
    <el-card>
      <template #header>
        <span>财务管理</span>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="日结单" name="daily">
          <div class="filter-bar">
            <el-date-picker v-model="queryParams.date" type="date" placeholder="选择日期" />
            <el-select v-model="queryParams.storeId" placeholder="选择门店" clearable style="width: 150px">
              <el-option label="全部门店" :value="''" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadData">搜索</el-button>
          </div>

          <el-table :data="tableData" stripe border>
            <el-table-column prop="statement_date" label="日期" width="120" />
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="total_revenue" label="营收" width="120">
              <template #default="{ row }">¥{{ row.total_revenue }}</template>
            </el-table-column>
            <el-table-column prop="total_order_count" label="订单数" width="100" />
            <el-table-column prop="cash_amount" label="现金" width="100">
              <template #default="{ row }">¥{{ row.cash_amount }}</template>
            </el-table-column>
            <el-table-column prop="wechat_amount" label="微信" width="100">
              <template #default="{ row }">¥{{ row.wechat_amount }}</template>
            </el-table-column>
            <el-table-column prop="alipay_amount" label="支付宝" width="100">
              <template #default="{ row }">¥{{ row.alipay_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'confirmed' ? 'success' : 'warning'">{{ row.status }}</el-tag>
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

        <el-tab-pane label="支出记录" name="expense">
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddExpense">添加支出</el-button>
          </div>

          <el-table :data="expenseData" stripe border>
            <el-table-column prop="expense_no" label="支出单号" width="180" />
            <el-table-column prop="create_time" label="时间" width="160" />
            <el-table-column prop="expense_type" label="支出类型" width="120" />
            <el-table-column prop="amount" label="金额" width="120">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </el-table-column>
            <el-table-column prop="payment_method" label="支付方式" width="100" />
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="remark" label="备注" min-width="150" />
          </el-table>

          <el-pagination
            v-model:current-page="expenseQuery.page"
            v-model:page-size="expenseQuery.pageSize"
            :total="expenseTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadExpenseData"
            @current-change="loadExpenseData"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 添加支出对话框 -->
    <el-dialog v-model="expenseDialogVisible" title="添加支出" width="500px" @close="handleDialogClose">
      <el-form :model="expenseForm" label-width="100px">
        <el-form-item label="支出类型" required>
          <el-select v-model="expenseForm.expenseType" placeholder="请选择类型" style="width: 100%">
            <el-option label="办公用品" value="办公用品" />
            <el-option label="水电费" value="水电费" />
            <el-option label="运费" value="运费" />
            <el-option label="维修费" value="维修费" />
            <el-option label="工资" value="工资" />
            <el-option label="其他" value="其他" />
          </el-select>
        </el-form-item>
        <el-form-item label="门店" required>
          <el-select v-model="expenseForm.storeId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input-number v-model="expenseForm.amount" :min="0" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item label="支付方式">
          <el-select v-model="expenseForm.paymentMethod" placeholder="请选择" style="width: 100%">
            <el-option label="现金" value="cash" />
            <el-option label="微信支付" value="wechat" />
            <el-option label="支付宝" value="alipay" />
            <el-option label="银行转账" value="bank" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="expenseForm.remark" type="textarea" rows="3" placeholder="支出备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expenseDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleExpenseSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('daily')
const stores = ref([])
const tableData = ref([])
const expenseData = ref([])
const total = ref(0)
const expenseTotal = ref(0)

const expenseDialogVisible = ref(false)
const submitLoading = ref(false)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  date: '',
  storeId: ''
})

const expenseQuery = reactive({
  page: 1,
  pageSize: 20
})

const expenseForm = reactive({
  expenseType: '',
  storeId: '',
  amount: 0,
  paymentMethod: 'cash',
  remark: ''
})

onMounted(() => {
  loadData()
  loadStores()
  loadExpenseData()
})

const loadData = async () => {
  try {
    const res = await api.getDailyStatement(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadExpenseData = async () => {
  try {
    const res = await api.getExpenseList(expenseQuery)
    if (res.code === 0) {
      expenseData.value = res.data?.list || []
      expenseTotal.value = res.data?.total || 0
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

const handleAddExpense = () => {
  resetForm()
  expenseDialogVisible.value = true
}

const handleExpenseSubmit = async () => {
  if (!expenseForm.expenseType) {
    ElMessage.warning('请选择支出类型')
    return
  }
  if (!expenseForm.storeId) {
    ElMessage.warning('请选择门店')
    return
  }
  if (expenseForm.amount <= 0) {
    ElMessage.warning('请输入正确的金额')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      expenseType: expenseForm.expenseType,
      storeId: expenseForm.storeId,
      amount: expenseForm.amount,
      paymentMethod: expenseForm.paymentMethod,
      remark: expenseForm.remark
    }
    const res = await api.createExpense(data)
    if (res.code === 0) {
      ElMessage.success('添加成功')
      expenseDialogVisible.value = false
      loadExpenseData()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (err) {
    ElMessage.error('添加失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  expenseForm.expenseType = ''
  expenseForm.storeId = ''
  expenseForm.amount = 0
  expenseForm.paymentMethod = 'cash'
  expenseForm.remark = ''
}
</script>

<style scoped>
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
