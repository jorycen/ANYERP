<template>
  <div class="products-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>商品管理</span>
        </div>
      </template>

      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <!-- ========== Tab 1: 商品管理 ========== -->
        <el-tab-pane v-if="!productApprovalOnly" label="商品管理" name="product">
          <div class="filter-bar">
            <div>
              <el-input v-model="queryParams.keyword" placeholder="商品名称/编码/详细配置" clearable style="width: 240px" @keyup.enter="loadData" />
              <el-tree-select
                v-model="queryParams.categoryId"
                :data="categoryTree"
                :props="{ label: 'name', value: 'category_id', children: 'children' }"
                placeholder="商品分类"
                clearable
                check-strictly
                style="width: 200px; margin-left: 8px;"
                @change="loadData"
              />
              <el-button type="primary" style="margin-left: 8px;" @click="loadData">搜索</el-button>
            </div>
            <div>
              <el-button type="success" @click="handleImport">批量导入</el-button>
              <el-button type="warning" @click="handleExport">批量导出</el-button>
              <el-button type="primary" @click="handleCreate">新增商品</el-button>
            </div>
          </div>

          <el-table :data="tableData" stripe border v-loading="loading">
            <el-table-column prop="product_code" label="编码" width="110" show-overflow-tooltip />
            <el-table-column label="厂商编码" width="140">
              <template #default="{ row }">
                <template v-if="row.manufacturer_codes && row.manufacturer_codes.length > 0">
                  <el-tag v-for="c in row.manufacturer_codes" :key="c" size="small" style="margin: 1px 2px;">{{ c }}</el-tag>
                </template>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="产品名称" min-width="240" show-overflow-tooltip />
            <el-table-column prop="config" label="厂商商品名称" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'text-muted': !row.config }">{{ row.config || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="category" label="分类" width="120" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'text-muted': !row.category }">{{ row.category || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="brand" label="品牌" width="80" show-overflow-tooltip />
            <el-table-column prop="series" label="系列" width="90" show-overflow-tooltip />
            <el-table-column prop="model" label="型号" width="100" show-overflow-tooltip />
            <el-table-column prop="processor" label="处理器" min-width="100" show-overflow-tooltip />
            <el-table-column prop="memory" label="内存" width="80" show-overflow-tooltip />
            <el-table-column prop="storage" label="存储" width="90" show-overflow-tooltip />
            <el-table-column prop="color" label="颜色" width="70" show-overflow-tooltip />
            <el-table-column prop="gpu" label="显卡" min-width="90" show-overflow-tooltip />
            <el-table-column prop="accessory_type" label="配件类别" width="90" show-overflow-tooltip />
            <el-table-column label="创建时间" width="170">
              <template #default="{ row }">
                {{ formatTime(row.create_time) }}
              </template>
            </el-table-column>
            <el-table-column label="状态" width="75">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'warning'" size="small">
                  {{ row.status === 1 ? '启用' : '暂停' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
                <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="handleTogglePause(row)">
                  {{ row.status === 1 ? '暂停' : '启用' }}
                </el-button>
                <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
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
        </el-tab-pane>

        <!-- ========== Tab 2: 分类管理 ========== -->
        <el-tab-pane v-if="!productApprovalOnly" label="分类管理" name="category">
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddCategory(null)">新增一级分类</el-button>
          </div>

          <div v-loading="categoryLoading">
            <el-empty v-if="categoryTree.length === 0" description="暂无分类，点击上方按钮添加" />
            <div v-else class="category-tree">
              <div v-for="(level1, level1Index) in categoryTree" :key="level1.category_id" class="category-node level1">
                <div class="category-row" :class="'level-' + level1.level">
                  <el-icon><Folder /></el-icon>
                  <span class="cat-name">{{ level1.name }}</span>
                  <span class="cat-level">一级</span>
                  <div class="cat-actions">
                    <el-button link type="primary" size="small" :disabled="level1Index === 0" @click="handleMoveCategory(level1, categoryTree, level1Index, -1)">上移</el-button>
                    <el-button link type="primary" size="small" :disabled="level1Index === categoryTree.length - 1" @click="handleMoveCategory(level1, categoryTree, level1Index, 1)">下移</el-button>
                    <el-button link type="primary" size="small" @click="handleAddCategory(level1)">添加子分类</el-button>
                    <el-button link type="primary" size="small" @click="handleEditCategory(level1)">编辑</el-button>
                    <el-button link type="danger" size="small" @click="handleDeleteCategory(level1)">删除</el-button>
                  </div>
                </div>

                <div v-if="level1.children && level1.children.length" class="sub-categories">
                  <div v-for="(level2, level2Index) in level1.children" :key="level2.category_id" class="category-node level2">
                    <div class="category-row" :class="'level-' + level2.level">
                      <el-icon><Folder /></el-icon>
                      <span class="cat-name">{{ level2.name }}</span>
                      <span class="cat-level">二级</span>
                      <div class="cat-actions">
                        <el-button link type="primary" size="small" :disabled="level2Index === 0" @click="handleMoveCategory(level2, level1.children, level2Index, -1)">上移</el-button>
                        <el-button link type="primary" size="small" :disabled="level2Index === level1.children.length - 1" @click="handleMoveCategory(level2, level1.children, level2Index, 1)">下移</el-button>
                        <el-button v-if="level2.level < 3" link type="primary" size="small" @click="handleAddCategory(level2)">添加子分类</el-button>
                        <el-button link type="primary" size="small" @click="handleEditCategory(level2)">编辑</el-button>
                        <el-button link type="danger" size="small" @click="handleDeleteCategory(level2)">删除</el-button>
                      </div>
                    </div>

                    <div v-if="level2.children && level2.children.length" class="sub-categories">
                      <div v-for="(level3, level3Index) in level2.children" :key="level3.category_id" class="category-row level-3">
                        <el-icon><Folder /></el-icon>
                        <span class="cat-name">{{ level3.name }}</span>
                        <span class="cat-level">三级</span>
                        <div class="cat-actions">
                          <el-button link type="primary" size="small" :disabled="level3Index === 0" @click="handleMoveCategory(level3, level2.children, level3Index, -1)">上移</el-button>
                          <el-button link type="primary" size="small" :disabled="level3Index === level2.children.length - 1" @click="handleMoveCategory(level3, level2.children, level3Index, 1)">下移</el-button>
                          <el-button link type="primary" size="small" @click="handleEditCategory(level3)">编辑</el-button>
                          <el-button link type="danger" size="small" @click="handleDeleteCategory(level3)">删除</el-button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- ========== Tab 3: 价格管理 ========== -->
        <el-tab-pane v-if="!productApprovalOnly" label="价格管理" name="price">
          <div class="filter-bar">
            <el-input v-model="priceParams.keyword" placeholder="商品名称/商品编码/厂商编码" clearable style="width: 240px" @keyup.enter="loadPriceData" />
            <el-button type="primary" @click="loadPriceData">搜索</el-button>
            <el-button type="success" @click="handleBatchRefreshCost" :loading="batchRefreshLoading" :disabled="selectedPriceRows.length === 0">
              批量刷新成本 ({{ selectedPriceRows.length }})
            </el-button>
            <el-button type="success" plain @click="handleCostImport">批量刷新成本导入</el-button>
            <el-button type="warning" @click="handlePriceImport">批量导入定价</el-button>
          </div>

          <el-table :data="priceTableData" stripe border v-loading="priceLoading" @selection-change="onPriceSelectionChange" ref="priceTableRef">
            <el-table-column type="selection" width="50" />
            <el-table-column prop="product_code" label="商品编码" width="130" />
            <el-table-column label="厂商编码" width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.manufacturer_code || '-' }}</template>
            </el-table-column>
            <el-table-column prop="name" label="商品名称" min-width="150" />
            <el-table-column prop="category_name" label="分类" width="150" show-overflow-tooltip />
            <el-table-column prop="unit" label="单位" width="60" />
            <el-table-column label="库存成本" width="130">
              <template #default="{ row }">
                <span class="cost-price">¥{{ formatNum(row.cost_price) }}</span>
                <el-tooltip content="基于入库先进先出加权平均计算，不可修改" placement="top">
                  <el-icon style="margin-left: 4px; color: #909399;"><InfoFilled /></el-icon>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="标准售价" width="140">
              <template #default="{ row }">
                <span v-if="!row._editing">¥{{ formatNum(row.standard_price) }}</span>
                <el-input v-else v-model="row._stdPrice" size="small" style="width: 110px" />
              </template>
            </el-table-column>
            <el-table-column label="最低销售价" width="140">
              <template #default="{ row }">
                <span v-if="!row._editing">¥{{ formatNum(row.min_sale_price) }}</span>
                <el-input v-else v-model="row._minPrice" size="small" style="width: 110px" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <template v-if="!row._editing">
                  <el-button link type="primary" @click="startEditPrice(row)">修改定价</el-button>
                  <el-button link type="primary" @click="handleRefreshCost(row)">刷新成本</el-button>
                  <el-button link type="primary" @click="showPriceHistory(row)">价格历史</el-button>
                </template>
                <template v-else>
                  <el-button link type="primary" @click="savePrice(row)">保存</el-button>
                  <el-button link type="default" @click="cancelEditPrice(row)">取消</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="priceParams.page"
            v-model:page-size="priceParams.pageSize"
            :total="priceTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadPriceData"
            @current-change="loadPriceData"
          />
        </el-tab-pane>

        <el-tab-pane label="新建商品审批" name="approval">
          <div class="filter-bar">
            <el-select v-model="applicationParams.status" placeholder="审批状态" clearable style="width: 160px" @change="loadProductApplications">
              <el-option label="全部" value="" />
              <el-option label="待审批" value="pending" />
              <el-option label="已通过" value="approved" />
              <el-option label="已拒绝" value="rejected" />
            </el-select>
            <el-button type="primary" @click="loadProductApplications">刷新</el-button>
          </div>
          <el-table :data="productApplications" stripe border v-loading="applicationLoading">
            <el-table-column prop="application_no" label="申请单号" width="190" />
            <el-table-column prop="product_name" label="商品名称" min-width="240" show-overflow-tooltip />
            <el-table-column prop="category_name" label="商品分类" width="180" show-overflow-tooltip />
            <el-table-column prop="applicant_name" label="申请人" width="100" />
            <el-table-column label="申请时间" width="165">
              <template #default="{ row }">{{ formatTime(row.create_time) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="productApplicationStatusType(row.status)">{{ productApplicationStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="review_user_name" label="审批人" width="100" />
            <el-table-column prop="review_comment" label="审批意见" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <template v-if="row.status === 'pending' && canReviewProductApplications">
                  <el-button link type="success" :disabled="isOwnProductApplication(row)" @click="reviewProductApplication(row, 'approved')">通过</el-button>
                  <el-button link type="danger" :disabled="isOwnProductApplication(row)" @click="reviewProductApplication(row, 'rejected')">拒绝</el-button>
                </template>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="applicationParams.page"
            v-model:page-size="applicationParams.pageSize"
            :total="applicationTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadProductApplications"
            @current-change="loadProductApplications"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新建/编辑商品对话框（内嵌条码管理） -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="750px" @close="handleDialogClose">
      <el-form :model="productForm" label-width="100px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商品编码">
              <el-input :model-value="productForm.productCode || '(系统自动生成)'" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品分类">
              <el-tree-select
                v-model="productForm.categoryId"
                :data="categoryTree"
                :props="{ label: 'name', value: 'category_id', children: 'children' }"
                placeholder="请选择分类"
                clearable
                check-strictly
                style="width: 100%"
                @change="onCategoryChange"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 分类动态字段 - 仅在分类配置了额外字段时显示 -->
        <div v-if="categoryFields.length > 0" style="margin-bottom: 12px; padding: 10px; background: #f5f7fa; border-radius: 4px;">
          <el-divider content-position="left" style="margin: 0 0 10px 0;">{{ categoryFieldCatName }} 补充字段</el-divider>
          <el-row :gutter="16">
            <el-col :span="8" v-for="field in categoryExtraFields" :key="field.field_key">
              <el-form-item :label="field.field_label" :required="field.required" label-width="75px">
                <el-select v-if="field.field_type === 'select'" v-model="productForm.attributes[field.field_key]"
                  :placeholder="field.placeholder || ('请选择' + field.field_label)" size="small" clearable style="width: 100%">
                  <el-option v-for="opt in field.options" :key="opt" :label="opt" :value="opt" />
                </el-select>
                <el-input v-else v-model="productForm.attributes[field.field_key]"
                  :placeholder="field.placeholder || field.field_label" size="small" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <el-form-item label="商品名称">
          <span style="font-weight: 600; font-size: 14px;">{{ computedProductName || '（请填写补充字段）' }}</span>
        </el-form-item>
        <el-form-item label="厂商商品名称">
          <el-input v-model="productForm.config" placeholder="厂商商品名称" />
        </el-form-item>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="需要SN码">
              <el-switch v-model="productForm.needSn" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态">
              <el-switch v-model="productForm.status" :active-value="1" :inactive-value="0" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="单位">
              <el-input v-model="productForm.unit" placeholder="台" size="small" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="详细配置">
          <el-input v-model="productForm.remark" type="textarea" rows="2" placeholder="详细配置信息" />
        </el-form-item>

        <!-- 条码管理内嵌 -->
        <el-divider content-position="left">厂商编码 / 69码</el-divider>
        <div style="display: flex; gap: 10px; margin-bottom: 10px;">
          <el-input v-model="formNewBarcode" placeholder="条码内容" style="width: 180px" @keyup.enter="addFormBarcode" />
          <el-select v-model="formBarcodeType" style="width: 120px">
            <el-option label="厂商编码" value="manufacturer" />
            <el-option label="69码" value="barcode69" />
          </el-select>
          <el-button type="primary" @click="addFormBarcode">添加</el-button>
        </div>
        <el-table :data="productForm.barcodes" stripe border size="small" max-height="200" v-if="productForm.barcodes.length > 0">
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
              <el-button link type="danger" size="small" @click="removeFormBarcode($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂未添加条码" :image-size="40" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveProductDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 分类编辑对话框 -->
    <el-dialog v-model="categoryDialogVisible" :title="categoryDialogTitle" width="450px" @close="resetCategoryForm">
      <el-form :model="categoryForm" label-width="80px">
        <el-form-item label="父级分类">
          <el-input :model-value="categoryParentName" disabled />
        </el-form-item>
        <el-form-item label="分类名称" required>
          <el-input v-model="categoryForm.name" placeholder="请输入分类名称" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model="categoryForm.sortOrder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="categoryDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveCategory" :loading="categorySaveLoading">保存</el-button>
      </template>
    </el-dialog>

    <!-- PN管理对话框 -->
    <el-dialog v-model="pnDialogVisible" :title="`PN管理 - ${currentProduct?.name}`" width="700px">
      <div class="filter-bar">
        <el-input v-model="pnQueryParams.keyword" placeholder="PN码" clearable style="width: 200px" />
        <el-button type="primary" @click="loadPnData">搜索</el-button>
      </div>
      <el-table :data="pnTableData" stripe border size="small" style="margin-top: 12px">
        <el-table-column prop="pn_code" label="PN码" width="150" />
        <el-table-column prop="barcode" label="条码" width="150" />
        <el-table-column prop="is_primary" label="主PN" width="80">
          <template #default="{ row }">
            <el-tag :type="row.is_primary ? 'success' : 'info'" size="small">{{ row.is_primary ? '是' : '否' }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div class="add-pn-bar" style="margin-top: 16px;">
        <el-button type="primary" size="small" @click="showAddPnForm = !showAddPnForm">添加PN</el-button>
        <div v-if="showAddPnForm" style="display: flex; gap: 10px; margin-top: 8px;">
          <el-input v-model="newPnCode" placeholder="PN码" style="width: 150px" />
          <el-input v-model="newPnBarcode" placeholder="条码" style="width: 150px" />
          <el-button type="primary" size="small" @click="handleAddPn">确认</el-button>
        </div>
      </div>
    </el-dialog>

    <!-- 批量导入对话框 -->
    <el-dialog v-model="importDialogVisible" title="批量导入商品" width="700px">
      <div class="import-tips">
        <p>下载模板，按模板格式填写后上传。分类字段列名需与"商品字段管理"中配置的<strong>字段名</strong>（如：品牌、系列）一致，系统会自动匹配并拼装商品名称。</p>
        <p style="color: #e6a23c;">也可以直接填写"商品名称"列，系统优先使用该值。</p>
        <el-button type="primary" size="small" @click="downloadTemplate">下载导入模板</el-button>
      </div>
      <div class="upload-area">
        <el-upload ref="uploadRef" :auto-upload="false" :show-file-list="false" :on-change="handleFileChange" accept=".xlsx,.xls" drag>
          <el-icon class="el-icon--upload"><Upload /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或<em>点击上传</em></div>
        </el-upload>
        <div v-if="importFile" class="selected-file">
          <el-tag closable @close="clearFile">{{ importFile.name }}</el-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleImportSubmit" :loading="importLoading" :disabled="!importFile">开始导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="priceImportDialogVisible" title="批量导入定价" width="700px">
      <div class="import-tips">
        <p>填写商品编码或厂商编码，二者任填一个即可。厂商编码对应多个商品时会同步更新全部商品。</p>
        <p>只更新定价和最低售价；生效时间为空表示立即生效。点击立即导入时校验，异常记录跳过，正常记录直接导入。</p>
        <el-button type="primary" size="small" @click="downloadPriceTemplate">下载定价模板</el-button>
      </div>
      <div class="upload-area">
        <el-upload :auto-upload="false" :show-file-list="false" :on-change="handlePriceFileChange" accept=".xlsx,.xls" drag>
          <el-icon class="el-icon--upload"><Upload /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或<em>点击上传</em></div>
        </el-upload>
        <div v-if="priceImportFile" class="selected-file">
          <el-tag closable @close="clearPriceFile">{{ priceImportFile.name }}</el-tag>
        </div>
      </div>
      <el-alert
        v-if="priceImportValidated"
        :type="priceImportValidation.failed > 0 ? 'warning' : 'success'"
        :closable="false"
        style="margin-top: 16px;"
      >
        导入完成：成功 <strong>{{ priceImportValidation.success }}</strong> 行，
        异常 <strong>{{ priceImportValidation.failed }}</strong> 行，
        影响 <strong>{{ priceImportValidation.affectedProducts }}</strong> 个商品，
        价格变更 <strong>{{ priceImportValidation.priceChanges }}</strong> 条
      </el-alert>
      <el-table
        v-if="priceImportValidation.errors.length > 0"
        :data="priceImportValidation.errors"
        stripe
        size="small"
        max-height="240"
        style="margin-top: 12px;"
      >
        <el-table-column prop="row" label="行号" width="90" />
        <el-table-column label="商品标识" min-width="150">
          <template #default="{ row }">
            {{ row.product?.['商品编码'] || row.product?.['厂商编码'] || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="message" label="异常原因" min-width="220" />
      </el-table>
      <template #footer>
        <el-button @click="priceImportDialogVisible = false">取消</el-button>
        <el-button v-if="priceImportValidation.errors.length > 0" @click="downloadPriceImportErrors">下载异常记录</el-button>
        <el-button type="primary" @click="handlePriceImportSubmit" :loading="priceImportLoading" :disabled="!priceImportFile">立即导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="costImportDialogVisible" title="批量刷新成本" width="700px">
      <div class="import-tips">
        <p>下载模板后填写要刷新的商品编码或商品名称；无需填写成本价，系统会按当前库存对应的采购/入库价加权平均后刷新库存成本。</p>
        <el-button type="primary" size="small" @click="downloadCostTemplate">下载成本刷新模板</el-button>
      </div>
      <div class="upload-area">
        <el-upload :auto-upload="false" :show-file-list="false" :on-change="handleCostFileChange" accept=".xlsx,.xls" drag>
          <el-icon class="el-icon--upload"><Upload /></el-icon>
          <div class="el-upload__text">将文件拖到此处，或 <em>点击上传</em></div>
        </el-upload>
        <div v-if="costImportFile" class="selected-file">
          <el-tag closable @close="clearCostFile">{{ costImportFile.name }}</el-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="costImportDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleCostImportSubmit" :loading="costImportLoading" :disabled="!costImportFile">开始刷新</el-button>
      </template>
    </el-dialog>

    <!-- 导入结果 -->
    <el-dialog v-model="importResultVisible" title="导入结果" width="800px">
      <el-alert :type="importResult.failed > 0 ? 'warning' : 'success'" style="margin-bottom: 16px;">
        导入完成！成功 <strong>{{ importResult.success }}</strong> 行，失败 <strong>{{ importResult.failed }}</strong> 行
        <span v-if="importResult.affectedProducts">，影响 <strong>{{ importResult.affectedProducts }}</strong> 个商品</span>
        <span v-if="importResult.effective">，已生效 <strong>{{ importResult.effective }}</strong> 条价格变更</span>
        <span v-if="importResult.pending">，待生效 <strong>{{ importResult.pending }}</strong> 条价格变更</span>
        <span v-if="importResult.batchNo">，批次号：{{ importResult.batchNo }}</span>
      </el-alert>
      <el-table v-if="importResult.errors.length > 0" :data="importResult.errors" stripe size="small" max-height="300">
        <el-table-column type="index" width="60" />
        <el-table-column prop="row" label="行号" width="90" />
        <el-table-column label="商品标识">
          <template #default="{ row }">
            {{ row.product?.['商品编码'] || row.product?.['厂商编码'] || row.product?.['商品名称'] || row.product?.['name'] || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="message" label="失败原因" />
      </el-table>
      <template #footer>
        <el-button @click="importResultVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="priceHistoryVisible" :title="`价格历史 - ${priceHistoryProduct?.product_code || ''}`" width="960px">
      <el-table :data="priceHistoryData" stripe border v-loading="priceHistoryLoading" max-height="420">
        <el-table-column prop="price_field_label" label="字段" width="100" />
        <el-table-column label="调整前" width="110">
          <template #default="{ row }">¥{{ formatNum(row.old_price) }}</template>
        </el-table-column>
        <el-table-column label="调整后" width="110">
          <template #default="{ row }">¥{{ formatNum(row.new_price) }}</template>
        </el-table-column>
        <el-table-column prop="status_label" label="状态" width="90" />
        <el-table-column prop="source_label" label="来源" width="100" />
        <el-table-column label="生效时间" width="160">
          <template #default="{ row }">{{ formatTime(row.effective_time) }}</template>
        </el-table-column>
        <el-table-column prop="batch_no" label="批次号" width="150" show-overflow-tooltip />
        <el-table-column prop="create_user" label="操作人" width="100" />
        <el-table-column prop="change_reason" label="调价原因" min-width="120" show-overflow-tooltip />
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
      </el-table>
      <el-pagination
        v-model:current-page="priceHistoryParams.page"
        v-model:page-size="priceHistoryParams.pageSize"
        :total="priceHistoryTotal"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadPriceHistory"
        @current-change="loadPriceHistory"
      />
      <template #footer>
        <el-button @click="priceHistoryVisible = false">关闭</el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Folder, Upload } from '@element-plus/icons-vue'
import * as XLSX from 'xlsx'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'

const currentUserInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
const currentRoleCode = currentUserInfo.roleCode || ''
const currentRoleCodes = Array.isArray(currentUserInfo.roles) && currentUserInfo.roles.length
  ? currentUserInfo.roles
  : String(currentRoleCode).split(',').map(item => item.trim()).filter(Boolean)
const productApprovalOnly = currentRoleCodes.length > 0 && currentRoleCodes.every(role => ['finance', 'purchaser'].includes(role))
const activeTab = ref(productApprovalOnly ? 'approval' : 'product')
const productDraftKey = () => productForm.productId ? `product-edit:${productForm.productId}` : 'product-create'

// ========== 商品管理 ==========
const loading = ref(false)
const tableData = ref([])
const total = ref(0)
const queryParams = reactive({ page: 1, pageSize: 20, keyword: '', categoryId: '' })
const categoryTree = ref([])
const canReviewProductApplications = ['finance', 'purchaser', 'admin', 'boss'].some(role => currentRoleCodes.includes(role))
const productApplications = ref([])
const applicationLoading = ref(false)
const applicationTotal = ref(0)
const applicationParams = reactive({ page: 1, pageSize: 20, status: '' })

const dialogVisible = ref(false)
const dialogTitle = ref('新建商品')
const submitLoading = ref(false)
const currentProduct = ref(null)
const formNewBarcode = ref('')
const formBarcodeType = ref('manufacturer')
const categoryFields = ref([])
const categoryFieldCatName = ref('')

const productForm = reactive({
  productId: null,
  name: '',
  productCode: '',
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
  extras: {},
  unit: '台',
  needSn: false,
  needImei: false,
  remark: '',
  status: 1,
  barcodes: [],
  attributes: {}
})

const addFormBarcode = () => {
  if (!formNewBarcode.value) { ElMessage.warning('请输入条码'); return }
  productForm.barcodes.push({ type: formBarcodeType.value, code: formNewBarcode.value })
  formNewBarcode.value = ''
}
const removeFormBarcode = (index) => { productForm.barcodes.splice(index, 1) }

const computedProductName = computed(() => {
  const parts = []
  for (const field of categoryFields.value) {
    if (productForm.attributes[field.field_key]) {
      parts.push(productForm.attributes[field.field_key])
    }
  }
  return parts.join(' ') || productForm.name || ''
})

const standardFields = ['brand', 'series', 'model', 'processor', 'memory', 'storage', 'color', 'gpu', 'accessory_type']
const getStandardFieldKey = (fieldKey) => {
  const normalizedKey = String(fieldKey || '').trim().toLowerCase()
  return standardFields.includes(normalizedKey) ? normalizedKey : ''
}
const categoryExtraFields = computed(() => {
  return categoryFields.value
})

function findCategoryByPath(tree, path) {
  if (!path || !tree) return null
  const parts = path.split('/')
  let current = tree
  let found = null
  for (const part of parts) {
    found = current.find(node => node.name === part)
    if (!found) return null
    current = found.children || []
  }
  return found ? found.category_id : null
}

const onCategoryChange = async (value) => {
  productForm.attributes = {}
  categoryFields.value = []
  categoryFieldCatName.value = ''
  if (!value) return

  try {
    const res = await api.getCategoryFieldConfig(value)
    if (res.code === 0 && res.data && res.data.fields) {
      categoryFields.value = res.data.fields
      categoryFieldCatName.value = res.data.categoryName || ''
      if (currentProduct.value) {
        productForm.brand = currentProduct.value.brand || ''
        productForm.series = currentProduct.value.series || ''
        productForm.model = currentProduct.value.model || ''
        productForm.processor = currentProduct.value.processor || ''
        productForm.memory = currentProduct.value.memory || ''
        productForm.storage = currentProduct.value.storage || ''
        productForm.color = currentProduct.value.color || ''
        productForm.accessory_type = currentProduct.value.accessory_type || ''
        const extras = currentProduct.value.extras
          ? (typeof currentProduct.value.extras === 'string' ? JSON.parse(currentProduct.value.extras) : currentProduct.value.extras)
          : {}
        productForm.extras = extras
        productForm.attributes = {}
        for (const field of categoryFields.value) {
          const standardKey = getStandardFieldKey(field.field_key)
          if (standardKey && currentProduct.value[standardKey]) {
            productForm.attributes[field.field_key] = currentProduct.value[standardKey]
          }
        }
        for (const [k, v] of Object.entries(extras)) {
          productForm.attributes[k] = v
        }
      }
    }
  } catch (err) { /* ignore */ }
}

const loadData = async () => {
  loading.value = true
  try {
    const res = await api.getProductList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.pagination?.total || 0
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '加载数据失败')
  } finally { loading.value = false }
}

const loadCategoryTree = async () => {
  try {
    const res = await api.getCategoryTree()
    if (res.code === 0) categoryTree.value = res.data || []
  } catch (err) { /* ignore */ }
}

const handleCreate = async () => {
  dialogTitle.value = '新建商品'
  resetForm()
  restoreProductDraft()
  if (productForm.categoryId) {
    await onCategoryChange(productForm.categoryId)
  }
  dialogVisible.value = true
}

const handleEdit = async (row) => {
  dialogTitle.value = '编辑商品'
  currentProduct.value = row
  productForm.productId = row.product_id
  productForm.name = row.name
  productForm.productCode = row.product_code
  productForm.categoryId = ''
  productForm.config = row.config || ''
  productForm.brand = row.brand || ''
  productForm.series = row.series || ''
  productForm.model = row.model || ''
  productForm.processor = row.processor || ''
  productForm.memory = row.memory || ''
  productForm.storage = row.storage || ''
  productForm.color = row.color || ''
  productForm.gpu = row.gpu || ''
  productForm.accessory_type = row.accessory_type || ''
  const extras = row.extras
    ? (typeof row.extras === 'string' ? JSON.parse(row.extras) : row.extras)
    : {}
  productForm.extras = extras
  productForm.attributes = { ...extras }
  productForm.unit = row.unit || '台'
  productForm.needSn = !!row.need_sn
  productForm.needImei = !!row.need_imei
  productForm.remark = row.remark || ''
  productForm.status = row.status || 1
  productForm.barcodes = (row.barcodes || []).map(b => ({ type: b.type, code: b.code }))
  categoryFields.value = []
  categoryFieldCatName.value = ''

  if (row.category) {
    const catId = findCategoryByPath(categoryTree.value, row.category)
    if (catId) {
      productForm.categoryId = catId
    }
  }

  dialogVisible.value = true

  if (productForm.categoryId) {
    await onCategoryChange(productForm.categoryId)
  }
  restoreProductDraft()
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm('确定要删除该商品吗？', '提示', { type: 'warning' })
    const res = await api.deleteProduct(row.product_id)
    if (res.code === 0) { ElMessage.success('删除成功'); loadData() }
    else { ElMessage.error(res.message || '删除失败') }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err?.response?.data?.message || '删除失败')
  }
}

const handleTogglePause = async (row) => {
  const action = row.status === 1 ? '暂停' : '启用'
  try {
    await ElMessageBox.confirm(`确定要${action}该商品吗？`, '提示', { type: 'warning' })
    const res = await api.togglePause(row.product_id)
    if (res.code === 0) { ElMessage.success(res.message); loadData() }
    else { ElMessage.error(res.message || '操作失败') }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err?.response?.data?.message || '操作失败')
  }
}

const resetForm = () => {
  productForm.productId = null
  productForm.name = ''
  productForm.productCode = ''
  productForm.categoryId = ''
  productForm.config = ''
  productForm.brand = ''
  productForm.series = ''
  productForm.model = ''
  productForm.processor = ''
  productForm.memory = ''
  productForm.storage = ''
  productForm.color = ''
  productForm.gpu = ''
  productForm.accessory_type = ''
  productForm.extras = {}
  productForm.unit = '台'
  productForm.needSn = false
  productForm.needImei = false
  productForm.remark = ''
  productForm.status = 1
  productForm.barcodes = []
  productForm.attributes = {}
  categoryFields.value = []
  categoryFieldCatName.value = ''
  formNewBarcode.value = ''
  formBarcodeType.value = 'manufacturer'
  currentProduct.value = null
}

const handleDialogClose = () => { resetForm() }

const saveProductDraft = () => {
  saveDraft(productDraftKey(), {
    productForm: cloneDraft(productForm),
    formNewBarcode: formNewBarcode.value,
    formBarcodeType: formBarcodeType.value
  })
  ElMessage.success('草稿已保存')
}

const restoreProductDraft = () => {
  const draft = loadDraft(productDraftKey())
  if (!draft?.productForm) return
  Object.assign(productForm, draft.productForm)
  productForm.barcodes = Array.isArray(draft.productForm.barcodes) ? draft.productForm.barcodes : []
  productForm.attributes = draft.productForm.attributes || {}
  productForm.extras = draft.productForm.extras || {}
  formNewBarcode.value = draft.formNewBarcode || ''
  formBarcodeType.value = draft.formBarcodeType || 'manufacturer'
  ElMessage.success('已恢复上次草稿')
}

const handleSubmit = async () => {
  const finalName = computedProductName.value || productForm.name
  if (!finalName) { ElMessage.warning('请填写补充字段'); return }
  submitLoading.value = true
  try {
    const attributes = {}
    for (const [k, v] of Object.entries(productForm.attributes)) {
      if (v !== undefined && v !== null && v !== '') attributes[k] = v
    }
    const data = {
      name: finalName,
      categoryId: productForm.categoryId || null,
      config: productForm.config,
      unit: productForm.unit,
      needSn: productForm.needSn ? 1 : 0,
      needImei: productForm.needImei ? 1 : 0,
      remark: productForm.remark,
      status: productForm.status,
      barcodes: productForm.barcodes,
      attributes: Object.keys(attributes).length > 0 ? attributes : null,
    }
    let res
    if (productForm.productId) {
      res = await api.updateProduct(productForm.productId, data)
    } else {
      res = await api.createProduct(data)
    }
    if (res.code === 0) {
      const isApplication = !productForm.productId && res.pendingApproval
      ElMessage.success(isApplication ? '新建商品申请已提交，等待审批' : (productForm.productId ? '更新成功' : '创建成功'))
      clearDraft(productDraftKey())
      dialogVisible.value = false
      if (isApplication) {
        activeTab.value = 'approval'
        loadProductApplications()
      } else {
        loadData()
      }
    } else { ElMessage.error(res.message || '操作失败') }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '操作失败')
  } finally { submitLoading.value = false }
}

// ========== 分类管理 ==========
const categoryLoading = ref(false)
const categoryDialogVisible = ref(false)
const categoryDialogTitle = ref('')
const categorySaveLoading = ref(false)
const categoryParentName = ref('无（一级分类）')
const editingCategory = ref(null)
const parentCategory = ref(null)
const categoryForm = reactive({ name: '', sortOrder: 0 })

const handleAddCategory = (parent) => {
  editingCategory.value = null; parentCategory.value = parent
  const siblingCount = parent ? (parent.children?.length || 0) : categoryTree.value.length
  categoryForm.name = ''; categoryForm.sortOrder = siblingCount
  categoryParentName.value = parent ? parent.name : '无（一级分类）'
  categoryDialogTitle.value = parent ? `添加子分类 - ${parent.name}` : '新增一级分类'
  categoryDialogVisible.value = true
}
const handleEditCategory = (row) => {
  editingCategory.value = row; parentCategory.value = null
  categoryForm.name = row.name; categoryForm.sortOrder = row.sort_order || 0
  categoryParentName.value = row.parent_id ? '（已有父级）' : '无（一级分类）'
  categoryDialogTitle.value = `编辑分类 - ${row.name}`
  categoryDialogVisible.value = true
}
const handleDeleteCategory = async (row) => {
  try {
    await ElMessageBox.confirm(`确定要删除分类"${row.name}"吗？`, '提示', { type: 'warning' })
    const res = await api.deleteCategory(row.category_id)
    if (res.code === 0) { ElMessage.success('删除成功'); loadCategoryTree() }
    else ElMessage.error(res.message || '删除失败')
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err?.response?.data?.message || '删除失败')
  }
}
const handleSaveCategory = async () => {
  if (!categoryForm.name) { ElMessage.warning('请输入分类名称'); return }
  categorySaveLoading.value = true
  try {
    if (editingCategory.value) {
      const res = await api.updateCategory(editingCategory.value.category_id, { name: categoryForm.name, sortOrder: categoryForm.sortOrder })
      if (res.code === 0) { ElMessage.success('更新成功'); categoryDialogVisible.value = false; loadCategoryTree() }
      else ElMessage.error(res.message || '更新失败')
    } else {
      const res = await api.createCategory({ parentId: parentCategory.value?.category_id || null, name: categoryForm.name, sortOrder: categoryForm.sortOrder })
      if (res.code === 0) { ElMessage.success('创建成功'); categoryDialogVisible.value = false; loadCategoryTree() }
      else ElMessage.error(res.message || '创建失败')
    }
  } catch (err) { ElMessage.error(err?.response?.data?.message || '保存失败') }
  finally { categorySaveLoading.value = false }
}
const resetCategoryForm = () => { categoryForm.name = ''; categoryForm.sortOrder = 0; editingCategory.value = null; parentCategory.value = null }

