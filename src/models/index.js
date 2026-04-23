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
}, { tableName: 't_region', timestamps: false });

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
}, { tableName: 't_distributor', timestamps: false });

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
}, { tableName: 't_store', timestamps: false });

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
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_staff', timestamps: false });

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
}, { tableName: 't_menu', timestamps: false });

// 角色
const Role = sequelize.define('Role', {
  role_id: { type: DataTypes.STRING(32), primaryKey: true },
  role_code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(128), allowNull: false },
  description: { type: DataTypes.STRING(512) },
  is_system: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 't_role', timestamps: false });

// 角色菜单关联
const RoleMenu = sequelize.define('RoleMenu', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true }
}, { tableName: 't_role_menu', timestamps: false });

// 员工角色关联
const StaffRole = sequelize.define('StaffRole', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true }
}, { tableName: 't_staff_role', timestamps: false });

// 区域权限
const RegionPermission = sequelize.define('RegionPermission', {
  id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  staff_id: { type: DataTypes.STRING(32), allowNull: false },
  region_code: { type: DataTypes.STRING(32), allowNull: false },
  can_view: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  can_manage: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_region_permission', timestamps: false });

// ----------------------------------------
// 商品模型
// ----------------------------------------

// 商品主表
const Product = sequelize.define('Product', {
  product_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_code: { type: DataTypes.STRING(32), unique: true, allowNull: false },
  name: { type: DataTypes.STRING(255), allowNull: false },
  category: { type: DataTypes.STRING(64) },
  need_sn: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  need_imei: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  standard_price: { type: DataTypes.DECIMAL(12, 2) },
  cost_price: { type: DataTypes.DECIMAL(12, 2) },
  unit: { type: DataTypes.STRING(16), defaultValue: '台' },
  specs_json: { type: DataTypes.JSON },
  remark: { type: DataTypes.STRING(512) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_product', timestamps: false });

// PN料号
const ProductPn = sequelize.define('ProductPn', {
  pn_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  pn_code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  barcode: { type: DataTypes.STRING(64) },
  is_primary: { type: DataTypes.TINYINT(1), defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_product_pn', timestamps: false });

// SN序列号
const ProductSn = sequelize.define('ProductSn', {
  sn_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  pn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128), unique: true, allowNull: false },
  imei1: { type: DataTypes.STRING(32) },
  imei2: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.STRING(32), defaultValue: 'in_stock' },
  store_id: { type: DataTypes.STRING(32) },
  location_id: { type: DataTypes.STRING(32) },
  inbound_time: { type: DataTypes.DATE },
  inbound_price: { type: DataTypes.DECIMAL(12, 2) },
  batch_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.STRING(255) },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_product_sn', timestamps: false });

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
}, { tableName: 't_location', timestamps: false });

// 库存预警配置
const InventoryWarning = sequelize.define('InventoryWarning', {
  warning_id: { type: DataTypes.STRING(32), primaryKey: true },
  product_id: { type: DataTypes.STRING(32) },
  category: { type: DataTypes.STRING(64) },
  min_stock: { type: DataTypes.INTEGER, defaultValue: 0 },
  aging_days: { type: DataTypes.INTEGER, defaultValue: 90 },
  warning_type: { type: DataTypes.STRING(32) },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 't_inventory_warning', timestamps: false });

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
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_supplier', timestamps: false });

// 采购申请
const PurchaseRequest = sequelize.define('PurchaseRequest', {
  request_id: { type: DataTypes.STRING(32), primaryKey: true },
  request_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  supplier_id: { type: DataTypes.STRING(32) },
  total_amount: { type: DataTypes.DECIMAL(12, 2) },
  reason: { type: DataTypes.TEXT },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  apply_user: { type: DataTypes.STRING(64) },
  approve_user: { type: DataTypes.STRING(64) },
  approve_comment: { type: DataTypes.STRING(512) }
}, { tableName: 't_purchase_request', timestamps: false });

// 采购申请明细
const PurchaseRequestItem = sequelize.define('PurchaseRequestItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  request_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  product_name: { type: DataTypes.STRING(255) },
  pn_code: { type: DataTypes.STRING(64) },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  unit_price: { type: DataTypes.DECIMAL(12, 2) },
  subtotal: { type: DataTypes.DECIMAL(12, 2) }
}, { tableName: 't_purchase_request_item', timestamps: false });

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
}, { tableName: 't_purchase_order', timestamps: false });

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
}, { tableName: 't_purchase_order_item', timestamps: false });

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
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_order', timestamps: false });

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
}, { tableName: 't_order_item', timestamps: false });

