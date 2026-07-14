/**
 * 商品管理路由
 */
const Router = require('koa-router');
const multer = require('@koa/multer');
const {
  getProductList, submitProductApplication, getProductApplicationList, reviewProductApplication,
  updateProduct, deleteProduct, batchDeleteProducts, togglePause, importProducts, exportProducts,
  getBarcodes, addBarcode, deleteBarcode,
  getCategoryTree, createCategory, updateCategory, deleteCategory, sortCategories,
  getCategoryFields, saveCategoryFields, getCategoryFieldConfig,
  getPriceList, setPrice, refreshCostPrice, batchRefreshCost, validateImportPrices, importPrices, importCostRefresh, getPriceChangeHistory,
  getProductImportTask,
  getPnList, addPn, searchProduct
} = require('./controller');
const { requireRole } = require('../../middleware/permission');

const router = new Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 商品基础管理
router.get('/list', getProductList);
router.get('/search', searchProduct);
router.get('/export', exportProducts);
router.get('/application-list', getProductApplicationList);
router.post('/application', submitProductApplication);
router.post('/application/:applicationId/review', requireRole('finance', 'purchaser'), reviewProductApplication);
// 兼容现有客户端：手工新建商品统一转为审批申请。
router.post('/create', submitProductApplication);
router.put('/update/:productId', updateProduct);
router.post('/batch-delete', batchDeleteProducts);
router.delete('/delete/:productId', deleteProduct);
router.post('/toggle-pause/:productId', togglePause);
router.post('/import', upload.single('file'), importProducts);
router.get('/import/task/:taskId', getProductImportTask);

// 商品条码
router.get('/barcode', getBarcodes);
router.post('/barcode', addBarcode);
router.delete('/barcode/:barcodeId', deleteBarcode);

// 商品分类
router.get('/category/tree', getCategoryTree);
router.post('/category/sort', sortCategories);
router.post('/category', createCategory);
router.put('/category/:categoryId', updateCategory);
router.delete('/category/:categoryId', deleteCategory);

// 分类字段配置
router.get('/category/fields', getCategoryFields);
router.post('/category/fields', saveCategoryFields);
router.get('/category/field-config', getCategoryFieldConfig);

// 商品价格
router.get('/price/list', getPriceList);
router.post('/price/set', setPrice);
router.post('/price/refresh-cost/:productId', refreshCostPrice);
router.post('/price/batch-refresh-cost', batchRefreshCost);
router.post('/price/import/validate', upload.single('file'), validateImportPrices);
router.post('/price/import', upload.single('file'), importPrices);
router.post('/price/import-cost-refresh', upload.single('file'), importCostRefresh);
router.get('/price/history', getPriceChangeHistory);

// PN管理
router.get('/pn-list', getPnList);
router.post('/pn', addPn);

module.exports = router;