const handleMoveCategory = async (row, siblings, index, direction) => {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= siblings.length) return

  const sorted = [...siblings]
  ;[sorted[index], sorted[targetIndex]] = [sorted[targetIndex], sorted[index]]

  try {
    const res = await api.sortCategories({
      items: sorted.map((item, idx) => ({ id: item.category_id, sortOrder: idx }))
    })
    if (res.code === 0) {
      ElMessage.success('排序已更新')
      await loadCategoryTree()
    } else {
      ElMessage.error(res.message || '排序失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '排序失败')
  }
}

// ========== 价格管理 ==========
const priceLoading = ref(false); const priceTableData = ref([]); const priceTotal = ref(0)
const priceParams = reactive({ page: 1, pageSize: 20, keyword: '' })
const priceTableRef = ref(null); const selectedPriceRows = ref([])
const batchRefreshLoading = ref(false)
const priceImportDialogVisible = ref(false)
const priceImportFile = ref(null)
const priceImportLoading = ref(false)
const priceImportValidated = ref(false)
const priceImportValidation = reactive({ success: 0, failed: 0, errors: [], affectedProducts: 0, priceChanges: 0, canImport: false })
const costImportDialogVisible = ref(false)
const costImportFile = ref(null)
const costImportLoading = ref(false)
const priceHistoryVisible = ref(false)
const priceHistoryLoading = ref(false)
const priceHistoryData = ref([])
const priceHistoryTotal = ref(0)
const priceHistoryProduct = ref(null)
const priceHistoryParams = reactive({ page: 1, pageSize: 20, productId: '' })

const loadPriceData = async () => {
  priceLoading.value = true
  try {
    const res = await api.getPriceList(priceParams)
    if (res.code === 0) {
      priceTableData.value = (res.data?.list || []).map(p => ({ ...p, _editing: false, _stdPrice: p.standard_price || 0, _minPrice: p.min_sale_price || 0 }))
      priceTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) { ElMessage.error(err?.response?.data?.message || '加载失败') }
  finally { priceLoading.value = false }
}
const startEditPrice = (row) => { row._editing = true; row._stdPrice = row.standard_price || 0; row._minPrice = row.min_sale_price || 0 }
const cancelEditPrice = (row) => { row._editing = false }
const savePrice = async (row) => {
  if (Number(row._minPrice) > Number(row._stdPrice)) {
    ElMessage.warning('最低售价必须小于或等于定价')
    return
  }
  try {
    const res = await api.setPrice({ productId: row.product_id, standardPrice: row._stdPrice, minSalePrice: row._minPrice })
    if (res.code === 0) { row.standard_price = row._stdPrice; row.min_sale_price = row._minPrice; row._editing = false; ElMessage.success('更新成功') }
    else ElMessage.error(res.message || '更新失败')
  } catch (err) { ElMessage.error(err?.response?.data?.message || '更新失败') }
}
const handleRefreshCost = async (row) => {
  try {
    const res = await api.refreshCostPrice(row.product_id)
    if (res.code === 0) { row.cost_price = res.costPrice; ElMessage.success(`成本价已刷新: ¥${formatNum(res.costPrice)}`) }
    else ElMessage.error(res.message || '刷新失败')
  } catch (err) { ElMessage.error(err?.response?.data?.message || '刷新失败') }
}
const onPriceSelectionChange = (val) => { selectedPriceRows.value = val }
const handleBatchRefreshCost = async () => {
  if (selectedPriceRows.value.length === 0) { ElMessage.warning('请先选择'); return }
  batchRefreshLoading.value = true
  try {
    const res = await api.batchRefreshCost({ productIds: selectedPriceRows.value.map(r => r.product_id) })
    if (res.code === 0) {
      const costMap = {}
      for (const item of res.data) costMap[item.productId] = item.costPrice
      for (const row of priceTableData.value) { if (costMap[row.product_id] !== undefined) row.cost_price = costMap[row.product_id] }
      ElMessage.success(`已刷新 ${res.data.length} 个商品`)
      priceTableRef.value?.clearSelection()
    } else ElMessage.error(res.message || '失败')
  } catch (err) { ElMessage.error(err?.response?.data?.message || '失败') }
  finally { batchRefreshLoading.value = false }
}

const handlePriceImport = () => {
  priceImportFile.value = null
  resetPriceImportValidation()
  priceImportDialogVisible.value = true
}

const handlePriceFileChange = (file) => {
  priceImportFile.value = file.raw
  resetPriceImportValidation()
}

const clearPriceFile = () => {
  priceImportFile.value = null
  resetPriceImportValidation()
}

const resetPriceImportValidation = () => {
  priceImportValidated.value = false
  priceImportValidation.success = 0
  priceImportValidation.failed = 0
  priceImportValidation.errors = []
  priceImportValidation.affectedProducts = 0
  priceImportValidation.priceChanges = 0
  priceImportValidation.canImport = false
}

const downloadPriceTemplate = () => {
  const data = [{
    '商品编码': '',
    '厂商编码': '',
    '定价': '',
    '最低售价': '',
    '生效时间': '',
    '调价原因': '',
    '备注': ''
  }]
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '定价模板')
  ws['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 24 }]
  XLSX.writeFile(wb, '商品定价导入模板.xlsx')
}

const handlePriceImportSubmit = async () => {
  if (!priceImportFile.value) { ElMessage.warning('请选择文件'); return }
  resetPriceImportValidation()
  priceImportLoading.value = true
  try {
    const res = await api.importPrices(priceImportFile.value)
    if (res.code === 0) {
      const data = res.data || {}
      priceImportValidation.success = data.success || 0
      priceImportValidation.failed = data.failed || 0
      priceImportValidation.errors = data.errors || []
      priceImportValidation.affectedProducts = data.affectedProducts || 0
      priceImportValidation.priceChanges = data.priceChanges || 0
      priceImportValidation.canImport = false
      priceImportValidated.value = true
      loadPriceData()
      if (priceImportValidation.failed > 0) {
        priceImportFile.value = null
        ElMessage.warning(`已导入 ${priceImportValidation.success} 行，${priceImportValidation.failed} 行异常，请下载异常记录修改后重新导入`)
      } else {
        importResult.success = data.success || 0
        importResult.failed = data.failed || 0
        importResult.errors = []
        importResult.affectedProducts = data.affectedProducts || 0
        importResult.pending = data.pending || 0
        importResult.effective = data.effective || 0
        importResult.batchNo = data.batchNo || ''
        priceImportDialogVisible.value = false
        importResultVisible.value = true
      }
    } else ElMessage.error(res.message || '导入失败')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '导入失败')
  } finally {
    priceImportLoading.value = false
  }
}

const downloadPriceImportErrors = () => {
  if (!priceImportValidation.errors.length) {
    ElMessage.warning('暂无异常记录')
    return
  }
  const data = priceImportValidation.errors.map(item => ({
    '行号': item.row,
    ...(item.product || {}),
    '异常原因': item.message
  }))
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '异常记录')
  ws['!cols'] = Object.keys(data[0] || {}).map(key => ({ wch: Math.max(12, String(key).length + 6) }))
  XLSX.writeFile(wb, '商品定价导入异常记录.xlsx')
}

