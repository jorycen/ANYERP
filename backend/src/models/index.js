/**
 * 模型索引 - Sequelize 模型定义
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// ----------------------------------------
// 组织架构模型
// ----------------------------------------

// 区域
const Region = sequelize.define('Region', {
  region_id: { type: DataTypes.STRING(32), primaryKey: true },
  region_code: { type: DataTypes.STRING(32), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(128), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_REGION', timestamps: false });

// 经销商
const Distributor = sequelize.define('Distributor', {
  distributor_id: { type: DataTypes.STRING(32), primaryKey: true },
  region_id: { type: DataTypes.STRING(32) },
  name: { type: DataTypes.STRING(255), allowNull: false },
  equity_ratio: { type: DataTypes.DECIMAL(5, 2) },
  phone: { type: DataTypes.STRING(32) },
  address: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_DISTRIBUTOR', timestamps: false });

// 门店
const Store = sequelize.define('Store', {
  store_id: { type: DataTypes.STRING(32), primaryKey: true },
  distributor_id: { type: DataTypes.STRING(32) },
  region_id: { type: DataTypes.STRING(32) },
  name: { type: DataTypes.STRING(255), allowNull: false },
  address: { type: DataTypes.STRING(512) },
  phone: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_STORE', timestamps: false });

// 员工
const Staff = sequelize.define('Staff', {
  staff_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  distributor_id: { type: DataTypes.STRING(32), allowNull: false },
  store_id: { type: DataTypes.STRING(32) },
  region_id: { type: DataTypes.STRING(32) },
  name: { type: DataTypes.STRING(64), allowNull: false },
  phone: { type: DataTypes.STRING(32), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING(128) },
  role_code: { type: DataTypes.STRING(32), defaultValue: 'staff' },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_STAFF', timestamps: false });

// ----------------------------------------
// 权限模型
// ----------------------------------------

// 菜单
const Menu = sequelize.define('Menu', {
  menu_id: { type: DataTypes.STRING(32), primaryKey: true },
  menu_code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(128), allowNull: false },
  parent_id: { type: DataTypes.STRING(32) },
  menu_type: { type: DataTypes.STRING(16) },
  path: { type: DataTypes.STRING(256) },
  icon: { type: DataTypes.STRING(64) },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_MENU', timestamps: false });

// 角色
const Role = sequelize.define('Role', {
  role_id: { type: DataTypes.STRING(32), primaryKey: true },
  role_code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(128), allowNull: false },
  description: { type: DataTypes.STRING(512) },
  is_system: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_ROLE', timestamps: false });

// 角色菜单关联
const RoleMenu = sequelize.define('RoleMenu', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  role_id: { type: DataTypes.STRING(32), allowNull: false },
  menu_id: { type: DataTypes.STRING(32), allowNull: false }
}, { tableName: 'T_ROLE_MENU', timestamps: false });

// 员工角色关联
const StaffRole = sequelize.define('StaffRole', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  staff_id: { type: DataTypes.BIGINT(20), allowNull: false },
  role_id: { type: DataTypes.STRING(32), allowNull: false }
}, { tableName: 'T_STAFF_ROLE', timestamps: false });

// 区域权限
const RegionPermission = sequelize.define('RegionPermission', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  staff_id: { type: DataTypes.STRING(32), allowNull: false },
  region_code: { type: DataTypes.STRING(32), allowNull: false },
  can_view: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  can_manage: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_REGION_PERMISSION', timestamps: false });

// ----------------------------------------
// 商品模型
// ----------------------------------------

// 商品主表（仅基础信息，不含价格和编码）
const Product = sequelize.define('Product', {
  product_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_code: { type: DataTypes.STRING(32), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(255), allowNull: false },
  category: { type: DataTypes.STRING(512), allowNull: true, comment: '分类路径: 一级/二级/三级' },
  config: { type: DataTypes.STRING(512), allowNull: true, comment: '厂商商品名称' },
  manufacturer_code: { type: DataTypes.STRING(512), allowNull: true, comment: 'manufacturer code' },
  need_sn: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  need_imei: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  unit: { type: DataTypes.STRING(16), defaultValue: '台' },
  specs_json: { type: DataTypes.JSON, allowNull: true },
  brand: { type: DataTypes.STRING(64), allowNull: true, comment: '品牌' },
  series: { type: DataTypes.STRING(64), allowNull: true, comment: '系列' },
  model: { type: DataTypes.STRING(64), allowNull: true, comment: '型号' },
  processor: { type: DataTypes.STRING(64), allowNull: true, comment: '处理器' },
  memory: { type: DataTypes.STRING(32), allowNull: true, comment: '内存' },
  storage: { type: DataTypes.STRING(32), allowNull: true, comment: '存储' },
  color: { type: DataTypes.STRING(32), allowNull: true, comment: '颜色' },
  gpu: { type: DataTypes.STRING(64), allowNull: true, comment: '显卡/GPU' },
  accessory_type: { type: DataTypes.STRING(64), allowNull: true, comment: '配件类别' },
  extras: { type: DataTypes.TEXT, allowNull: true, comment: '扩展属性JSON' },
  remark: { type: DataTypes.STRING(512), allowNull: true },
  create_time: { type: DataTypes.DATE, comment: '创建时间' },
  status: { type: DataTypes.TINYINT, defaultValue: 1, comment: '1启用 0暂停' },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { 
  tableName: 'T_PRODUCT', 
  timestamps: false,
  underscored: true
});

// PN料号
const ProductPn = sequelize.define('ProductPn', {
  pn_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  pn_code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  barcode: { type: DataTypes.STRING(64) },
  is_primary: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_PRODUCT_PN', timestamps: false });

// SN序列号
const ProductSn = sequelize.define('ProductSn', {
  sn_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  pn_code: { type: DataTypes.STRING(64) },
  pn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128), unique: true, allowNull: false },
  imei1: { type: DataTypes.STRING(32) },
  imei2: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.STRING(32), defaultValue: 'in_stock' },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  store_id: { type: DataTypes.STRING(32) },
  location_id: { type: DataTypes.STRING(32) },
  inbound_time: { type: DataTypes.DATE },
  inbound_price: { type: DataTypes.DECIMAL(12, 2) },
  batch_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.STRING(255) },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_PRODUCT_SN', timestamps: false });

// 商品条码（厂商编码/69码，一个商品可有多个）
const ProductBarcode = sequelize.define('ProductBarcode', {
  barcode_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  barcode_type: { type: DataTypes.STRING(16), allowNull: false, comment: 'manufacturer / barcode69' },
  barcode_code: { type: DataTypes.STRING(128), allowNull: false },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_PRODUCT_BARCODE', timestamps: false });

// SN变更日志
const SnLog = sequelize.define('SnLog', {
  log_id: { type: DataTypes.STRING(32), primaryKey: true },
  sn_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_code: { type: DataTypes.STRING(128) },
  old_sn_code: { type: DataTypes.STRING(128) },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  store_id: { type: DataTypes.STRING(32) },
  action: { type: DataTypes.STRING(32), allowNull: false },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SN_LOG', timestamps: false });

// 商品分类（三级树形结构）
const ProductCategory = sequelize.define('ProductCategory', {
  category_id: { type: DataTypes.STRING(32), primaryKey: true },
  parent_id: { type: DataTypes.STRING(32), allowNull: true },
  name: { type: DataTypes.STRING(128), allowNull: false },
  level: { type: DataTypes.INTEGER, defaultValue: 1 },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_PRODUCT_CATEGORY', timestamps: false });

// 商品分类字段配置（每个分类可配置不同的输入字段）
const ProductCategoryField = sequelize.define('ProductCategoryField', {
  field_id: { type: DataTypes.STRING(32), primaryKey: true },
  category_id: { type: DataTypes.STRING(32), allowNull: false },
  field_label: { type: DataTypes.STRING(64), allowNull: false, comment: '字段显示名' },
  field_key: { type: DataTypes.STRING(64), allowNull: false, comment: '字段标识' },
  field_type: { type: DataTypes.STRING(32), defaultValue: 'text', comment: 'text/select' },
  field_options: { type: DataTypes.TEXT, comment: 'select选项(JSON数组)' },
  field_placeholder: { type: DataTypes.STRING(128), comment: '输入提示词' },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  required: { type: DataTypes.TINYINT, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_PRODUCT_CATEGORY_FIELD', timestamps: false });

// 商品价格（与商品基础信息分离）
const ProductPrice = sequelize.define('ProductPrice', {
  price_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  cost_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '库存成本价（加权平均）' },
  standard_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '标准售价' },
  min_sale_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '最低销售价' },
  effective_time: { type: DataTypes.DATE, comment: '生效时间' },
  create_user: { type: DataTypes.STRING(64) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_PRODUCT_PRICE', timestamps: false });

// ----------------------------------------
// 库房模型
// ----------------------------------------

// 库位
const Location = sequelize.define('Location', {
  location_id: { type: DataTypes.STRING(32), primaryKey: true },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  name: { type: DataTypes.STRING(64), allowNull: false },
  type: { type: DataTypes.STRING(32), defaultValue: 'normal' },
  is_sellable: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_LOCATION', timestamps: false });

// 库存预警配置
const InventoryWarning = sequelize.define('InventoryWarning', {
  warning_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32) },
  category: { type: DataTypes.STRING(64) },
  min_stock: { type: DataTypes.INTEGER, defaultValue: 0 },
  aging_days: { type: DataTypes.INTEGER, defaultValue: 90 },
  warning_type: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_INVENTORY_WARNING', timestamps: false });

// 退库日志
const ReturnStock = sequelize.define('ReturnStock', {
  return_id: { type: DataTypes.STRING(32), primaryKey: true },
  return_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  inbound_id: { type: DataTypes.STRING(32), allowNull: false },
  inbound_no: { type: DataTypes.STRING(64) },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  total_quantity: { type: DataTypes.INTEGER, defaultValue: 0 },
  total_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  reason: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_RETURN_STOCK', timestamps: false });

// 退库明细
const ReturnStockItem = sequelize.define('ReturnStockItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  return_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  sn_code: { type: DataTypes.STRING(128) },
  sn_id: { type: DataTypes.STRING(32) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  unit_price: { type: DataTypes.DECIMAL(12, 2) },
  remark: { type: DataTypes.STRING(255) }
}, { tableName: 'T_RETURN_STOCK_ITEM', timestamps: false });

// 库存聚合
const Inventory = sequelize.define('Inventory', {
  inventory_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
  normal_qty: { type: DataTypes.INTEGER, defaultValue: 0 },
  regular_qty: { type: DataTypes.INTEGER, defaultValue: 0, comment: '正规货数量' },
  subsidy_qty: { type: DataTypes.INTEGER, defaultValue: 0, comment: '国补货数量' },
  second_qty: { type: DataTypes.INTEGER, defaultValue: 0, comment: '纯二批数量' },
  display_qty: { type: DataTypes.INTEGER, defaultValue: 0 },
  demo_qty: { type: DataTypes.INTEGER, defaultValue: 0 },
  unsellable_qty: { type: DataTypes.INTEGER, defaultValue: 0 },
  pending_qty: { type: DataTypes.INTEGER, defaultValue: 0 }
}, { tableName: 'T_INVENTORY', timestamps: false, createdAt: false, updatedAt: 'update_time' });

// ----------------------------------------
// 采购模型
// ----------------------------------------

// 供应商
const Supplier = sequelize.define('Supplier', {
  supplier_id: { type: DataTypes.STRING(32), primaryKey: true },
  name: { type: DataTypes.STRING(255), allowNull: false },
  contact: { type: DataTypes.STRING(64) },
  phone: { type: DataTypes.STRING(32) },
  address: { type: DataTypes.STRING(512) },
  invoice_type: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_SUPPLIER', timestamps: false });

// 采购申请
const PurchaseRequest = sequelize.define('PurchaseRequest', {
  request_id: { type: DataTypes.STRING(32), primaryKey: true },
  request_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_id: { type: DataTypes.STRING(32) },
  invoice_type: { type: DataTypes.STRING(32) },
  total_amount: { type: DataTypes.DECIMAL(12, 2) },
  rebate_deduction: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  actual_total: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  reason: { type: DataTypes.TEXT },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  apply_user: { type: DataTypes.STRING(64) },
  approve_user: { type: DataTypes.STRING(64) },
  approve_comment: { type: DataTypes.STRING(512) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PURCHASE_REQUEST', timestamps: false });

// 采购申请明细
const PurchaseRequestItem = sequelize.define('PurchaseRequestItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  request_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  unit_price: { type: DataTypes.DECIMAL(12, 2) },
  subtotal: { type: DataTypes.DECIMAL(12, 2) },
  product_type: { type: DataTypes.STRING(32), comment: '货型：正规货/国补货/纯二批' },
  store_allocations: { type: DataTypes.TEXT }
}, { tableName: 'T_PURCHASE_REQUEST_ITEM', timestamps: false });

// 采购单
const PurchaseOrder = sequelize.define('PurchaseOrder', {
  order_id: { type: DataTypes.STRING(32), primaryKey: true },
  order_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  request_id: { type: DataTypes.STRING(32) },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  total_amount: { type: DataTypes.DECIMAL(12, 2) },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'purchased' },
  create_user: { type: DataTypes.STRING(64) }
}, { tableName: 'T_PURCHASE_ORDER', timestamps: false });

// 采购单明细
const PurchaseOrderItem = sequelize.define('PurchaseOrderItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  unit_price: { type: DataTypes.DECIMAL(12, 2) },
  subtotal: { type: DataTypes.DECIMAL(12, 2) }
}, { tableName: 'T_PURCHASE_ORDER_ITEM', timestamps: false });

// ----------------------------------------
// 销售模型
// ----------------------------------------

// 销售订单
const Order = sequelize.define('Order', {
  order_id: { type: DataTypes.STRING(32), primaryKey: true },
  order_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  create_user: { type: DataTypes.STRING(64) },
  customer_name: { type: DataTypes.STRING(64) },
  customer_phone: { type: DataTypes.STRING(32) },
  customer_source: { type: DataTypes.STRING(64) },
  total_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  discount_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  national_subsidy: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  education_subsidy: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  actual_payment: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  invoice_status: { type: DataTypes.STRING(32), defaultValue: '不开票' },
  order_status: { type: DataTypes.STRING(32), defaultValue: 'completed' },
  subsidy_status: { type: DataTypes.STRING(32) },
  subsidy_person: { type: DataTypes.STRING(64) },
  subsidy_id: { type: DataTypes.STRING(32) },
  remark: { type: DataTypes.TEXT },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_ORDER', timestamps: false });

// 订单明细
const OrderItem = sequelize.define('OrderItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  imei1: { type: DataTypes.STRING(32) },
  imei2: { type: DataTypes.STRING(32) },
  sale_price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false }
}, { tableName: 'T_ORDER_ITEM', timestamps: false });

// 订单支付记录
const OrderPayment = sequelize.define('OrderPayment', {
  payment_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  payment_method: { type: DataTypes.STRING(64), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_ORDER_PAYMENT', timestamps: false });

// 订单附件
const OrderAttachment = sequelize.define('OrderAttachment', {
  attach_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  attach_type: { type: DataTypes.STRING(64) },
  file_url: { type: DataTypes.STRING(1024), allowNull: false }
}, { tableName: 'T_ORDER_ATTACHMENT', timestamps: false });

// ----------------------------------------
// 库房操作模型
// ----------------------------------------

// 入库单
const Inbound = sequelize.define('Inbound', {
  inbound_id: { type: DataTypes.STRING(32), primaryKey: true },
  inbound_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  source_type: { type: DataTypes.STRING(32) },
  source_no: { type: DataTypes.STRING(64) },
  purchase_request_id: { type: DataTypes.STRING(32) },
  total_amount: { type: DataTypes.DECIMAL(12, 2) },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_INBOUND', timestamps: false });

// 入库明细
const InboundItem = sequelize.define('InboundItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  inbound_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  unit_price: { type: DataTypes.DECIMAL(12, 2) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  remark: { type: DataTypes.STRING(512) },
  location_id: { type: DataTypes.STRING(32) },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  product_type: { type: DataTypes.STRING(32), comment: '货型：正规货/国补货/纯二批' },
  store_allocations: { type: DataTypes.TEXT }
}, { tableName: 'T_INBOUND_ITEM', timestamps: false });

// 出库单
const Outbound = sequelize.define('Outbound', {
  outbound_id: { type: DataTypes.STRING(32), primaryKey: true },
  outbound_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  dest_store_id: { type: DataTypes.STRING(32) },
  out_type: { type: DataTypes.STRING(32) },
  source_order_no: { type: DataTypes.STRING(64) },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  create_user: { type: DataTypes.STRING(64) }
}, { tableName: 'T_OUTBOUND', timestamps: false });

// 出库明细
const OutboundItem = sequelize.define('OutboundItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  outbound_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
}, { tableName: 'T_OUTBOUND_ITEM', timestamps: false });

// 调拨单
const Transfer = sequelize.define('Transfer', {
  transfer_id: { type: DataTypes.STRING(32), primaryKey: true },
  transfer_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  from_store_id: { type: DataTypes.STRING(32), allowNull: false },
  to_store_id: { type: DataTypes.STRING(32), allowNull: false },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  apply_user: { type: DataTypes.STRING(64) },
  confirm_user: { type: DataTypes.STRING(64) },
  inbound_confirm_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_TRANSFER', timestamps: false, createdAt: 'create_time', updatedAt: false });

// 调拨明细
const TransferItem = sequelize.define('TransferItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  transfer_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
}, { tableName: 'T_TRANSFER_ITEM', timestamps: false });

// ----------------------------------------
// 财务模型
// ----------------------------------------

// 日结单
const DailyStatement = sequelize.define('DailyStatement', {
  statement_id: { type: DataTypes.STRING(32), primaryKey: true },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  statement_date: { type: DataTypes.DATEONLY, allowNull: false },
  total_revenue: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  total_order_count: { type: DataTypes.INTEGER, defaultValue: 0 },
  total_settled: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '已下账金额' },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending', comment: 'pending/partial/settled' },
  submit_staff: { type: DataTypes.STRING(64) },
  confirm_staff: { type: DataTypes.STRING(64) }
}, { tableName: 'T_DAILY_STATEMENT', timestamps: false });

// 日结单明细（每笔订单的收款情况）
const DailyStatementDetail = sequelize.define('DailyStatementDetail', {
  detail_id: { type: DataTypes.STRING(64), primaryKey: true },
  statement_id: { type: DataTypes.STRING(32), allowNull: false },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  order_no: { type: DataTypes.STRING(64) },
  customer_name: { type: DataTypes.STRING(64) },
  payment_method: { type: DataTypes.STRING(128), comment: '收款方式名称' },
  payment_code: { type: DataTypes.STRING(64), comment: '收款方式编码' },
  amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '收款金额' },
  settlement_account_id: { type: DataTypes.STRING(64), comment: '结算账号ID' },
  settled: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0, comment: '已下账金额' },
  settled_at: { type: DataTypes.DATE, comment: '下账时间' }
}, { tableName: 'T_DAILY_STATEMENT_DETAIL', timestamps: false });

// 支出记录
const Expense = sequelize.define('Expense', {
  expense_id: { type: DataTypes.STRING(32), primaryKey: true },
  expense_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  expense_type: { type: DataTypes.STRING(32), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_method: { type: DataTypes.STRING(64) },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  submit_user: { type: DataTypes.STRING(64) },
  settle_user: { type: DataTypes.STRING(64) },
  settled_payment_method: { type: DataTypes.STRING(64) },
  settlement_account_id: { type: DataTypes.STRING(64) },
  settled_at: { type: DataTypes.DATE },
  related_order_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 },
}, { tableName: 'T_EXPENSE', timestamps: false });

// ----------------------------------------
// 应付管理模型
// ----------------------------------------

// 应付款记录
const Payable = sequelize.define('Payable', {
  payable_id: { type: DataTypes.STRING(32), primaryKey: true },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  request_id: { type: DataTypes.STRING(32), allowNull: false },
  request_no: { type: DataTypes.STRING(64) },
  total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  paid_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'unpaid' },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PAYABLE', timestamps: false });

// 结算单
const Settlement = sequelize.define('Settlement', {
  settlement_id: { type: DataTypes.STRING(32), primaryKey: true },
  settlement_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  status: { type: DataTypes.STRING(32), defaultValue: 'unpaid' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  paid_time: { type: DataTypes.DATE }
}, { tableName: 'T_SETTLEMENT', timestamps: false });

// 结算明细
const SettlementItem = sequelize.define('SettlementItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  settlement_id: { type: DataTypes.STRING(32), allowNull: false },
  payable_id: { type: DataTypes.STRING(32), allowNull: false },
  request_no: { type: DataTypes.STRING(64) },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false }
}, { tableName: 'T_SETTLEMENT_ITEM', timestamps: false });

// ----------------------------------------
// 返利管理模型
// ----------------------------------------

const SupplierRebate = sequelize.define('SupplierRebate', {
  rebate_id: { type: DataTypes.STRING(32), primaryKey: true },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  type: { type: DataTypes.STRING(32), allowNull: false, comment: 'credit-上账, debit-抵扣' },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  balance: { type: DataTypes.DECIMAL(12, 2), allowNull: false, comment: '操作后余额' },
  related_no: { type: DataTypes.STRING(64), comment: '关联单号' },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SUPPLIER_REBATE', timestamps: false });

// -------------------------------------------
// 字典模型
// -------------------------------------------

// 客户来源
const CustomerSource = sequelize.define('CustomerSource', {
  source_id: { type: DataTypes.STRING(64), primaryKey: true },
  parent_id: { type: DataTypes.STRING(64) },
  name: { type: DataTypes.STRING(128), allowNull: false },
  level: { type: DataTypes.INTEGER, defaultValue: 1 },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_DICT_CUSTOMER_SOURCE', timestamps: false });

// 支付方式
const PaymentMethod = sequelize.define('PaymentMethod', {
  method_id: { type: DataTypes.STRING(64), primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false },
  code: { type: DataTypes.STRING(64) },
  icon: { type: DataTypes.STRING(64) },
  settlement_account_id: { type: DataTypes.STRING(64) },
  is_global: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_DICT_PAYMENT_METHOD', timestamps: false });

// 结算账号
const SettlementAccount = sequelize.define('SettlementAccount', {
  account_id: { type: DataTypes.STRING(64), primaryKey: true },
  account_name: { type: DataTypes.STRING(128), allowNull: false, comment: '账号名称' },
  bank_name: { type: DataTypes.STRING(128), comment: '开户行' },
  account_number: { type: DataTypes.STRING(128), comment: '账号' },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 'T_SETTLEMENT_ACCOUNT', timestamps: false });

// 结算账户流水
const SettlementAccountTransaction = sequelize.define('SettlementAccountTransaction', {
  transaction_id: { type: DataTypes.STRING(64), primaryKey: true },
  account_id: { type: DataTypes.STRING(64), allowNull: false },
  type: { type: DataTypes.STRING(32), allowNull: false, comment: 'income-入账/expense-出账' },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  balance_after: { type: DataTypes.DECIMAL(12, 2), comment: '操作后余额' },
  description: { type: DataTypes.STRING(512), comment: '摘要' },
  related_ref: { type: DataTypes.STRING(128), comment: '关联单号' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SETTLEMENT_ACCOUNT_TRANSACTION', timestamps: false });

// 附加服务费
const SupplementItem = sequelize.define('SupplementItem', {
  item_id: { type: DataTypes.STRING(64), primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  is_active: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 }
}, { tableName: 'T_DICT_SUPPLEMENT_ITEM', timestamps: false });

// 收款方式-门店关联（一个门店可以有多个收款方式，一个收款方式可以属于多个门店）
const PaymentMethodStore = sequelize.define('PaymentMethodStore', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  method_id: { type: DataTypes.STRING(64), allowNull: false },
  store_id: { type: DataTypes.STRING(64), allowNull: false },
  settlement_account_id: { type: DataTypes.STRING(64) }
}, { tableName: 'T_DICT_PAYMENT_METHOD_STORE', timestamps: false });

// ----------------------------------------
// 关联关系定义
// ----------------------------------------

// 组织架构关联
Region.hasMany(Distributor, { foreignKey: 'region_id', sourceKey: 'region_id' });
Distributor.belongsTo(Region, { foreignKey: 'region_id', targetKey: 'region_id' });

Distributor.hasMany(Store, { foreignKey: 'distributor_id', sourceKey: 'distributor_id' });
Store.belongsTo(Distributor, { foreignKey: 'distributor_id', targetKey: 'distributor_id' });

Region.hasMany(Store, { foreignKey: 'region_id', sourceKey: 'region_id' });
Store.belongsTo(Region, { foreignKey: 'region_id', targetKey: 'region_id' });

Staff.belongsTo(Distributor, { foreignKey: 'distributor_id', targetKey: 'distributor_id' });
Staff.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id', as: 'Store' });
Staff.belongsTo(Region, { foreignKey: 'region_id', targetKey: 'region_id', as: 'Region' });

// 权限关联
Role.belongsToMany(Menu, { through: RoleMenu, foreignKey: 'role_id', otherKey: 'menu_id' });
Menu.belongsToMany(Role, { through: RoleMenu, foreignKey: 'menu_id', otherKey: 'role_id' });

Staff.belongsToMany(Role, { through: StaffRole, foreignKey: 'staff_id', otherKey: 'role_id', as: 'Roles' });
Role.belongsToMany(Staff, { through: StaffRole, foreignKey: 'role_id', otherKey: 'staff_id' });

Staff.hasMany(RegionPermission, { foreignKey: 'staff_id', sourceKey: 'staff_id', as: 'RegionPermissions' });
RegionPermission.belongsTo(Staff, { foreignKey: 'staff_id', targetKey: 'staff_id', as: 'Staff' });

// 商品关联
Product.hasMany(ProductPn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasMany(ProductSn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductSn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

ProductPn.hasMany(ProductSn, { foreignKey: 'pn_id', sourceKey: 'pn_id' });
ProductSn.belongsTo(ProductPn, { foreignKey: 'pn_id', targetKey: 'pn_id' });

Product.hasMany(ProductBarcode, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductBarcode.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasOne(ProductPrice, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPrice.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

ProductCategory.belongsTo(ProductCategory, { foreignKey: 'parent_id', targetKey: 'category_id', as: 'Parent' });
ProductCategory.hasMany(ProductCategory, { foreignKey: 'parent_id', sourceKey: 'category_id', as: 'Children' });

ProductCategory.hasMany(ProductCategoryField, { foreignKey: 'category_id', sourceKey: 'category_id', as: 'fields' });
ProductCategoryField.belongsTo(ProductCategory, { foreignKey: 'category_id', targetKey: 'category_id' });

// 库房关联
Store.hasMany(Location, { foreignKey: 'store_id', sourceKey: 'store_id' });
Location.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Store.hasMany(ProductSn, { foreignKey: 'store_id', sourceKey: 'store_id' });
ProductSn.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Location.hasMany(ProductSn, { foreignKey: 'location_id', sourceKey: 'location_id' });
ProductSn.belongsTo(Location, { foreignKey: 'location_id', targetKey: 'location_id' });

// 库存聚合关联
Product.hasOne(Inventory, { foreignKey: 'product_id', sourceKey: 'product_id' });
Inventory.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });
Store.hasMany(Inventory, { foreignKey: 'store_id', sourceKey: 'store_id' });
Inventory.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

// 退库关联
Inbound.hasMany(ReturnStock, { foreignKey: 'inbound_id', sourceKey: 'inbound_id' });
ReturnStock.belongsTo(Inbound, { foreignKey: 'inbound_id', targetKey: 'inbound_id' });

Store.hasMany(ReturnStock, { foreignKey: 'store_id', sourceKey: 'store_id' });
ReturnStock.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

// 调拨关联
Transfer.hasMany(TransferItem, { foreignKey: 'transfer_id', sourceKey: 'transfer_id' });
TransferItem.belongsTo(Transfer, { foreignKey: 'transfer_id', targetKey: 'transfer_id' });

Transfer.belongsTo(Store, { foreignKey: 'from_store_id', targetKey: 'store_id', as: 'FromStore' });
Transfer.belongsTo(Store, { foreignKey: 'to_store_id', targetKey: 'store_id', as: 'ToStore' });

ReturnStock.hasMany(ReturnStockItem, { foreignKey: 'return_id', sourceKey: 'return_id', as: 'items' });
ReturnStockItem.belongsTo(ReturnStock, { foreignKey: 'return_id', targetKey: 'return_id' });

// 订单关联
Store.hasMany(Order, { foreignKey: 'store_id', sourceKey: 'store_id' });
Order.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Order.hasMany(OrderItem, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });
Product.hasMany(OrderItem, { foreignKey: 'product_id', sourceKey: 'product_id' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Order.hasMany(OrderPayment, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderPayment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

Order.hasMany(OrderAttachment, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderAttachment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

// 采购关联
Supplier.hasMany(PurchaseRequest, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
PurchaseRequest.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

Store.hasMany(PurchaseRequest, { foreignKey: 'store_id', sourceKey: 'store_id' });
PurchaseRequest.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

PurchaseRequest.hasMany(PurchaseRequestItem, { foreignKey: 'request_id', sourceKey: 'request_id', as: 'items' });
PurchaseRequestItem.belongsTo(PurchaseRequest, { foreignKey: 'request_id', targetKey: 'request_id' });

PurchaseRequest.hasMany(PurchaseRequestItem, { foreignKey: 'request_id', sourceKey: 'request_id' });
PurchaseRequestItem.belongsTo(PurchaseRequest, { foreignKey: 'request_id', targetKey: 'request_id' });

Store.hasMany(PurchaseRequest, { foreignKey: 'store_id', sourceKey: 'store_id' });
PurchaseRequest.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Supplier.hasMany(PurchaseOrder, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
PurchaseOrder.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

PurchaseOrder.hasMany(PurchaseOrderItem, { foreignKey: 'order_id', sourceKey: 'order_id' });
PurchaseOrderItem.belongsTo(PurchaseOrder, { foreignKey: 'order_id', targetKey: 'order_id' });

// 入库关联
Store.hasMany(Inbound, { foreignKey: 'store_id', sourceKey: 'store_id' });
Inbound.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Expense.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
Expense.belongsTo(SettlementAccount, { foreignKey: 'settlement_account_id', targetKey: 'account_id', as: 'SettlementAccount' });

PurchaseRequest.hasMany(Inbound, { foreignKey: 'purchase_request_id', sourceKey: 'request_id' });
Inbound.belongsTo(PurchaseRequest, { foreignKey: 'purchase_request_id', targetKey: 'request_id' });

Inbound.hasMany(InboundItem, { foreignKey: 'inbound_id', sourceKey: 'inbound_id', as: 'items' });
InboundItem.belongsTo(Inbound, { foreignKey: 'inbound_id', targetKey: 'inbound_id' });

// 应付关联
Supplier.hasMany(Payable, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
Payable.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

Supplier.hasMany(Settlement, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
Settlement.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

Settlement.hasMany(SettlementItem, { foreignKey: 'settlement_id', sourceKey: 'settlement_id', as: 'items' });
SettlementItem.belongsTo(Settlement, { foreignKey: 'settlement_id', targetKey: 'settlement_id' });

// 支付方式关联结算账号
SettlementAccount.hasMany(PaymentMethod, { foreignKey: 'settlement_account_id', sourceKey: 'account_id' });
PaymentMethod.belongsTo(SettlementAccount, { foreignKey: 'settlement_account_id', targetKey: 'account_id' });

SettlementAccount.hasMany(SettlementAccountTransaction, { foreignKey: 'account_id', sourceKey: 'account_id' });
SettlementAccountTransaction.belongsTo(SettlementAccount, { foreignKey: 'account_id', targetKey: 'account_id' });

// 收款方式-门店多对多关联
PaymentMethod.belongsToMany(Store, { through: PaymentMethodStore, foreignKey: 'method_id', otherKey: 'store_id', as: 'Stores' });
Store.belongsToMany(PaymentMethod, { through: PaymentMethodStore, foreignKey: 'store_id', otherKey: 'method_id', as: 'PaymentMethods' });
PaymentMethodStore.belongsTo(PaymentMethod, { foreignKey: 'method_id', targetKey: 'method_id' });
PaymentMethodStore.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
PaymentMethodStore.belongsTo(SettlementAccount, { foreignKey: 'settlement_account_id', targetKey: 'account_id' });
PaymentMethod.hasMany(PaymentMethodStore, { foreignKey: 'method_id', sourceKey: 'method_id' });
Store.hasMany(PaymentMethodStore, { foreignKey: 'store_id', sourceKey: 'store_id' });

DailyStatement.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
Store.hasMany(DailyStatement, { foreignKey: 'store_id', sourceKey: 'store_id' });
DailyStatement.hasMany(DailyStatementDetail, { foreignKey: 'statement_id', sourceKey: 'statement_id', as: 'Details' });
DailyStatementDetail.belongsTo(DailyStatement, { foreignKey: 'statement_id', targetKey: 'statement_id' });

module.exports = {
  sequelize,
  Region,
  Distributor,
  Store,
  Staff,
  Menu,
  Role,
  RoleMenu,
  StaffRole,
  RegionPermission,
  Product,
  ProductPn,
  ProductSn,
  ProductBarcode,
  SnLog,
  ProductCategory,
  ProductCategoryField,
  ProductPrice,
  Location,
  InventoryWarning,
  Supplier,
  PurchaseRequest,
  PurchaseRequestItem,
  PurchaseOrder,
  PurchaseOrderItem,
  Order,
  OrderItem,
  OrderPayment,
  OrderAttachment,
  Inbound,
  InboundItem,
  Outbound,
  OutboundItem,
  Transfer,
  TransferItem,
  ReturnStock,
  ReturnStockItem,
  DailyStatement,
  DailyStatementDetail,
  Expense,
  CustomerSource,
  PaymentMethod,
  PaymentMethodStore,
  SupplementItem,
  SettlementAccount,
  SettlementAccountTransaction,
  Payable,
  Settlement,
  SettlementItem,
  SupplierRebate,
  Inventory
};
