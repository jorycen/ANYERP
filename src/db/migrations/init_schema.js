const db = require('../DatabasePool');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  console.log('--- 开始初始化数据库表结构 ---');

  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    // =============== 商品与库存模块 ===============

    // T_PRODUCT: 产品字典表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_PRODUCT\` (
        \`PRODUCT_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY COMMENT '产品自增ID',
        \`PN_CODE\` varchar(64) NOT NULL COMMENT '产品料号 (PN)',
        \`BARCODE\` varchar(64) COMMENT '69码/条形码 (EAN-13等)',
        \`CATEGORY\` varchar(64) COMMENT '产品类别 (如: 笔记本, 台式机, 打印机, 选件)',
        \`PRODUCT_GROUP\` varchar(64) COMMENT '产品组别 (如: 拯救者, 小新, 昭阳, ThinkPad)',
        \`NAME\` varchar(255) NOT NULL COMMENT '产品名称 (如: 联想小新鲸鱼彩色喷墨多功能打印机)',
        \`SPECS_JSON\` json COMMENT '详细配置/规格参数 (存放CPU/内存/硬盘/显卡等独立字段)',
        \`STANDARD_PRICE\` decimal(10,2) COMMENT '标准售价',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        \`IS_DELETED\` bit(1) DEFAULT b'0' COMMENT '软删除标记',
        UNIQUE KEY \`uni_inx_pn_code\` (\`PN_CODE\`),
        KEY \`idx_product_barcode\` (\`BARCODE\`),
        KEY \`idx_product_category\` (\`CATEGORY\`),
        KEY \`idx_product_name\` (\`NAME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='标准产品字典表';
    `);

    // T_INVENTORY_LOCATION: 库位/仓库类型表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_INVENTORY_LOCATION\` (
        \`LOCATION_ID\` varchar(32) PRIMARY KEY COMMENT '库位ID',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '归属门店ID',
        \`NAME\` varchar(64) NOT NULL COMMENT '库位名称 (如: 销售库, 样品库, 铺货库, 破损库/坏机库)',
        \`IS_SELLABLE\` bit(1) DEFAULT b'1' COMMENT '该库位下的商品是否允许直接销售 (1-是, 0-否)',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-启用, 0-停用',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY \`idx_location_store\` (\`STORE_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店库位结构表';
    `);

    // T_INVENTORY_SN: 库存序列号表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_INVENTORY_SN\` (
        \`INVENTORY_ID\` varchar(32) PRIMARY KEY COMMENT '库存主键ID (原 _id)',
        \`PRODUCT_ID\` bigint(20) NOT NULL COMMENT '关联产品字典ID',
        \`SN_CODE\` varchar(128) NOT NULL COMMENT '商品序列号 (SN)',
        \`STORE_ID\` varchar(32) COMMENT '当前所属门店ID',
        \`LOCATION_ID\` varchar(32) COMMENT '当前所在库位ID (关联 T_INVENTORY_LOCATION)',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '库存状态: 1-在库, 2-已销售, 3-调拨中, 4-返修',
        \`IMPORT_PRICE\` decimal(10,2) COMMENT '实际入库价格',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '系统入库时间',
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        UNIQUE KEY \`uni_inx_sn_code\` (\`SN_CODE\`),
        KEY \`idx_store_status\` (\`STORE_ID\`, \`STATUS\`),
        KEY \`idx_location_id\` (\`LOCATION_ID\`),
        KEY \`idx_product_id\` (\`PRODUCT_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存序列号详情表';
    `);

    // =============== 组织与人员模块 ===============

    // T_DISTRIBUTOR: 经销商/代理商表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_DISTRIBUTOR\` (
        \`DISTRIBUTOR_ID\` varchar(32) PRIMARY KEY COMMENT '经销商ID',
        \`OPEN_ID\` varchar(64) COMMENT '微信 OpenID (管理员绑定的)',
        \`NAME\` varchar(255) NOT NULL COMMENT '经销商名称',
        \`ADDRESS\` varchar(512) COMMENT '详细地址',
        \`PHONE\` varchar(32) COMMENT '联系电话',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-正常, 0-停用',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        \`IS_DELETED\` bit(1) DEFAULT b'0' COMMENT '软删除标记'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='一级经销商/代理商表';
    `);

    // T_STORE: 具体门店/体验店表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_STORE\` (
        \`STORE_ID\` varchar(32) PRIMARY KEY COMMENT '门店主键ID',
        \`DISTRIBUTOR_ID\` varchar(32) COMMENT '所属经销商ID',
        \`OPEN_ID\` varchar(64) COMMENT '店长微信 OpenID',
        \`NAME\` varchar(255) NOT NULL COMMENT '门店名称 (如: 联想体验店(成都万象城店))',
        \`ADDRESS\` varchar(512) COMMENT '门店地址',
        \`PHONE\` varchar(32) COMMENT '门店固话',
        \`MANAGER_STAFF_ID\` bigint(20) COMMENT '店长(负责人)的员工ID',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-正常, 0-停用',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`IS_DELETED\` bit(1) DEFAULT b'0',
        KEY \`idx_distributor_id\` (\`DISTRIBUTOR_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='具体门店/体验店表';
    `);

    // T_STAFF: 员工表 (统管经销商老板、财务、店长、店员等)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_STAFF\` (
        \`STAFF_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY COMMENT '员工自增ID',
        \`DISTRIBUTOR_ID\` varchar(32) NOT NULL COMMENT '所属经销商ID (必须关联到某个经销商)',
        \`STORE_ID\` varchar(32) COMMENT '所属门店ID (如果为空，代表是跨门店的经销商级别账号，如老板/财务)',
        \`NAME\` varchar(64) NOT NULL COMMENT '员工姓名',
        \`PHONE\` varchar(32) NOT NULL COMMENT '手机号 (用于登录/授权校验)',
        \`PASSWORD_HASH\` varchar(128) COMMENT '密码/验证哈希',
        \`ROLE\` varchar(64) DEFAULT 'staff' COMMENT '角色: boss-老板, finance-财务, area_manager-区域主管, store_admin-店长, staff-店员',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-在职/合规, 0-离职/停用',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        \`IS_DELETED\` bit(1) DEFAULT b'0' COMMENT '软删除标记',
        UNIQUE KEY \`uni_inx_phone\` (\`PHONE\`),
        KEY \`idx_distributor_id\` (\`DISTRIBUTOR_ID\`),
        KEY \`idx_store_id\` (\`STORE_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='组织人员结构表(含经销商超管与店员)';
    `);

    // =============== 交易与订单模块 ===============

    // T_ORDER: 订单主表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_ORDER\` (
        \`ORDER_ID\` varchar(32) PRIMARY KEY COMMENT '系统订单主键',
        \`ORDER_NO\` varchar(64) NOT NULL COMMENT '业务订单号',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '销售门店ID',
        \`STORE_NAME\` varchar(255) COMMENT '销售门店名称快照',
        \`CREATE_USER\` varchar(64) COMMENT '制单人姓名',
        \`CUSTOMER_ID\` varchar(32) COMMENT '关联客户/会员主键ID',
        \`CUSTOMER_NAME\` varchar(64) COMMENT '客户姓名(快照)',
        \`CUSTOMER_PHONE\` varchar(32) COMMENT '客户电话(快照)',
        \`CUSTOMER_SOURCE_ID\` varchar(64) COMMENT '客户来源 ID',
        \`TOTAL_AMOUNT\` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '订单总金额 (推算)',
        \`DISCOUNT_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '优惠折扣金额',
        \`EDUCATION_SUBSIDY\` decimal(10,2) DEFAULT 0.00 COMMENT '教育补贴',
        \`NATIONAL_SUBSIDY\` decimal(10,2) DEFAULT 0.00 COMMENT '国家补贴',
        \`ACTUAL_PAYMENT\` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '实际应付/已付金额',
        \`INVOICE_STATUS\` varchar(32) DEFAULT '不开票' COMMENT '开票状态',
        \`ORDER_STATUS\` varchar(32) DEFAULT '已完成' COMMENT '订单状态',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '下单时间',
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        \`IS_DELETED\` bit(1) DEFAULT b'0' COMMENT '软删除标记',
        UNIQUE KEY \`uni_inx_order_no\` (\`ORDER_NO\`),
        KEY \`idx_store_time\` (\`STORE_ID\`, \`CREATE_TIME\`),
        KEY \`idx_customer_id\` (\`CUSTOMER_ID\`),
        KEY \`idx_customer_phone\` (\`CUSTOMER_PHONE\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售订单主表';
    `);

    // T_ORDER_ITEM: 订单明细表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_ORDER_ITEM\` (
        \`ITEM_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY COMMENT '明细自增ID',
        \`ORDER_ID\` varchar(32) NOT NULL COMMENT '关联订单主键',
        \`INVENTORY_ID\` varchar(32) NOT NULL COMMENT '关联库存SN主键ID',
        \`PRODUCT_NAME\` varchar(255) COMMENT '商品名称快照',
        \`PN_CODE\` varchar(64) COMMENT '料号快照',
        \`MTM_CODE\` varchar(64) COMMENT 'MTM码',
        \`SALE_PRICE\` decimal(10,2) NOT NULL COMMENT '实际销售单价',
        \`QUANTITY\` int(11) NOT NULL DEFAULT 1 COMMENT '数量',
        \`SUBTOTAL\` decimal(10,2) NOT NULL COMMENT '行小计',
        KEY \`idx_order_id\` (\`ORDER_ID\`),
        KEY \`idx_inventory_id\` (\`INVENTORY_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单商品明细表';
    `);

    // T_ORDER_PAYMENT: 订单支付流水表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_ORDER_PAYMENT\` (
        \`PAYMENT_RECORD_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY COMMENT '支付记录自增ID',
        \`ORDER_ID\` varchar(32) NOT NULL COMMENT '关联订单主键',
        \`PAYMENT_METHOD_ID\` varchar(64) NOT NULL COMMENT '支付方式标识',
        \`AMOUNT\` decimal(10,2) NOT NULL COMMENT '支付金额',
        \`PAYMENT_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '支付时间',
        KEY \`idx_order_payment\` (\`ORDER_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单支付流水表';
    `);

    // T_ORDER_ATTACHMENT: 订单附件凭证表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_ORDER_ATTACHMENT\` (
        \`ATTACH_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY COMMENT '附件自增ID',
        \`ORDER_ID\` varchar(32) NOT NULL COMMENT '关联订单主键',
        \`ATTACH_TYPE\` varchar(64) COMMENT '附件类型 (如: 产品包装盒/底壳)',
        \`FILE_URL\` varchar(1024) NOT NULL COMMENT '文件存储路径/URL',
        \`UPLOAD_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
        \`SORT_ORDER\` int(11) DEFAULT 0 COMMENT '排序',
        KEY \`idx_order_attach\` (\`ORDER_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单证明附件表';
    `);

    // =============== 基础配置及附属与设备模块 ===============

    // T_DICT_CUSTOMER_SOURCE: 客户来源字典
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_DICT_CUSTOMER_SOURCE\` (
        \`SOURCE_ID\` varchar(64) PRIMARY KEY COMMENT '来源ID',
        \`NAME\` varchar(128) NOT NULL COMMENT '来源名称',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-启用, 0-停用',
        \`SORT_ORDER\` int(11) DEFAULT 0 COMMENT '排序号',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_source_name\` (\`NAME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='客户来源配置表';
    `);

    // T_DICT_PAYMENT_METHOD: 支付方式字典
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_DICT_PAYMENT_METHOD\` (
        \`METHOD_ID\` varchar(64) PRIMARY KEY COMMENT '支付方式ID',
        \`NAME\` varchar(128) NOT NULL COMMENT '支付方式名称',
        \`STATUS\` tinyint(4) DEFAULT 1 COMMENT '状态: 1-启用, 0-停用',
        \`SORT_ORDER\` int(11) DEFAULT 0 COMMENT '排序号',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_method_name\` (\`NAME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付方式配置表';
    `);

    // T_DICT_SUPPLEMENT_ITEM: 附加服务费字典表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_DICT_SUPPLEMENT_ITEM\` (
        \`ITEM_ID\` varchar(64) PRIMARY KEY COMMENT '附加项ID',
        \`NAME\` varchar(128) NOT NULL COMMENT '项目名称 (如: 运费)',
        \`IS_ACTIVE\` varchar(10) DEFAULT '1' COMMENT '状态: 1-启用, 0-停用',
        \`SORT_ORDER\` int(11) DEFAULT 0 COMMENT '排序',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_sup_name\` (\`NAME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单附加费用字典表';
    `);

    // T_PRINTER_DEVICE: 蓝牙小票打印机设备表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_PRINTER_DEVICE\` (
        \`PRINTER_ID\` varchar(64) PRIMARY KEY COMMENT '打印机ID',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '归属门店ID',
        \`DEVICE_ID\` varchar(64) NOT NULL COMMENT '蓝牙MAC/设备地址',
        \`NAME\` varchar(128) NOT NULL COMMENT '设备名称',
        \`LOCAL_NAME\` varchar(128) COMMENT '本地广播名称',
        \`CONNECTABLE\` bit(1) DEFAULT b'1' COMMENT '是否可连接',
        \`RSSI\` int(11) COMMENT '信号强度',
        \`ADVERTISE_SERVICE_UUIDS\` text COMMENT '蓝牙服务UUID列表(JSON格式)',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_device\` (\`DEVICE_ID\`),
        KEY \`idx_printer_store\` (\`STORE_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店蓝牙打印机设备表';
    `);

    // =============== 客户与CRM模块 ===============

    // T_CUSTOMER: 客户/会员主表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_CUSTOMER\` (
        \`CUSTOMER_ID\` varchar(32) PRIMARY KEY COMMENT '客户单主键ID',
        \`DISTRIBUTOR_ID\` varchar(32) NOT NULL COMMENT '归属经销商ID',
        \`NAME\` varchar(64) NOT NULL COMMENT '客户姓名',
        \`PHONE\` varchar(32) NOT NULL COMMENT '客户手机号',
        \`CUSTOMER_TYPE\` varchar(32) DEFAULT 'retail' COMMENT '客户类型: retail-散客, corporate-企业/大客户',
        \`TOTAL_SPEND\` decimal(10,2) DEFAULT 0.00 COMMENT '累计消费总额',
        \`ORDER_COUNT\` int(11) DEFAULT 0 COMMENT '累计下单次数',
        \`REGISTER_STORE_ID\` varchar(32) COMMENT '首次登记门店ID',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_customer_phone\` (\`PHONE\`),
        KEY \`idx_customer_distributor\` (\`DISTRIBUTOR_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='客户/会员主表';
    `);

    // =============== 采购与仓储流转模块 ===============

    // T_INBOUND_ORDER: 入库单主表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_INBOUND_ORDER\` (
        \`INBOUND_ID\` varchar(32) PRIMARY KEY COMMENT '入库单主键',
        \`INBOUND_NO\` varchar(64) NOT NULL COMMENT '业务入库单号',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '收货门店ID / 或总仓ID',
        \`SUPPLIER_NAME\` varchar(128) COMMENT '供应商名称/上游来源',
        \`TOTAL_QUANTITY\` int(11) DEFAULT 0 COMMENT '总计入库数量',
        \`TOTAL_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '总计采购金额',
        \`STATUS\` varchar(32) DEFAULT 'pending' COMMENT '状态: pending-待收货, completed-已入库, cancelled-已取消',
        \`CREATE_USER\` varchar(64) COMMENT '制单人姓名',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_inbound_no\` (\`INBOUND_NO\`),
        KEY \`idx_inbound_store\` (\`STORE_ID\`, \`CREATE_TIME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采购/调拨入库单主表';
    `);

    // T_INBOUND_ITEM: 入库明细单/扫码记录
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_INBOUND_ITEM\` (
        \`ITEM_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY,
        \`INBOUND_ID\` varchar(32) NOT NULL COMMENT '关联入库单主键',
        \`PRODUCT_ID\` bigint(20) NOT NULL COMMENT '关联产品ID',
        \`SN_CODE\` varchar(128) COMMENT '序列号(如果是串码商品)',
        \`IMPORT_PRICE\` decimal(10,2) COMMENT '采购进价',
        \`QUANTITY\` int(11) DEFAULT 1 COMMENT '数量',
        KEY \`idx_inbound_id\` (\`INBOUND_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入库单明细表';
    `);

    // T_INVENTORY_TRANSFER: 库存调拨单表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_INVENTORY_TRANSFER\` (
        \`TRANSFER_ID\` varchar(32) PRIMARY KEY COMMENT '调拨单主键',
        \`TRANSFER_NO\` varchar(64) NOT NULL COMMENT '业务调拨单号',
        \`FROM_STORE_ID\` varchar(32) NOT NULL COMMENT '调出方门店ID',
        \`TO_STORE_ID\` varchar(32) NOT NULL COMMENT '调入方门店/仓库ID',
        \`TOTAL_QUANTITY\` int(11) DEFAULT 0 COMMENT '调拨总数',
        \`STATUS\` varchar(32) DEFAULT 'shipping' COMMENT '状态: shipping-调拨中, received-已接收, rejected-已拒绝',
        \`APPLY_USER\` varchar(64) COMMENT '申请人',
        \`CONFIRM_USER\` varchar(64) COMMENT '接收确认人',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_transfer_no\` (\`TRANSFER_NO\`),
        KEY \`idx_transfer_from_to\` (\`FROM_STORE_ID\`, \`TO_STORE_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店库存调拨主表';
    `);

    // T_TRANSFER_ITEM: 调拨明细表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_TRANSFER_ITEM\` (
        \`ITEM_ID\` bigint(20) AUTO_INCREMENT PRIMARY KEY,
        \`TRANSFER_ID\` varchar(32) NOT NULL COMMENT '关联调拨单',
        \`INVENTORY_ID\` varchar(32) NOT NULL COMMENT '关联库存SN主键ID(具体调拨的机器)',
        KEY \`idx_transfer_id\` (\`TRANSFER_ID\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='调拨机器明细表';
    `);

    // =============== 售后与财务对账模块 ===============

    // T_RETURN_ORDER: 售后退换单
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_RETURN_ORDER\` (
        \`RETURN_ID\` varchar(32) PRIMARY KEY COMMENT '售后退换主键',
        \`RETURN_NO\` varchar(64) NOT NULL COMMENT '业务退换号',
        \`ORIGINAL_ORDER_ID\` varchar(32) NOT NULL COMMENT '原销售订单ID',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '处理门店ID',
        \`RETURN_TYPE\` varchar(32) NOT NULL COMMENT '类型: refund-仅退款, return-退货退款, exchange-换货',
        \`REFUND_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '退回金额',
        \`REASON\` varchar(255) COMMENT '退换原因',
        \`STATUS\` varchar(32) DEFAULT 'processing' COMMENT '状态: processing-处理中, completed-已完成, closed-已关闭',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_inx_return_no\` (\`RETURN_NO\`),
        KEY \`idx_return_store\` (\`STORE_ID\`, \`CREATE_TIME\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='售后退换单主表';
    `);

    // T_DAILY_STATEMENT: 门店日结对账单
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`T_DAILY_STATEMENT\` (
        \`STATEMENT_ID\` varchar(32) PRIMARY KEY COMMENT '日结单主键',
        \`STORE_ID\` varchar(32) NOT NULL COMMENT '门店ID',
        \`STATEMENT_DATE\` date NOT NULL COMMENT '日结账单日期',
        \`TOTAL_REVENUE\` decimal(10,2) DEFAULT 0.00 COMMENT '当日总营业额',
        \`TOTAL_REFUND\` decimal(10,2) DEFAULT 0.00 COMMENT '当日总退款退单额',
        \`CASH_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '现金收入打款',
        \`WECHAT_ALIPAY_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '微信支付宝等进件收入',
        \`DIFFERENCE_AMOUNT\` decimal(10,2) DEFAULT 0.00 COMMENT '账实差异(如短款/长款)',
        \`SUBMIT_STAFF_ID\` bigint(20) COMMENT '提交/盘点员工',
        \`STATUS\` varchar(32) DEFAULT 'draft' COMMENT '状态: draft-草稿, submitted-已提交, confirmed-财务已确入',
        \`CREATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`UPDATE_TIME\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY \`uni_idx_store_date\` (\`STORE_ID\`, \`STATEMENT_DATE\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店日结对账单主表';
    `);


    await connection.commit();
    console.log('--- 全部数据库表结构初始化完成 ---');
  } catch (error) {
    await connection.rollback();
    console.error('❌ 初始化建表失败:', error.message);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = initializeDatabase;

// 当独立运行此文件时执行
if (require.main === module) {
  // 需要先配置好对应的数据源以便此处独立执行，通常会在应用启动入口处引入调用
  const dbConfig = require('../config');
  db.init(dbConfig);
  initializeDatabase().then(() => {
    db.close();
    process.exit(0);
  }).catch((err) => {
    db.close();
    process.exit(1);
  });
}