const showPriceHistory = async (row) => {
  priceHistoryProduct.value = row
  priceHistoryParams.productId = row.product_id
  priceHistoryParams.page = 1
  priceHistoryVisible.value = true
  await loadPriceHistory()
}

const loadPriceHistory = async () => {
  if (!priceHistoryParams.productId) return
  priceHistoryLoading.value = true
  try {
    const res = await api.getPriceChangeHistory(priceHistoryParams)
    if (res.code === 0) {
      priceHistoryData.value = res.data?.list || []
      priceHistoryTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '加载价格历史失败')
  } finally {
    priceHistoryLoading.value = false
  }
}

const handleCostImport = () => {
  costImportFile.value = null
  costImportDialogVisible.value = true
}

const handleCostFileChange = (file) => {
  costImportFile.value = file.raw
}

const clearCostFile = () => {
  costImportFile.value = null
}

const downloadCostTemplate = () => {
  const data = [{
    '商品编码': '',
    '商品名称': ''
  }]
  const ws = XLSX.utils.json_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '成本刷新模板')
  ws['!cols'] = [{ wch: 16 }, { wch: 24 }]
  XLSX.writeFile(wb, '商品成本刷新模板.xlsx')
}

const handleCostImportSubmit = async () => {
  if (!costImportFile.value) { ElMessage.warning('请选择文件'); return }
  costImportLoading.value = true
  try {
    const res = await api.importCostRefresh(costImportFile.value)
    if (res.code === 0) {
      importResult.success = res.data.success
      importResult.failed = res.data.failed
      importResult.errors = res.data.errors || []
      importResult.affectedProducts = 0
      importResult.pending = 0
      importResult.effective = 0
      importResult.batchNo = ''
      costImportDialogVisible.value = false
      importResultVisible.value = true
      loadPriceData()
    } else ElMessage.error(res.message || '刷新失败')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '刷新失败')
  } finally {
    costImportLoading.value = false
  }
}