// 订单支付记录
const OrderPayment = sequelize.define('OrderPayment', {
  payment_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  payment_method: { type: DataTypes.STRING(64), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_time: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 't_order_payment', timestamps: false });

// 订单附件
const OrderAttachment = sequelize.define('OrderAttachment', {
  attach_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  order_id: { type: DataTypes.STRING(32), allowNull: false },
  attach_type: { type: DataTypes.STRING(64) },
  file_url: { type: DataTypes.STRING(1024), allowNull: false }
}, { tableName: 't_order_attachment', timestamps: false });

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
  total_amount: { type: DataTypes.DECIMAL(12, 2) },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  create_user: { type: DataTypes.STRING(64) }
}, { tableName: 't_inbound', timestamps: false });

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
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
}, { tableName: 't_inbound_item', timestamps: false });

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
}, { tableName: 't_outbound', timestamps: false });

// 出库明细
const OutboundItem = sequelize.define('OutboundItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  outbound_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
}, { tableName: 't_outbound_item', timestamps: false });

// 调拨单
const Transfer = sequelize.define('Transfer', {
  transfer_id: { type: DataTypes.STRING(32), primaryKey: true },
  transfer_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  from_store_id: { type: DataTypes.STRING(32), allowNull: false },
  to_store_id: { type: DataTypes.STRING(32), allowNull: false },
  total_quantity: { type: DataTypes.INTEGER },
  status: { type: DataTypes.STRING(32), defaultValue: 'pending' },
  apply_user: { type: DataTypes.STRING(64) },
  confirm_user: { type: DataTypes.STRING(64) }
}, { tableName: 't_transfer', timestamps: false });

// 调拨明细
const TransferItem = sequelize.define('TransferItem', {
  item_id: { type: DataTypes.BIGINT(20), primaryKey: true, autoIncrement: true },
  transfer_id: { type: DataTypes.STRING(32), allowNull: false },
  product_id: { type: DataTypes.STRING(32), allowNull: false },
  sn_id: { type: DataTypes.STRING(32) },
  sn_code: { type: DataTypes.STRING(128) },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
}, { tableName: 't_transfer_item', timestamps: false });

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
  cash_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  wechat_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  alipay_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  other_amount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  difference: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  status: { type: DataTypes.STRING(32), defaultValue: 'draft' },
  submit_staff: { type: DataTypes.STRING(64) },
  confirm_staff: { type: DataTypes.STRING(64) }
}, { tableName: 't_daily_statement', timestamps: false });

// 支出记录
const Expense = sequelize.define('Expense', {
  expense_id: { type: DataTypes.STRING(32), primaryKey: true },
  expense_no: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  store_id: { type: DataTypes.STRING(32), allowNull: false },
  expense_type: { type: DataTypes.STRING(32), allowNull: false },
  amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  payment_method: { type: DataTypes.STRING(64) },
  related_order_no: { type: DataTypes.STRING(64) },
  remark: { type: DataTypes.STRING(512) },
  create_user: { type: DataTypes.STRING(64) },
  is_deleted: { type: DataTypes.TINYINT(1), defaultValue: 0 }
}, { tableName: 't_expense', timestamps: false });

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
}, { tableName: 't_dict_customer_source', timestamps: false });

