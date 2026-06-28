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

// 员工门店权限。门店范围必须精确到门店，不能复用区域权限代替。
const StaffStorePermission = sequelize.define('StaffStorePermission', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  staff_id: { type: DataTypes.BIGINT(20), allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_STAFF_STORE_PERMISSION', timestamps: false });

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
  sn_code: { type: DataTypes.STRING(128), allowNull: false },
  imei1: { type: DataTypes.STRING(32) },
  imei2: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.STRING(32), defaultValue: 'in_stock' },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  store_id: { type: DataTypes.STRING(32) },
  location_id: { type: DataTypes.STRING(32) },
  inbound_time: { type: DataTypes.DATE },
  inbound_price: { type: DataTypes.DECIMAL(12, 2) },
  original_pickup_price: { type: DataTypes.DECIMAL(12, 2) },
  tax_type: { type: DataTypes.STRING(32), defaultValue: 'UNKNOWN', comment: 'TAX_INCLUDED/UNTAXED/UNKNOWN' },
  source_type: { type: DataTypes.STRING(32), defaultValue: 'OTHER', comment: '库存货源性质' },
  batch_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.STRING(255) },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_PRODUCT_SN', timestamps: false });

// SN资源权益当前状态。库存本体与可变权益分离。
const InventoryResourceRight = sequelize.define('InventoryResourceRight', {
  right_id: { type: DataTypes.STRING(32), primaryKey: true },
  sn_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_code: { type: DataTypes.STRING(128), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  resource_type: { type: DataTypes.STRING(32), allowNull: false },
  rule_config_id: { type: DataTypes.STRING(32) },
  source_request_id: { type: DataTypes.STRING(32) },
  source_request_item_id: { type: DataTypes.BIGINT(20) },
  source_inbound_id: { type: DataTypes.STRING(32) },
  supplier_id: { type: DataTypes.STRING(32) },
  supplier_name: { type: DataTypes.STRING(255) },
  initial_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'NOT_APPLICABLE' },
  current_status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'NOT_APPLICABLE' },
  amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  source: { type: DataTypes.STRING(128) },
  locked_source_type: { type: DataTypes.STRING(32) },
  locked_source_id: { type: DataTypes.STRING(32) },
  remark: { type: DataTypes.STRING(512) },
  version: { type: DataTypes.INTEGER, defaultValue: 0 },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_INVENTORY_RESOURCE_RIGHT', timestamps: false });

// 可配置资源类别。代码仅作为内部稳定标识，业务界面展示名称。
const ResourceCategory = sequelize.define('ResourceCategory', {
  category_id: { type: DataTypes.STRING(32), primaryKey: true },
  category_code: { type: DataTypes.STRING(32), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(128), allowNull: false },
  short_name: { type: DataTypes.STRING(64) },
  resource_kind: { type: DataTypes.STRING(32), defaultValue: 'SALE_USE' },
  default_account_id: { type: DataTypes.STRING(64) },
  supports_purchase_select: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  supports_sale_use: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  supports_company_claim: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  trigger_on_sale: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  generates_settlement: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  generates_staff_care_credit: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  affects_performance_profit: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  performance_profit_ratio: { type: DataTypes.DECIMAL(8, 4), defaultValue: 100 },
  rule_config_json: { type: DataTypes.TEXT },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  remark: { type: DataTypes.STRING(512) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_RESOURCE_CATEGORY', timestamps: false });

// 权益变更单兼作不可删除的状态流水；套回申请由财务审批。
const ResourceRightChangeOrder = sequelize.define('ResourceRightChangeOrder', {
  change_id: { type: DataTypes.STRING(32), primaryKey: true },
  change_order_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  sn_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_code: { type: DataTypes.STRING(128), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  resource_type: { type: DataTypes.STRING(32), allowNull: false },
  before_status: { type: DataTypes.STRING(32), allowNull: false },
  after_status: { type: DataTypes.STRING(32), allowNull: false },
  change_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  change_reason: { type: DataTypes.STRING(32), allowNull: false },
  approval_status: { type: DataTypes.STRING(32), defaultValue: 'approved' },
  related_order_id: { type: DataTypes.STRING(32) },
  related_sale_order_id: { type: DataTypes.STRING(32) },
  attachment_url: { type: DataTypes.STRING(1000) },
  applicant_staff_id: { type: DataTypes.BIGINT(20) },
  applicant_name: { type: DataTypes.STRING(64) },
  reviewer_staff_id: { type: DataTypes.BIGINT(20) },
  reviewer_name: { type: DataTypes.STRING(64) },
  review_comment: { type: DataTypes.STRING(512) },
  review_time: { type: DataTypes.DATE },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  remark: { type: DataTypes.STRING(512) }
}, { tableName: 'T_RESOURCE_RIGHT_CHANGE_ORDER', timestamps: false });

// 商品+资源类型成本定义，不参与销售结算成本自动扣减。
const ProductResourceCostConfig = sequelize.define('ProductResourceCostConfig', {
  config_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  resource_type: { type: DataTypes.STRING(32), allowNull: false },
  supplier_id: { type: DataTypes.STRING(32) },
  supplier_name: { type: DataTypes.STRING(255) },
  cost_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  calculation_type: { type: DataTypes.STRING(32), defaultValue: 'fixed_amount' },
  calculation_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },
  effective_start: { type: DataTypes.DATE },
  effective_end: { type: DataTypes.DATE },
  trigger_condition: { type: DataTypes.STRING(64), defaultValue: 'sale_archived' },
  affects_performance_profit: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  performance_profit_ratio: { type: DataTypes.DECIMAL(8, 4), defaultValue: 100 },
  rule_config_json: { type: DataTypes.TEXT },
  status: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_user: { type: DataTypes.STRING(64) },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PRODUCT_RESOURCE_COST_CONFIG', timestamps: false });

// 产品资源成本流水，与厂家政策及销售结算成本流水隔离。
const InventoryResourceCostAdjustment = sequelize.define('InventoryResourceCostAdjustment', {
  adjustment_id: { type: DataTypes.STRING(32), primaryKey: true },
  sn_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_code: { type: DataTypes.STRING(128), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  resource_type: { type: DataTypes.STRING(32), allowNull: false },
  adjustment_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  before_product_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  after_product_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  source_type: { type: DataTypes.STRING(32), allowNull: false },
  source_id: { type: DataTypes.STRING(32), allowNull: false },
  affect_sales_settlement_cost: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  operator_id: { type: DataTypes.BIGINT(20) },
  operator_name: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  remark: { type: DataTypes.STRING(512) }
}, { tableName: 'T_INVENTORY_RESOURCE_COST_ADJUSTMENT', timestamps: false });

// 权益使用/套回后形成的待下账记录；下账后才进入真实资金或受限额度账户。
const ResourceSettlement = sequelize.define('ResourceSettlement', {
  settlement_id: { type: DataTypes.STRING(32), primaryKey: true },
  settlement_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  source_type: { type: DataTypes.STRING(32), allowNull: false },
  source_id: { type: DataTypes.STRING(64), allowNull: false },
  batch_no: { type: DataTypes.STRING(64) },
  sn_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_code: { type: DataTypes.STRING(128), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  resource_type: { type: DataTypes.STRING(32), allowNull: false },
  counterparty_id: { type: DataTypes.STRING(32) },
  counterparty_name: { type: DataTypes.STRING(255) },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  status: { type: DataTypes.STRING(32), defaultValue: 'PENDING' },
  target_account_id: { type: DataTypes.STRING(64) },
  settled_at: { type: DataTypes.DATE },
  settled_by: { type: DataTypes.BIGINT(20) },
  settled_by_name: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  remark: { type: DataTypes.STRING(512) }
}, { tableName: 'T_RESOURCE_SETTLEMENT', timestamps: false });

// 销售个人 Care 可用金流水。该额度归属销售个人，不归属客户。
const StaffCareCreditTransaction = sequelize.define('StaffCareCreditTransaction', {
  transaction_id: { type: DataTypes.STRING(32), primaryKey: true },
  staff_id: { type: DataTypes.BIGINT(20) },
  staff_name: { type: DataTypes.STRING(64), allowNull: false },
  type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'income' },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  balance_after: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  source_type: { type: DataTypes.STRING(32), allowNull: false },
  source_id: { type: DataTypes.STRING(64), allowNull: false },
  order_id: { type: DataTypes.STRING(32) },
  order_no: { type: DataTypes.STRING(64) },
  order_item_id: { type: DataTypes.BIGINT(20) },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  product_id: { type: DataTypes.STRING(32) },
  resource_type: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.STRING(32), defaultValue: 'active' },
  remark: { type: DataTypes.STRING(512) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_STAFF_CARE_CREDIT_TRANSACTION', timestamps: false });

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

// 新建商品申请（审批通过后才写入正式商品主表）
const ProductApplication = sequelize.define('ProductApplication', {
  application_id: { type: DataTypes.STRING(32), primaryKey: true },
  application_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  product_name: { type: DataTypes.STRING(255), allowNull: false },
  category_id: { type: DataTypes.STRING(32) },
  category_name: { type: DataTypes.STRING(512) },
  payload_json: { type: DataTypes.JSON, allowNull: false },
  applicant_staff_id: { type: DataTypes.BIGINT(20), allowNull: false },
  applicant_name: { type: DataTypes.STRING(64), allowNull: false },
  distributor_id: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  review_staff_id: { type: DataTypes.BIGINT(20) },
  review_user_name: { type: DataTypes.STRING(64) },
  review_comment: { type: DataTypes.STRING(512) },
  review_time: { type: DataTypes.DATE },
  product_id: { type: DataTypes.STRING(32) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PRODUCT_APPLICATION', timestamps: false });

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

const ProductPriceImportBatch = sequelize.define('ProductPriceImportBatch', {
  batch_id: { type: DataTypes.STRING(32), primaryKey: true },
  batch_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  source_file_name: { type: DataTypes.STRING(255) },
  total_rows: { type: DataTypes.INTEGER, defaultValue: 0 },
  total_products: { type: DataTypes.INTEGER, defaultValue: 0 },
  total_changes: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'effective' },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PRODUCT_PRICE_IMPORT_BATCH', timestamps: false });

const ProductPriceChangeLog = sequelize.define('ProductPriceChangeLog', {
  change_id: { type: DataTypes.STRING(32), primaryKey: true },
  batch_id: { type: DataTypes.STRING(32) },
  batch_no: { type: DataTypes.STRING(64) },
  row_no: { type: DataTypes.INTEGER },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_code: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  manufacturer_code: { type: DataTypes.STRING(128) },
  price_field: { type: DataTypes.STRING(32), allowNull: false },
  old_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  new_price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  effective_time: { type: DataTypes.DATE, allowNull: false },
  source: { type: DataTypes.STRING(32), defaultValue: 'import' },
  change_reason: { type: DataTypes.STRING(512) },
  remark: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  applied_time: { type: DataTypes.DATE },
  fail_reason: { type: DataTypes.STRING(512) }
}, { tableName: 'T_PRODUCT_PRICE_CHANGE_LOG', timestamps: false });

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
  purchase_request_id: { type: DataTypes.STRING(32) },
  supplier_id: { type: DataTypes.STRING(32) },
  supplier_name: { type: DataTypes.STRING(255) },
  total_quantity: { type: DataTypes.INTEGER, defaultValue: 0 },
  total_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  reason: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  approve_user: { type: DataTypes.STRING(64) },
  approve_comment: { type: DataTypes.STRING(512) },
  approve_time: { type: DataTypes.DATE },
  execute_user: { type: DataTypes.STRING(64) },
  execute_time: { type: DataTypes.DATE },
  payable_id: { type: DataTypes.STRING(32) },
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
  location_id: { type: DataTypes.STRING(32) },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  product_type: { type: DataTypes.STRING(32) },
  remark: { type: DataTypes.STRING(255) }
}, { tableName: 'T_RETURN_STOCK_ITEM', timestamps: false });

// 库存聚合
const Inventory = sequelize.define('Inventory', {
  inventory_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
  location_id: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
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
  remark: { type: DataTypes.STRING(512) },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SUPPLIER', timestamps: false });

const SupplierPaymentAccount = sequelize.define('SupplierPaymentAccount', {
  account_id: { type: DataTypes.STRING(32), primaryKey: true },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  company_name: { type: DataTypes.STRING(255) },
  tax_no: { type: DataTypes.STRING(64) },
  bank_name: { type: DataTypes.STRING(128) },
  account_number: { type: DataTypes.STRING(128) },
  remark: { type: DataTypes.STRING(512) },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SUPPLIER_PAYMENT_ACCOUNT', timestamps: false });

// 厂家返利政策。厂家按现有供应商管理，不单独造厂家主数据。
const ManufacturerRebatePolicy = sequelize.define('ManufacturerRebatePolicy', {
  policy_id: { type: DataTypes.STRING(32), primaryKey: true },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  policy_name: { type: DataTypes.STRING(128), allowNull: false },
  policy_type: { type: DataTypes.STRING(32), defaultValue: 'activity' },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  pn: { type: DataTypes.STRING(64) },
  model: { type: DataTypes.STRING(128) },
  start_date: { type: DataTypes.DATE },
  end_date: { type: DataTypes.DATE },
  rebate_calculation_type: { type: DataTypes.STRING(32), defaultValue: 'fixed_amount' },
  rebate_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  rebate_rate: { type: DataTypes.DECIMAL(8, 4), defaultValue: 0 },
  affect_sales_settlement_cost: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  cost_adjustment_type: { type: DataTypes.STRING(32), defaultValue: 'fixed_amount' },
  cost_adjustment_value: { type: DataTypes.DECIMAL(12, 4), defaultValue: 0 },
  max_cost_adjustment_amount: { type: DataTypes.DECIMAL(12, 2) },
  cost_adjustment_remark: { type: DataTypes.STRING(512) },
  remark: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_user: { type: DataTypes.STRING(64) },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_MANUFACTURER_REBATE_POLICY', timestamps: false });

// 厂家价格历史。厂家按现有供应商管理。
const ManufacturerPriceHistory = sequelize.define('ManufacturerPriceHistory', {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  supplier_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  pn: { type: DataTypes.STRING(64), allowNull: false },
  model: { type: DataTypes.STRING(128) },
  effective_date: { type: DataTypes.DATE, allowNull: false },
  expire_date: { type: DataTypes.DATE },
  pickup_price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  p0_price: { type: DataTypes.DECIMAL(12, 2) },
  import_batch_no: { type: DataTypes.STRING(64) },
  source_file_url: { type: DataTypes.STRING(512) },
  remark: { type: DataTypes.STRING(512) },
  created_by: { type: DataTypes.STRING(64) },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_by: { type: DataTypes.STRING(64) },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_MANUFACTURER_PRICE_HISTORY', timestamps: false });

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
  rebate_deduction: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  product_type: { type: DataTypes.STRING(32), comment: '货型：正规货/国补货/纯二批' },
  store_allocations: { type: DataTypes.TEXT },
  selected_resource_types: { type: DataTypes.TEXT }
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
  create_staff_id: { type: DataTypes.BIGINT(20) },
  create_user: { type: DataTypes.STRING(64) },
  customer_name: { type: DataTypes.STRING(64) },
  customer_phone: { type: DataTypes.STRING(32) },
  customer_source: { type: DataTypes.STRING(64) },
  total_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  discount_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  national_subsidy: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  education_subsidy: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  deposit_deduction_total: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  deposit_items: { type: DataTypes.JSON },
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
  subtotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  original_inventory_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  original_pickup_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  current_pickup_price_at_sale: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  p0_difference_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  cost_adjustment_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  sales_settlement_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  sales_gross_profit: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  use_gov_subsidy: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  use_edu_subsidy: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  use_sales_report: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  selected_resource_types: { type: DataTypes.TEXT }
}, { tableName: 'T_ORDER_ITEM', timestamps: false });

// 订单支付记录
const OrderPayment = sequelize.define('OrderPayment', {
  payment_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  payment_method: { type: DataTypes.STRING(64), allowNull: false },
  deposit_id: { type: DataTypes.STRING(32) },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_ORDER_PAYMENT', timestamps: false });

// 定金单
const DepositOrder = sequelize.define('DepositOrder', {
  deposit_id: { type: DataTypes.STRING(32), primaryKey: true },
  deposit_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  customer_name: { type: DataTypes.STRING(64) },
  customer_phone: { type: DataTypes.STRING(32) },
  customer_source: { type: DataTypes.STRING(64) },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  redeemed_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  refunded_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'available' },
  related_order_id: { type: DataTypes.STRING(32) },
  related_order_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.TEXT },
  create_staff_id: { type: DataTypes.BIGINT(20) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  archive_user: { type: DataTypes.STRING(64) },
  archive_time: { type: DataTypes.DATE },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 'T_DEPOSIT_ORDER', timestamps: false });

// 定金退款记录。当前不处理资金账户，只记录业务事实。
const DepositRefund = sequelize.define('DepositRefund', {
  refund_id: { type: DataTypes.STRING(32), primaryKey: true },
  refund_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  deposit_id: { type: DataTypes.STRING(32), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  reason: { type: DataTypes.STRING(512) },
  create_staff_id: { type: DataTypes.BIGINT(20) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_DEPOSIT_REFUND', timestamps: false });

// 定金核销记录
const DepositRedemption = sequelize.define('DepositRedemption', {
  redemption_id: { type: DataTypes.STRING(32), primaryKey: true },
  deposit_id: { type: DataTypes.STRING(32), allowNull: false },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  order_no: { type: DataTypes.STRING(64) },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  status: { type: DataTypes.STRING(32), defaultValue: 'active' },
  void_reason: { type: DataTypes.STRING(512) },
  void_time: { type: DataTypes.DATE },
  create_staff_id: { type: DataTypes.BIGINT(20) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_DEPOSIT_REDEMPTION', timestamps: false });

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
  original_pickup_price: { type: DataTypes.DECIMAL(12, 2) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  remark: { type: DataTypes.STRING(512) },
  location_id: { type: DataTypes.STRING(32) },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  product_type: { type: DataTypes.STRING(32), comment: '货型：正规货/国补货/纯二批' },
  store_allocations: { type: DataTypes.TEXT },
  selected_resource_types: { type: DataTypes.TEXT },
  purchase_request_item_id: { type: DataTypes.BIGINT(20) }
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

// 库存转换单（拆分/组装）
const InventoryConversion = sequelize.define('InventoryConversion', {
  conversion_id: { type: DataTypes.STRING(32), primaryKey: true },
  conversion_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  conversion_type: { type: DataTypes.STRING(32), allowNull: false, comment: 'split/assemble' },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  status: { type: DataTypes.STRING(32), defaultValue: 'completed', comment: 'completed/voided' },
  total_source_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  total_target_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  service_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  remark: { type: DataTypes.STRING(512) },
  void_reason: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  void_user: { type: DataTypes.STRING(64) },
  void_time: { type: DataTypes.DATE }
}, { tableName: 'T_INVENTORY_CONVERSION', timestamps: false });

// 库存转换明细
const InventoryConversionItem = sequelize.define('InventoryConversionItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  conversion_id: { type: DataTypes.STRING(32), allowNull: false },
  line_role: { type: DataTypes.STRING(32), allowNull: false, comment: 'source/target/service' },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  source_sn_id: { type: DataTypes.STRING(32) },
  source_sn_code: { type: DataTypes.STRING(128) },
  quantity: { type: DataTypes.INTEGER, defaultValue: 1 },
  unit_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  total_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  inventory_type: { type: DataTypes.STRING(32), defaultValue: 'normal_qty' },
  location_id: { type: DataTypes.STRING(32) },
  remark: { type: DataTypes.STRING(512) }
}, { tableName: 'T_INVENTORY_CONVERSION_ITEM', timestamps: false });

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
  supplier_account_id: { type: DataTypes.STRING(32) },
  supplier_account_snapshot: { type: DataTypes.TEXT },
  other_payment_remark: { type: DataTypes.TEXT },
  other_payment_image: { type: DataTypes.TEXT('long') },
  total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  paid_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'draft' },
  payment_status: { type: DataTypes.STRING(32), defaultValue: 'unpaid' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  confirmed_time: { type: DataTypes.DATE },
  voided_time: { type: DataTypes.DATE },
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

// 应付付款批次
const SettlementPaymentBatch = sequelize.define('SettlementPaymentBatch', {
  batch_id: { type: DataTypes.STRING(32), primaryKey: true },
  batch_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  account_id: { type: DataTypes.STRING(64), allowNull: false },
  account_name: { type: DataTypes.STRING(128) },
  total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  total_count: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'active' },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  void_user: { type: DataTypes.STRING(64) },
  void_time: { type: DataTypes.DATE },
  void_reason: { type: DataTypes.STRING(512) }
}, { tableName: 'T_SETTLEMENT_PAYMENT_BATCH', timestamps: false });

// 应付付款记录
const SettlementPaymentRecord = sequelize.define('SettlementPaymentRecord', {
  payment_id: { type: DataTypes.STRING(32), primaryKey: true },
  batch_id: { type: DataTypes.STRING(32), allowNull: false },
  settlement_id: { type: DataTypes.STRING(32), allowNull: false },
  settlement_no: { type: DataTypes.STRING(64), allowNull: false },
  supplier_name: { type: DataTypes.STRING(255) },
  account_id: { type: DataTypes.STRING(64), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_time: { type: DataTypes.DATE },
  remark: { type: DataTypes.STRING(512) },
  import_key: { type: DataTypes.STRING(128) },
  transaction_id: { type: DataTypes.STRING(64) },
  status: { type: DataTypes.STRING(32), defaultValue: 'active' },
  create_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  void_transaction_id: { type: DataTypes.STRING(64) }
}, { tableName: 'T_SETTLEMENT_PAYMENT_RECORD', timestamps: false });

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

// 厂家返利预估记录，用于后台对账，不直接等同销售奖励。
const RebateEstimate = sequelize.define('RebateEstimate', {
  estimate_id: { type: DataTypes.STRING(32), primaryKey: true },
  sales_order_id: { type: DataTypes.STRING(32), allowNull: false },
  sales_order_no: { type: DataTypes.STRING(64) },
  sales_order_item_id: { type: DataTypes.BIGINT(20) },
  supplier_id: { type: DataTypes.STRING(32) },
  supplier_name: { type: DataTypes.STRING(255) },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  pn: { type: DataTypes.STRING(64) },
  sn: { type: DataTypes.STRING(128) },
  policy_id: { type: DataTypes.STRING(32) },
  policy_name: { type: DataTypes.STRING(128) },
  policy_type: { type: DataTypes.STRING(32) },
  rebate_estimate_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'estimated' },
  remark: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.STRING(32), defaultValue: 'active' },
  source_type: { type: DataTypes.STRING(32), defaultValue: 'manual' },
  source_id: { type: DataTypes.STRING(64) },
  reversal_of: { type: DataTypes.STRING(32) },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_REBATE_ESTIMATE', timestamps: false });

// 销售结算成本调整明细，用于销售毛利和提成结算口径。
const SalesSettlementCostAdjustment = sequelize.define('SalesSettlementCostAdjustment', {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  sales_order_id: { type: DataTypes.STRING(32), allowNull: false },
  sales_order_no: { type: DataTypes.STRING(64) },
  sales_order_item_id: { type: DataTypes.BIGINT(20) },
  supplier_id: { type: DataTypes.STRING(32) },
  supplier_name: { type: DataTypes.STRING(255) },
  product_id: { type: DataTypes.STRING(32) },
  product_name: { type: DataTypes.STRING(255) },
  pn: { type: DataTypes.STRING(64) },
  sn: { type: DataTypes.STRING(128) },
  original_inventory_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  original_pickup_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  current_pickup_price_at_sale: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  policy_id: { type: DataTypes.STRING(32) },
  policy_name: { type: DataTypes.STRING(128) },
  policy_type: { type: DataTypes.STRING(32) },
  rebate_estimate_id: { type: DataTypes.STRING(32) },
  rebate_estimate_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  affect_sales_settlement_cost: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  cost_adjustment_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  final_sales_settlement_cost: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  remark: { type: DataTypes.STRING(512) },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_SALES_SETTLEMENT_COST_ADJUSTMENT', timestamps: false });

// 员工业绩毛利调整申请，不改写订单原始毛利。
const PerformanceProfitAdjustment = sequelize.define('PerformanceProfitAdjustment', {
  adjustment_id: { type: DataTypes.STRING(32), primaryKey: true },
  adjustment_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  order_no: { type: DataTypes.STRING(64), allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  employee_name: { type: DataTypes.STRING(64) },
  adjustment_type: { type: DataTypes.STRING(16), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  signed_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  base_gross_profit: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  reason: { type: DataTypes.STRING(1000), allowNull: false },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending_finance' },
  applicant_staff_id: { type: DataTypes.BIGINT(20), allowNull: false },
  applicant_name: { type: DataTypes.STRING(64), allowNull: false },
  finance_reviewer_id: { type: DataTypes.BIGINT(20) },
  finance_reviewer_name: { type: DataTypes.STRING(64) },
  finance_review_comment: { type: DataTypes.STRING(512) },
  finance_review_time: { type: DataTypes.DATE },
  admin_reviewer_id: { type: DataTypes.BIGINT(20) },
  admin_reviewer_name: { type: DataTypes.STRING(64) },
  admin_review_comment: { type: DataTypes.STRING(512) },
  admin_review_time: { type: DataTypes.DATE },
  reject_stage: { type: DataTypes.STRING(32) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  update_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PERFORMANCE_PROFIT_ADJUSTMENT', timestamps: false });

const PerformanceProfitAdjustmentAttachment = sequelize.define('PerformanceProfitAdjustmentAttachment', {
  attachment_id: { type: DataTypes.STRING(32), primaryKey: true },
  adjustment_id: { type: DataTypes.STRING(32), allowNull: false },
  original_name: { type: DataTypes.STRING(255), allowNull: false },
  storage_name: { type: DataTypes.STRING(255), allowNull: false },
  mime_type: { type: DataTypes.STRING(128) },
  file_size: { type: DataTypes.BIGINT(20), defaultValue: 0 },
  file_path: { type: DataTypes.STRING(1024), allowNull: false },
  upload_staff_id: { type: DataTypes.BIGINT(20), allowNull: false },
  upload_user: { type: DataTypes.STRING(64) },
  create_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'T_PERFORMANCE_PROFIT_ADJUSTMENT_ATTACHMENT', timestamps: false });

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
  account_type: { type: DataTypes.STRING(32), defaultValue: 'FUND', comment: 'FUND/SUPPLIER_REBATE/CARE_CREDIT' },
  supplier_id: { type: DataTypes.STRING(32) },
  usage_note: { type: DataTypes.STRING(512) },
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

Staff.belongsToMany(Store, { through: StaffStorePermission, foreignKey: 'staff_id', otherKey: 'store_id', as: 'AssignedStores' });
Store.belongsToMany(Staff, { through: StaffStorePermission, foreignKey: 'store_id', otherKey: 'staff_id', as: 'AssignedStaff' });
StaffStorePermission.belongsTo(Staff, { foreignKey: 'staff_id', targetKey: 'staff_id' });
StaffStorePermission.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Staff.hasMany(RegionPermission, { foreignKey: 'staff_id', sourceKey: 'staff_id', as: 'RegionPermissions' });
RegionPermission.belongsTo(Staff, { foreignKey: 'staff_id', targetKey: 'staff_id', as: 'Staff' });

// 商品关联
Product.hasMany(ProductPn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasMany(ProductSn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductSn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

ProductPn.hasMany(ProductSn, { foreignKey: 'pn_id', sourceKey: 'pn_id' });
ProductSn.belongsTo(ProductPn, { foreignKey: 'pn_id', targetKey: 'pn_id' });

ProductSn.hasMany(InventoryResourceRight, { foreignKey: 'sn_id', sourceKey: 'sn_id', as: 'resourceRights' });
InventoryResourceRight.belongsTo(ProductSn, { foreignKey: 'sn_id', targetKey: 'sn_id' });
Product.hasMany(InventoryResourceRight, { foreignKey: 'product_id', sourceKey: 'product_id' });
InventoryResourceRight.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });
Product.hasMany(ProductResourceCostConfig, { foreignKey: 'product_id', sourceKey: 'product_id', as: 'resourceCostConfigs' });
ProductResourceCostConfig.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });
ResourceRightChangeOrder.belongsTo(ProductSn, { foreignKey: 'sn_id', targetKey: 'sn_id' });
InventoryResourceCostAdjustment.belongsTo(ProductSn, { foreignKey: 'sn_id', targetKey: 'sn_id' });
ResourceCategory.belongsTo(SettlementAccount, { foreignKey: 'default_account_id', targetKey: 'account_id', as: 'DefaultAccount' });
ResourceSettlement.belongsTo(ResourceCategory, { foreignKey: 'resource_type', targetKey: 'category_code', as: 'ResourceCategory' });
ResourceSettlement.belongsTo(SettlementAccount, { foreignKey: 'target_account_id', targetKey: 'account_id', as: 'TargetAccount' });
StaffCareCreditTransaction.belongsTo(Staff, { foreignKey: 'staff_id', targetKey: 'staff_id' });

Product.hasMany(ProductBarcode, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductBarcode.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasOne(ProductPrice, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPrice.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasMany(ProductPriceChangeLog, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPriceChangeLog.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });
ProductPriceImportBatch.hasMany(ProductPriceChangeLog, { foreignKey: 'batch_id', sourceKey: 'batch_id', as: 'changes' });
ProductPriceChangeLog.belongsTo(ProductPriceImportBatch, { foreignKey: 'batch_id', targetKey: 'batch_id' });

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

Product.hasMany(TransferItem, { foreignKey: 'product_id', sourceKey: 'product_id' });
TransferItem.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Transfer.belongsTo(Store, { foreignKey: 'from_store_id', targetKey: 'store_id', as: 'FromStore' });
Transfer.belongsTo(Store, { foreignKey: 'to_store_id', targetKey: 'store_id', as: 'ToStore' });

ReturnStock.hasMany(ReturnStockItem, { foreignKey: 'return_id', sourceKey: 'return_id', as: 'items' });
ReturnStockItem.belongsTo(ReturnStock, { foreignKey: 'return_id', targetKey: 'return_id' });

InventoryConversion.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
Store.hasMany(InventoryConversion, { foreignKey: 'store_id', sourceKey: 'store_id' });
InventoryConversion.hasMany(InventoryConversionItem, { foreignKey: 'conversion_id', sourceKey: 'conversion_id', as: 'items' });
InventoryConversionItem.belongsTo(InventoryConversion, { foreignKey: 'conversion_id', targetKey: 'conversion_id' });
Product.hasMany(InventoryConversionItem, { foreignKey: 'product_id', sourceKey: 'product_id' });
InventoryConversionItem.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

// 订单关联
Store.hasMany(Order, { foreignKey: 'store_id', sourceKey: 'store_id' });
Order.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Order.hasMany(OrderItem, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });
Order.hasMany(RebateEstimate, { foreignKey: 'sales_order_id', sourceKey: 'order_id', as: 'rebateEstimates' });
RebateEstimate.belongsTo(Order, { foreignKey: 'sales_order_id', targetKey: 'order_id' });
Order.hasMany(SalesSettlementCostAdjustment, { foreignKey: 'sales_order_id', sourceKey: 'order_id', as: 'costAdjustments' });
SalesSettlementCostAdjustment.belongsTo(Order, { foreignKey: 'sales_order_id', targetKey: 'order_id' });
OrderItem.hasMany(SalesSettlementCostAdjustment, { foreignKey: 'sales_order_item_id', sourceKey: 'item_id', as: 'costAdjustments' });
SalesSettlementCostAdjustment.belongsTo(OrderItem, { foreignKey: 'sales_order_item_id', targetKey: 'item_id' });
Order.hasMany(PerformanceProfitAdjustment, { foreignKey: 'order_id', sourceKey: 'order_id', as: 'performanceProfitAdjustments' });
PerformanceProfitAdjustment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });
PerformanceProfitAdjustment.hasMany(PerformanceProfitAdjustmentAttachment, { foreignKey: 'adjustment_id', sourceKey: 'adjustment_id', as: 'attachments' });
PerformanceProfitAdjustmentAttachment.belongsTo(PerformanceProfitAdjustment, { foreignKey: 'adjustment_id', targetKey: 'adjustment_id' });
Product.hasMany(OrderItem, { foreignKey: 'product_id', sourceKey: 'product_id' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Order.hasMany(OrderPayment, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderPayment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });
OrderPayment.belongsTo(DepositOrder, { foreignKey: 'deposit_id', targetKey: 'deposit_id' });
DepositOrder.hasMany(OrderPayment, { foreignKey: 'deposit_id', sourceKey: 'deposit_id' });
DepositOrder.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
Store.hasMany(DepositOrder, { foreignKey: 'store_id', sourceKey: 'store_id' });
DepositOrder.hasMany(DepositRefund, { foreignKey: 'deposit_id', sourceKey: 'deposit_id', as: 'refunds' });
DepositRefund.belongsTo(DepositOrder, { foreignKey: 'deposit_id', targetKey: 'deposit_id' });
DepositOrder.hasMany(DepositRedemption, { foreignKey: 'deposit_id', sourceKey: 'deposit_id', as: 'redemptions' });
DepositRedemption.belongsTo(DepositOrder, { foreignKey: 'deposit_id', targetKey: 'deposit_id' });
Order.hasMany(DepositRedemption, { foreignKey: 'order_id', sourceKey: 'order_id', as: 'depositRedemptions' });
DepositRedemption.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

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

Supplier.hasMany(SupplierPaymentAccount, { foreignKey: 'supplier_id', sourceKey: 'supplier_id', as: 'paymentAccounts' });
SupplierPaymentAccount.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });
Supplier.hasMany(ManufacturerRebatePolicy, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
ManufacturerRebatePolicy.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });
Supplier.hasMany(ManufacturerPriceHistory, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
ManufacturerPriceHistory.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

Supplier.hasMany(Settlement, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
Settlement.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

Settlement.hasMany(SettlementItem, { foreignKey: 'settlement_id', sourceKey: 'settlement_id', as: 'items' });
SettlementItem.belongsTo(Settlement, { foreignKey: 'settlement_id', targetKey: 'settlement_id' });

Settlement.hasMany(SettlementPaymentRecord, { foreignKey: 'settlement_id', sourceKey: 'settlement_id', as: 'payments' });
SettlementPaymentRecord.belongsTo(Settlement, { foreignKey: 'settlement_id', targetKey: 'settlement_id' });
SettlementPaymentBatch.hasMany(SettlementPaymentRecord, { foreignKey: 'batch_id', sourceKey: 'batch_id', as: 'records' });
SettlementPaymentRecord.belongsTo(SettlementPaymentBatch, { foreignKey: 'batch_id', targetKey: 'batch_id' });
SettlementAccount.hasMany(SettlementPaymentBatch, { foreignKey: 'account_id', sourceKey: 'account_id' });
SettlementPaymentBatch.belongsTo(SettlementAccount, { foreignKey: 'account_id', targetKey: 'account_id' });

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
  StaffStorePermission,
  RegionPermission,
  Product,
  ProductPn,
  ProductSn,
  ResourceCategory,
  InventoryResourceRight,
  ResourceRightChangeOrder,
  ProductResourceCostConfig,
  InventoryResourceCostAdjustment,
  ResourceSettlement,
  StaffCareCreditTransaction,
  ProductBarcode,
  SnLog,
  ProductCategory,
  ProductCategoryField,
  ProductApplication,
  ProductPrice,
  ProductPriceImportBatch,
  ProductPriceChangeLog,
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
  DepositOrder,
  DepositRefund,
  DepositRedemption,
  OrderAttachment,
  Inbound,
  InboundItem,
  Outbound,
  OutboundItem,
  Transfer,
  TransferItem,
  InventoryConversion,
  InventoryConversionItem,
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
  SupplierPaymentAccount,
  ManufacturerRebatePolicy,
  ManufacturerPriceHistory,
  Settlement,
  SettlementItem,
  SettlementPaymentBatch,
  SettlementPaymentRecord,
  SupplierRebate,
  RebateEstimate,
  SalesSettlementCostAdjustment,
  PerformanceProfitAdjustment,
  PerformanceProfitAdjustmentAttachment,
  Inventory
};