// ========== PN管理 ==========
const pnDialogVisible = ref(false); const pnTableData = ref([])
const showAddPnForm = ref(false); const newPnCode = ref(''); const newPnBarcode = ref('')
const pnQueryParams = reactive({ keyword: '', productId: '' })

const handlePnManage = async (row) => {
  currentProduct.value = row; pnQueryParams.productId = row.product_id
  pnQueryParams.keyword = ''; showAddPnForm.value = false; newPnCode.value = ''; newPnBarcode.value = ''
  await loadPnData(); pnDialogVisible.value = true
}
const loadPnData = async () => {
  try { const res = await api.getPnList(pnQueryParams); if (res.code === 0) pnTableData.value = res.data?.list || [] }
  catch (err) { ElMessage.error('加载PN失败') }
}
const handleAddPn = async () => {
  if (!newPnCode.value) { ElMessage.warning('请输入PN码'); return }
  try {
    const res = await api.addPn({ productId: currentProduct.value.product_id, pnCode: newPnCode.value, barcode: newPnBarcode.value })
    if (res.code === 0) { ElMessage.success('添加成功'); newPnCode.value = ''; newPnBarcode.value = ''; showAddPnForm.value = false; loadPnData() }
    else ElMessage.error(res.message || '添加失败')
  } catch (err) { ElMessage.error(err?.response?.data?.message || '添加失败') }
}