// 支付方式
const PaymentMethod = sequelize.define('PaymentMethod', {
  method_id: { type: DataTypes.STRING(64), primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false },
  code: { type: DataTypes.STRING(64), unique: true, allowNull: false },
  icon: { type: DataTypes.STRING(64) },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  status: { type: DataTypes.TINYINT, defaultValue: 1 }
}, { tableName: 't_dict_payment_method', timestamps: false });

// 附加服务费
const SupplementItem = sequelize.define('SupplementItem', {
  item_id: { type: DataTypes.STRING(64), primaryKey: true },
  name: { type: DataTypes.STRING(128), allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  is_active: { type: DataTypes.TINYINT(1), defaultValue: 1 },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 }
}, { tableName: 't_dict_supplement_item', timestamps: false });

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
Staff.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });
Staff.belongsTo(Region, { foreignKey: 'region_id', targetKey: 'region_id' });

// 权限关联
Role.belongsToMany(Menu, { through: RoleMenu, foreignKey: 'role_id', otherKey: 'menu_id' });
Menu.belongsToMany(Role, { through: RoleMenu, foreignKey: 'menu_id', otherKey: 'role_id' });

Staff.belongsToMany(Role, { through: StaffRole, foreignKey: 'staff_id', otherKey: 'role_id' });
Role.belongsToMany(Staff, { through: StaffRole, foreignKey: 'role_id', otherKey: 'staff_id' });

Staff.hasMany(RegionPermission, { foreignKey: 'staff_id', sourceKey: 'staff_id' });
RegionPermission.belongsTo(Staff, { foreignKey: 'staff_id', targetKey: 'staff_id' });

// 商品关联
Product.hasMany(ProductPn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductPn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

Product.hasMany(ProductSn, { foreignKey: 'product_id', sourceKey: 'product_id' });
ProductSn.belongsTo(Product, { foreignKey: 'product_id', targetKey: 'product_id' });

ProductPn.hasMany(ProductSn, { foreignKey: 'pn_id', sourceKey: 'pn_id' });
ProductSn.belongsTo(ProductPn, { foreignKey: 'pn_id', targetKey: 'pn_id' });

// 库房关联
Store.hasMany(Location, { foreignKey: 'store_id', sourceKey: 'store_id' });
Location.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

// 订单关联
Store.hasMany(Order, { foreignKey: 'store_id', sourceKey: 'store_id' });
Order.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Order.hasMany(OrderItem, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

Order.hasMany(OrderPayment, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderPayment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

Order.hasMany(OrderAttachment, { foreignKey: 'order_id', sourceKey: 'order_id' });
OrderAttachment.belongsTo(Order, { foreignKey: 'order_id', targetKey: 'order_id' });

// 采购关联
Supplier.hasMany(PurchaseRequest, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
PurchaseRequest.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

PurchaseRequest.hasMany(PurchaseRequestItem, { foreignKey: 'request_id', sourceKey: 'request_id' });
PurchaseRequestItem.belongsTo(PurchaseRequest, { foreignKey: 'request_id', targetKey: 'request_id' });

Store.hasMany(PurchaseRequest, { foreignKey: 'store_id', sourceKey: 'store_id' });
PurchaseRequest.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'store_id' });

Supplier.hasMany(PurchaseOrder, { foreignKey: 'supplier_id', sourceKey: 'supplier_id' });
PurchaseOrder.belongsTo(Supplier, { foreignKey: 'supplier_id', targetKey: 'supplier_id' });

PurchaseOrder.hasMany(PurchaseOrderItem, { foreignKey: 'order_id', sourceKey: 'order_id' });
PurchaseOrderItem.belongsTo(PurchaseOrder, { foreignKey: 'order_id', targetKey: 'order_id' });

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
  DailyStatement,
  Expense,
  CustomerSource,
  PaymentMethod,
  SupplementItem
};