// ========== 批量导入 ==========
const importDialogVisible = ref(false); const importFile = ref(null)
const importLoading = ref(false); const importResultVisible = ref(false)
const importResult = reactive({ success: 0, failed: 0, errors: [], affectedProducts: 0, pending: 0, effective: 0, batchNo: '' })

const handleImport = () => { importFile.value = null; importDialogVisible.value = true }
const handleExport = async () => {
  try {
    await api.exportProducts({
      keyword: queryParams.keyword,
      categoryId: queryParams.categoryId
    });
    ElMessage.success('导出成功');
  } catch (error) {
    ElMessage.error(error?.message || '导出失败');
  }
}
const handleFileChange = (file) => { importFile.value = file.raw }
const clearFile = () => { importFile.value = null }
const downloadTemplate = () => {
  const d = [{
    '商品名称': '',
    '商品分类': '电子产品/笔记本',
    '品牌': '',
    '系列': '',
    '型号': '',
    '处理器': '',
    '内存': '',
    '存储': '',
    '颜色': '',
    '显卡': '',
    '配件类别': '',
    '厂商商品名称': '',
    '单位': '台',
    '需要SN码': '是',
    '厂商编码': '',
    '69码': '',
    '详细配置': '',
    '状态': '启用'
  }]
  const ws = XLSX.utils.json_to_sheet(d); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '模板')
  ws['!cols'] = Array(19).fill(null).map(() => ({ wch: 14 }))
  XLSX.writeFile(wb, '商品导入模板.xlsx')
}

const getProductImportErrorMessage = (source) => {
  const payload = source?.response?.data || source || {}
  const errors = payload?.data?.errors || payload?.errors || []
  const details = Array.isArray(errors)
    ? errors.slice(0, 3).map(item => {
        const row = item?.row ? `第${item.row}行：` : ''
        return `${row}${item?.message || item?.reason || ''}`
      }).filter(Boolean)
    : []
  const message = payload?.message || payload?.error || source?.message || '导入失败'
  return details.length > 0 ? `${message}；${details.join('；')}` : message
}

const handleImportSubmit = async () => {
  if (!importFile.value) { ElMessage.warning('请选择文件'); return }
  importLoading.value = true
  try {
    const res = await api.importProducts(importFile.value)
    if (res.code === 0) {
      importResult.success = res.data.success; importResult.failed = res.data.failed; importResult.errors = res.data.errors || []
      importResult.affectedProducts = 0; importResult.pending = 0; importResult.effective = 0; importResult.batchNo = ''
      importDialogVisible.value = false; importResultVisible.value = true; loadData()
    } else ElMessage.error(getProductImportErrorMessage(res))
  } catch (err) { ElMessage.error(getProductImportErrorMessage(err)) }
  finally { importLoading.value = false }
}

const formatNum = (v) => { if (v === null || v === undefined) return '0.00'; return Number(v).toFixed(2) }
const formatTime = (t) => { if (!t) return '-'; const d = new Date(t); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0') }

const loadProductApplications = async () => {
  applicationLoading.value = true
  try {
    const res = await api.getProductApplicationList(applicationParams)
    if (res.code === 0) {
      productApplications.value = res.data?.list || []
      applicationTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '商品申请加载失败')
  } finally {
    applicationLoading.value = false
  }
}

const productApplicationStatusText = (status) => ({ pending: '待审批', approved: '已通过', rejected: '已拒绝' }[status] || status)
const productApplicationStatusType = (status) => ({ pending: 'warning', approved: 'success', rejected: 'danger' }[status] || 'info')
const isOwnProductApplication = (row) => Number(row.applicant_staff_id) === Number(currentUserInfo.staffId || currentUserInfo.id)

const reviewProductApplication = async (row, action) => {
  try {
    let comment = ''
    if (action === 'rejected') {
      const prompt = await ElMessageBox.prompt('请输入拒绝原因', '拒绝商品申请', {
        confirmButtonText: '确定拒绝', cancelButtonText: '取消', inputValidator: value => Boolean(String(value || '').trim()), inputErrorMessage: '拒绝原因不能为空'
      })
      comment = prompt.value
    } else {
      await ElMessageBox.confirm(`确认通过商品「${row.product_name}」的新建申请？`, '审批确认', { type: 'warning' })
    }
    const res = await api.reviewProductApplication(row.application_id, { action, comment })
    if (res.code === 0) {
      ElMessage.success(res.message || '审批完成')
      await loadProductApplications()
      if (action === 'approved') loadData()
    }
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err?.response?.data?.message || err?.message || '审批失败')
  }
}

const onTabChange = (tab) => {
  if (tab === 'product') loadData()
  else if (tab === 'category') loadCategoryTree()
  else if (tab === 'price') loadPriceData()
  else if (tab === 'approval') loadProductApplications()
}
onMounted(() => {
  if (productApprovalOnly) loadProductApplications()
  else { loadData(); loadCategoryTree() }
})
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; }
.filter-bar { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 16px; align-items: center; }
.el-pagination { margin-top: 16px; justify-content: flex-end; }
.text-muted { color: #c0c4cc; }
.cost-price { font-weight: 600; color: #e6a23c; }

/* 表格自动换行样式 */
:deep(.el-table .cell) {
  white-space: normal !important;
  word-break: break-all !important;
}


.category-tree { padding: 8px 0; }
.category-row { display: flex; align-items: center; gap: 8px; padding: 10px 14px; margin: 4px 0; border-radius: 8px; background: #f5f7fa; transition: all 0.2s; }
.category-row:hover { background: #ecf5ff; }
.cat-name { font-weight: 500; flex: 1; }
.cat-level { font-size: 12px; color: #909399; background: #e4e7ed; padding: 2px 8px; border-radius: 4px; }
.cat-actions { display: flex; gap: 4px; }
.sub-categories { margin-left: 28px; border-left: 2px solid #e4e7ed; padding-left: 12px; }

.import-tips { margin-bottom: 16px; padding: 16px; background: #f5f7fa; border-radius: 8px; }
.import-tips p { margin: 0 0 12px 0; color: #606266; }
.selected-file { margin-top: 12px; text-align: center; }
</style>
