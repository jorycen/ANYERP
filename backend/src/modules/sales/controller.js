/**
 * 销售管理控制器
 */
const {
  Order,
  OrderItem,
  OrderPayment,
  SalesReturnRequest,
  SalesReturnRequestItem,
  OrderSupplement,
  OrderGrossProfit,
  OrderAttachment,
  DepositOrder,
  DepositRefund,
  DepositRedemption,
  Store,
  Staff,
  Distributor,
  StaffStorePermission,
  Product,
  ProductPn,
  ProductSn,
  Location,
  ProductPrice,
  SnDistributorPrice,
  Inventory,
  PaymentMethod,
  SupplementItem,
  ManufacturerPriceHistory,
  ManufacturerRebatePolicy,
  RebateEstimate,
  ResourceSettlement,
  InventoryResourceRight,
  SalesSettlementCostAdjustment,
  Inbound,
  InboundItem,
  SnLog,
  sequelize
} = require('../../models');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { Op, literal, QueryTypes } = require('sequelize');
const { generateOrderNo, generateInboundNo, generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { normalizePnCode } = require('../../utils/productPn');
const { summariesForSns, lockSaleRights, finishSaleRights, releaseSaleRights, createPendingSettlement, triggerSaleResourceBenefits } = require('../inventory/resourceRights');
const { getUserRoles } = require('../../middleware/permission');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');

async function isRentalDemoSn(sn, transaction = null) {
  if (sn?.inventory_type === 'rental_demo_qty') return true;
  if (!sn?.location_id) return false;
  const location = await Location.findByPk(sn.location_id, {
    attributes: ['type'],
    transaction
  });
  return location?.type === 'rental_demo_qty';
}
const { issueDownloadTicket } = require('../../utils/downloadTicket');
const { canViewSnTraceReference, isDealerTraceAccount } = require('../../utils/snTracePermission');
const { sendExcel } = require('../../utils/excelExport');
const { getCloudStorageConfig, getSignedCloudFileUrl, parseCloudFileId } = require('../../utils/cloudStorage');
const {
  calculateAndSaveOrderGrossProfit,
  snapshotToResponse,
  calculateNationalSubsidyCustomerReceiptAmount
} = require('./grossProfit');

const SUBSIDY_PHOTO_UPLOAD_DIR = path.resolve(__dirname, '../../../uploads/national-subsidy-photos');
const SUBSIDY_PHOTO_ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUBSIDY_PHOTO_MAX_SIZE = 10 * 1024 * 1024;

function chinaDateBoundary(dateText, endOfDay = false) {
  if (!dateText) return null;
  const value = String(dateText).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  }
  return new Date(value);
}

function buildChinaDateRange(startDate, endDate) {
  const range = {};
  if (startDate) {
    const start = chinaDateBoundary(startDate, false);
    if (!isNaN(start.getTime())) range[Op.gte] = start;
  }
  if (endDate) {
    const end = chinaDateBoundary(endDate, true);
    if (!isNaN(end.getTime())) range[Op.lte] = end;
  }
  // Sequelize 的 Op.gte/Op.lte 是 Symbol key，不能用 Object.keys 判断是否有条件。
  return Reflect.ownKeys(range).length ? range : null;
}

/**
 * 销售订单列表
 */
async function auxiliaryStaff(ctx) {
  const user = ctx.state.user || {};
  const distributorId = user.distributorId;
  if (!distributorId) ctx.throw(403, '当前账号未绑定经销商');

  // 历史人员可能仍保留 DEFAULT 经销商，但其主门店/授权门店已经属于当前经销商。
  // 辅助销售人应按实际门店归属纳入，不能只依赖 T_STAFF.distributor_id。
  const distributorStores = await Store.findAll({
    where: {
      distributor_id: distributorId,
      is_deleted: 0,
      status: 1
    },
    attributes: ['store_id'],
    raw: true
  });
  const distributorStoreIds = distributorStores.map(store => String(store.store_id));
  const assignedStaffRows = distributorStoreIds.length
    ? await StaffStorePermission.findAll({
      where: { store_id: { [Op.in]: distributorStoreIds } },
      attributes: ['staff_id'],
      raw: true
    })
    : [];
  const assignedStaffIds = [...new Set(assignedStaffRows.map(row => row.staff_id).filter(Boolean))];
  const ownershipConditions = [{ distributor_id: distributorId }];
  if (distributorStoreIds.length) {
    ownershipConditions.push({ store_id: { [Op.in]: distributorStoreIds } });
  }
  if (assignedStaffIds.length) {
    ownershipConditions.push({ staff_id: { [Op.in]: assignedStaffIds } });
  }

  const rows = await Staff.findAll({
    where: {
      [Op.or]: ownershipConditions,
      is_deleted: 0,
      status: 1
    },
    attributes: ['staff_id', 'name', 'phone', 'role_code', 'store_id', 'region_id', 'distributor_id'],
    include: [
      { model: Store, as: 'Store', attributes: ['store_id', 'name', 'region_id', 'distributor_id'], required: false },
      {
        model: Store,
        as: 'AssignedStores',
        attributes: ['store_id', 'name', 'region_id', 'distributor_id'],
        through: { attributes: [] },
        required: false,
        where: { is_deleted: 0, status: 1 }
      }
    ],
    order: [['store_id', 'ASC'], ['name', 'ASC']]
  });

  const list = rows.map(row => {
    const data = row.toJSON();
    const assignedStores = data.AssignedStores || [];
    const allStores = [data.Store].concat(assignedStores).filter(Boolean);
    const primaryStore = allStores.find(store => (
      String(store.distributor_id || '') === String(distributorId) ||
      distributorStoreIds.includes(String(store.store_id || ''))
    )) || data.Store || assignedStores[0] || null;
    const storeNames = assignedStores.map(store => store.name).filter(Boolean);
    if (primaryStore && primaryStore.name && !storeNames.includes(primaryStore.name)) {
      storeNames.unshift(primaryStore.name);
    }

    return {
      staffId: data.staff_id,
      name: data.name,
      phone: data.phone,
      roleCode: data.role_code || 'staff',
      distributorId: data.distributor_id,
      storeId: primaryStore ? primaryStore.store_id : (data.store_id || ''),
      storeName: storeNames.join('、') || '',
      regionId: data.region_id || (primaryStore ? primaryStore.region_id : '') || ''
    };
  });

  ctx.body = { code: 0, data: list };
}

function canQueryAllSalesOrders(user) {
  const roles = getUserRoles(user);
  return isDealerTraceAccount(user) || roles.some(role => ['manager', 'store_manager'].includes(role));
}

async function list(ctx) {
  const {
    storeId, startDate, endDate, customerPhone, customerName, orderNo,
    status, createUser, submitUser, productName, productCode, pnCode, snCode,
    page = 1, pageSize = 20
  } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const accessibleStoreIds = Array.isArray(user.accessibleStoreIds) ? user.accessibleStoreIds.filter(Boolean) : [];
  const roles = getUserRoles(user);
  const dealerWide = isDealerTraceAccount(user);
  const canQueryAllStoreOrders = dealerWide || roles.some(role => ['manager', 'store_manager'].includes(role));
  const storeInclude = { model: Store };
  const applicantInclude = {
    model: Staff,
    as: 'Applicant',
    attributes: ['staff_id', 'name', 'role_code', 'store_id', 'distributor_id'],
    required: false,
    include: [
      { model: Store, as: 'Store', attributes: ['store_id', 'name'], required: false },
      { model: Distributor, attributes: ['distributor_id', 'name'], required: false }
    ]
  };
  const hasGlobalStoreScope = roles.includes('boss') || accessibleStoreIds.includes('*');

  const dateRange = buildChinaDateRange(startDate, endDate);
  if (dateRange) {
    where.create_time = dateRange;
  }
  if (customerPhone) {
    where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  }
  if (customerName) {
    where.customer_name = { [Op.like]: `%${customerName}%` };
  }
  if (orderNo) {
    where.order_no = { [Op.like]: `%${orderNo}%` };
  }
  if (status) {
    where.order_status = status;
  }
  if (createUser) {
    where.create_user = { [Op.like]: `%${createUser}%` };
  }
  if (submitUser) {
    where[Op.or] = [
      { submit_user: { [Op.like]: `%${submitUser}%` } },
      {
        [Op.and]: [
          { [Op.or]: [{ submit_user: { [Op.is]: null } }, { submit_user: '' }] },
          { create_user: { [Op.like]: `%${submitUser}%` } }
        ]
      }
    ];
  }

  if (storeId) {
    if (!hasGlobalStoreScope && !accessibleStoreIds.map(String).includes(String(storeId))) {
      ctx.throw(403, '无权访问该门店订单');
    }
    where.store_id = storeId;
  } else if (!hasGlobalStoreScope) {
    if (accessibleStoreIds.length === 0) {
      ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
      return;
    }
    where.store_id = accessibleStoreIds;
  }

  // 店员只能查询自己创建的订单；店长及以上角色才可以查询门店内全部订单。
  // 这里必须在服务端强制执行，不能依赖小程序传入的 userRole/searchAll 参数。
  if (!canQueryAllStoreOrders) {
    where.create_user = user.name || '__NO_MATCHING_STAFF__';
  }

  const itemWhere = {};
  if (pnCode) itemWhere.pn_code = { [Op.like]: `%${pnCode}%` };
  if (snCode) itemWhere.sn_code = { [Op.like]: `%${snCode}%` };
  const itemInclude = { model: OrderItem };
  if (productName) itemWhere.product_name = { [Op.like]: `%${productName}%` };
  if (productCode) {
    itemInclude.include = [{
      model: Product,
      where: { product_code: { [Op.like]: `%${productCode}%` } },
      required: true
    }];
    itemInclude.required = true;
  }
  if (Object.keys(itemWhere).length > 0) {
    itemInclude.where = itemWhere;
    itemInclude.required = true;
  }

  const { count, rows } = await Order.findAndCountAll({
    where,
    include: [
      storeInclude,
      applicantInclude,
      itemInclude,
      { model: OrderPayment },
      { model: OrderSupplement, as: 'supplements', where: { is_deleted: 0 }, required: false }
    ],
    distinct: true,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'Order.order_status',
      pendingStatuses: ['draft', 'pending_approval', '未归档'],
      dateColumns: ['Order.create_time'],
      idColumn: 'Order.order_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 查询经销商范围内某商品的订单，只读且不受当前门店限制。
 * 先取最近的有效订单，再按商品毛利降序展示前5单。
 */
async function listProductOrders(ctx) {
  const productId = String(ctx.params.productId || '').trim();
  const distributorId = String(ctx.state.user?.distributorId || '').trim();
  if (!productId) ctx.throw(400, '商品ID不能为空');
  if (!distributorId) ctx.throw(403, '当前账号未绑定经销商');

  const product = await Product.findOne({
    where: { product_id: productId, is_deleted: 0, status: 1 },
    attributes: ['product_id', 'product_code', 'name']
  });
  if (!product) ctx.throw(404, '商品不存在');

  const rows = await sequelize.query(
    `SELECT o.ORDER_ID AS order_id,
            o.ORDER_NO AS order_no,
            o.ORDER_STATUS AS order_status,
            o.CREATE_TIME AS create_time,
            o.STORE_ID AS store_id,
            s.NAME AS store_name,
            SUM(oi.QUANTITY) AS quantity,
            SUM(oi.SUBTOTAL) AS sales_amount,
            SUM(COALESCE(oi.SALES_GROSS_PROFIT, oi.SUBTOTAL - oi.SALES_SETTLEMENT_COST * oi.QUANTITY)) AS gross_profit
       FROM T_ORDER_ITEM oi
       INNER JOIN T_ORDER o ON oi.ORDER_ID = o.ORDER_ID
       INNER JOIN T_STORE s ON o.STORE_ID = s.STORE_ID
                            AND s.DISTRIBUTOR_ID = :distributorId
      WHERE oi.PRODUCT_ID = :productId
        AND (o.IS_DELETED IS NULL OR o.IS_DELETED = 0)
        AND (o.ORDER_STATUS IS NULL OR o.ORDER_STATUS NOT IN ('draft', 'pending_approval'))
      GROUP BY o.ORDER_ID, o.ORDER_NO, o.ORDER_STATUS, o.CREATE_TIME, o.STORE_ID, s.NAME
      ORDER BY o.CREATE_TIME DESC, o.ORDER_ID DESC
      LIMIT 50`,
    { replacements: { productId, distributorId }, type: QueryTypes.SELECT }
  );

  const validRows = rows
    .filter(row => !isCancelStatus(row.order_status))
    .slice(0, 5)
    .sort((a, b) => Number(b.gross_profit || 0) - Number(a.gross_profit || 0));

  ctx.body = {
    code: 0,
    data: {
      product: {
        productId: product.product_id,
        productCode: product.product_code || '',
        productName: product.name || ''
      },
      orders: validRows.map(row => ({
        orderId: row.order_id,
        orderNo: row.order_no || '',
        orderStatus: row.order_status || '',
        createTime: row.create_time,
        storeId: row.store_id || '',
        storeName: row.store_name || '',
        quantity: Number(row.quantity || 0),
        salesAmount: Number(row.sales_amount || 0),
        grossProfit: Number(row.gross_profit || 0)
      }))
    }
  };
}

const ORDER_EXPORT_HEADERS = [
  '订单编号', '下单时间', '提交人', '门店名称', '门店ID', '一级来源', '二级来源',
  '会员称呼', '会员联系方式', '订单总计', '优惠金额', '国补', '教育补贴', '应收金额',
  '收款金额汇总', '门店二维码', '现金', '国补POS（电脑）', '国补POS（手机平板）',
  '定金抵扣', '旧机回收抵扣', '商场优惠券', '智店通POS', '线上OMO平台', '对公转账',
  '对私转账', '龙湖POS（北城专用）', '其他收款方式2', '归档状态', '开票状态', '开票信息',
  '开票金额', '国补状态', '国补人', '国补人ID', '商品名称', '商品编码', 'SN码', 'IMEI1',
  'IMEI2', '数量', '单价', '小计', '商品应收金额', '商品收款金额', '辅助销售人比例分配',
  '辅助销售人金额分配', '补录教育优惠', '商品提货运费', '追加商品', '退货商品', '预留字段1',
  '预留字段2', '备注', '创建日期', '订单状态', '归档/作废时间', '操作人'
];

const ORDER_EXPORT_PAYMENT_HEADERS = ORDER_EXPORT_HEADERS.slice(15, 28);

function parseExportJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function exportPaymentAmount(payments, header) {
  return (payments || []).reduce((total, payment) => {
    const rawMethod = String(payment?.payment_method || '').trim();
    const method = rawMethod.replace(/-(客户实收|政策补贴应收)$/, '');
    const matches = method === header || rawMethod === header || rawMethod.startsWith(`${header}-`);
    return matches ? total + Number(payment.amount || 0) : total;
  }, 0);
}

function exportSupplementText(supplements, predicate = () => true) {
  return (supplements || [])
    .filter(item => predicate(item))
    .map(item => {
      const amount = Number(item.amount || 0);
      const content = String(item.content || '').trim();
      return `${item.item_name || ''}${amount ? `:${amount}` : ''}${content ? `(${content})` : ''}`;
    })
    .filter(Boolean)
    .join('；');
}

function exportSupplementAmount(supplements, predicate) {
  return (supplements || [])
    .filter(item => predicate(item))
    .reduce((total, item) => total + Number(item.amount || 0) * (item.amount_type === 'decrease' ? -1 : 1), 0);
}

function exportAuxiliaryValue(value, field) {
  return parseExportJson(value, [])
    .filter(item => item && typeof item === 'object')
    .map(item => {
      const name = item.name || item.staffName || item.staff_name || item.selected || '';
      const raw = field === 'ratio'
        ? (item.ratio ?? item.proportion ?? item.rate ?? item.percentage)
        : (item.amount ?? item.assignedAmount ?? item.assigned_amount);
      if (!name && (raw === undefined || raw === null || raw === '')) return '';
      return `${name || ''}${raw !== undefined && raw !== null && raw !== '' ? `:${raw}` : ''}`;
    })
    .filter(Boolean)
    .join('；');
}

function exportReturnText(returns) {
  return (returns || [])
    .flatMap(item => (item.items || []).map(detail => {
      const quantity = Number(detail.quantity || 0);
      return `${detail.product_name || ''}${quantity ? ` x${quantity}` : ''}${detail.sn_code ? `(${detail.sn_code})` : ''}`;
    }))
    .filter(Boolean)
    .join('；');
}

function buildOrderExportRows(orders) {
  return orders.flatMap(order => {
    const data = order.toJSON();
    const items = Array.isArray(data.OrderItems) && data.OrderItems.length ? data.OrderItems : [{}];
    const payments = data.OrderPayments || [];
    const supplements = data.supplements || [];
    const auxiliary = data.auxiliary_sales_list;
    const payableAmount = Math.max(0, Number(data.total_amount || 0)
      - Number(data.discount_amount || 0)
      - Number(data.national_subsidy || 0)
      - Number(data.education_subsidy || 0)
      - Number(data.deposit_deduction_total || 0));
    const paymentAmounts = Object.fromEntries(
      ORDER_EXPORT_PAYMENT_HEADERS.map(header => [header, exportPaymentAmount(payments, header)])
    );
    const supplementEducation = exportSupplementAmount(supplements, item => /教育/.test(String(item.item_name || '')));
    const supplementFreight = exportSupplementAmount(supplements, item => /提货运费|运费/.test(String(item.item_name || '')));

    return items.map(item => {
      const subtotal = Number(item.subtotal || 0);
      const productCode = item.pn_code || item.Product?.product_code || item.product_id || '';
      return {
        订单编号: data.order_no || '',
        下单时间: data.create_time || '',
        提交人: data.submit_user || data.create_user || '',
        门店名称: data.Store?.name || '',
        门店ID: data.store_id || '',
        一级来源: data.customer_source || '',
        二级来源: data.customer_source_detail || '',
        会员称呼: data.customer_name || '',
        会员联系方式: data.customer_phone || '',
        订单总计: Number(data.total_amount || 0),
        优惠金额: Number(data.discount_amount || 0),
        国补: Number(data.national_subsidy || 0),
        教育补贴: Number(data.education_subsidy || 0),
        应收金额: payableAmount,
        收款金额汇总: payments.reduce((total, payment) => total + Number(payment.amount || 0), 0),
        ...paymentAmounts,
        归档状态: isArchiveStatus(data.order_status) ? '已归档' : '',
        开票状态: data.invoice_status || '',
        开票信息: data.invoice_info || '',
        开票金额: Number(data.invoice_amount || 0),
        国补状态: data.subsidy_status || '',
        国补人: data.subsidy_person || '',
        国补人ID: data.subsidy_id || '',
        商品名称: item.product_name || item.Product?.name || '',
        商品编码: productCode,
        SN码: item.sn_code || '',
        IMEI1: item.imei1 || '',
        IMEI2: item.imei2 || '',
        数量: Number(item.quantity || 0),
        单价: Number(item.sale_price || 0),
        小计: subtotal,
        商品应收金额: subtotal,
        商品收款金额: subtotal,
        辅助销售人比例分配: exportAuxiliaryValue(auxiliary, 'ratio'),
        辅助销售人金额分配: exportAuxiliaryValue(auxiliary, 'amount'),
        补录教育优惠: supplementEducation,
        商品提货运费: supplementFreight,
        追加商品: exportSupplementText(supplements, item => item.amount_type !== 'decrease'),
        退货商品: exportReturnText(data.salesReturns),
        预留字段1: '',
        预留字段2: '',
        备注: data.remark || '',
        创建日期: data.create_time || '',
        订单状态: data.order_status || '',
        '归档/作废时间': isArchiveStatus(data.order_status) || isCancelStatus(data.order_status) ? (data.update_time || '') : '',
        操作人: data.approve_user || data.submit_user || data.create_user || ''
      };
    });
  });
}

async function exportOrders(ctx) {
  const user = ctx.state.user;
  if (!isDealerTraceAccount(user)) {
    ctx.throw(403, '仅经销商级账号支持导出订单');
  }

  const {
    storeId, startDate, endDate, customerPhone, customerName, orderNo,
    status, createUser, submitUser, productName, productCode, pnCode, snCode
  } = ctx.query;
  const roles = getUserRoles(user);
  const where = { is_deleted: 0 };
  const storeInclude = { model: Store };
  const accessibleStoreIds = Array.isArray(user.accessibleStoreIds) ? user.accessibleStoreIds.filter(Boolean) : [];
  const hasGlobalStoreScope = roles.includes('boss') || accessibleStoreIds.includes('*');
  if (storeId) {
    if (!hasGlobalStoreScope && !accessibleStoreIds.map(String).includes(String(storeId))) {
      ctx.throw(403, '无权导出该门店订单');
    }
    where.store_id = storeId;
  } else if (!hasGlobalStoreScope) {
    where.store_id = accessibleStoreIds.length > 0 ? accessibleStoreIds : '__NO_ACCESS__';
  }
  if (startDate || endDate) {
    const dateRange = buildChinaDateRange(startDate, endDate);
    if (dateRange) where.create_time = dateRange;
  }
  if (customerPhone) where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  if (customerName) where.customer_name = { [Op.like]: `%${customerName}%` };
  if (orderNo) where.order_no = { [Op.like]: `%${orderNo}%` };
  if (status) where.order_status = status;
  if (createUser) where.create_user = { [Op.like]: `%${createUser}%` };
  if (submitUser) {
    where[Op.or] = [
      { submit_user: { [Op.like]: `%${submitUser}%` } },
      {
        [Op.and]: [
          { [Op.or]: [{ submit_user: { [Op.is]: null } }, { submit_user: '' }] },
          { create_user: { [Op.like]: `%${submitUser}%` } }
        ]
      }
    ];
  }

  const itemWhere = {};
  if (productName) itemWhere.product_name = { [Op.like]: `%${productName}%` };
  if (pnCode) itemWhere.pn_code = { [Op.like]: `%${pnCode}%` };
  if (snCode) itemWhere.sn_code = { [Op.like]: `%${snCode}%` };
  const itemInclude = { model: OrderItem };
  if (Object.keys(itemWhere).length > 0) {
    itemInclude.where = itemWhere;
    itemInclude.required = true;
  }
  const productInclude = {
    model: Product,
    attributes: ['product_id', 'product_code', 'name'],
    ...(productCode ? { where: { product_code: { [Op.like]: `%${productCode}%` } }, required: true } : {})
  };

  const orders = await Order.findAll({
    where,
    include: [
      storeInclude,
      { ...itemInclude, include: [productInclude] },
      { model: OrderPayment },
      { model: OrderSupplement, as: 'supplements', where: { is_deleted: 0 }, required: false },
      {
        model: SalesReturnRequest,
        as: 'salesReturns',
        required: false,
        include: [{ model: SalesReturnRequestItem, as: 'items', required: false }]
      }
    ],
    order: [['create_time', 'DESC'], ['order_id', 'DESC']]
  });

  sendExcel(ctx, buildOrderExportRows(orders), ORDER_EXPORT_HEADERS, `销售订单导出_${getChinaDateString()}.xlsx`, '订单明细');
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function publicCloudFileUrl(fileId) {
  const parsed = parseCloudFileId(fileId);
  const config = getCloudStorageConfig();
  if (!parsed || parsed.cloudEnv !== config.envId || parsed.bucketName !== config.bucket) return '';
  return `https://${parsed.bucketName}.tcb.qcloud.la/${encodeURI(parsed.key)}`;
}

function normalizeSubsidyPhotos(value) {
  const source = parseJsonValue(value, []);
  if (!Array.isArray(source)) return [];
  return source.map((item, index) => {
    if (typeof item === 'string') {
      return { id: `legacy-${index}`, name: `国补照片${index + 1}`, url: item, storage: 'external' };
    }
    if (!item || typeof item !== 'object') return null;
    const url = String(item.url || item.path || '').trim();
    const displayUrl = String(item.display_url || item.displayUrl || '').trim() || publicCloudFileUrl(url);
    if (!url && !displayUrl && !item.storage_name && !item.storageName) return null;
    return {
      id: String(item.id || item.photoId || `legacy-${index}`),
      name: String(item.name || item.originalName || `国补照片${index + 1}`),
      url,
      displayUrl,
      storage: item.storage || (item.storage_name || item.storageName ? 'local' : 'external'),
      storageName: item.storage_name || item.storageName || '',
      mimeType: item.mime_type || item.mimeType || '',
      size: Number(item.size || 0) || 0,
      uploadTime: item.upload_time || item.uploadTime || null
    };
  }).filter(Boolean);
}

function userCanViewSubsidyPhotos(user) {
  return getUserRoles(user).some(role => ['boss', 'admin', 'finance', 'manager', 'store_manager'].includes(role));
}

function subsidyPhotoStoreWhere(user) {
  const storeIds = Array.isArray(user?.accessibleStoreIds)
    ? user.accessibleStoreIds.filter(Boolean)
    : [];
  if (storeIds.includes('*')) return {};
  return storeIds.length ? { store_id: { [Op.in]: storeIds } } : { store_id: '__NO_ACCESS__' };
}

function buildSubsidyPhotoQuery(user, params = {}) {
  const where = {
    is_deleted: 0,
    [Op.and]: [literal('JSON_LENGTH(COALESCE(SUBSIDY_PHOTOS, JSON_ARRAY())) > 0')]
  };
  const roles = getUserRoles(user);
  const storeInclude = { model: Store, attributes: ['store_id', 'name'] };

  if (!roles.includes('boss')) {
    Object.assign(where, subsidyPhotoStoreWhere(user));
  }

  const { startDate, endDate, storeId, subsidyPerson, subsidyPhone, unionpayOrderNo } = params;
  const accessibleStoreIds = Array.isArray(user?.accessibleStoreIds)
    ? user.accessibleStoreIds.filter(Boolean).map(String)
    : [];
  const hasGlobalStoreScope = roles.includes('boss') || accessibleStoreIds.includes('*');

  if (storeId) {
    const requestedStoreId = String(storeId).trim();
    if (hasGlobalStoreScope || accessibleStoreIds.includes(requestedStoreId)) {
      where.store_id = requestedStoreId;
    } else {
      // 让显式传入未授权门店的请求返回空结果，避免通过查询参数扩大数据范围。
      where.store_id = '__NO_ACCESS__';
    }
  }
  const dateRange = buildChinaDateRange(startDate, endDate);
  if (dateRange) where.create_time = dateRange;
  if (subsidyPerson) where.subsidy_person = { [Op.like]: `%${String(subsidyPerson).trim()}%` };
  if (subsidyPhone) where.customer_phone = { [Op.like]: `%${String(subsidyPhone).trim()}%` };
  if (unionpayOrderNo) where.invoice_info = { [Op.like]: `%${String(unionpayOrderNo).trim()}%` };

  return { where, include: [storeInclude] };
}

function hasSubsidyPhotoFilter(params = {}) {
  return [params.startDate, params.endDate, params.storeId, params.subsidyPerson, params.subsidyPhone, params.unionpayOrderNo]
    .some(value => String(value || '').trim());
}

async function createSubsidyPhotosDownloadTicket(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权下载国补照片');
  if (!hasSubsidyPhotoFilter(ctx.query)) ctx.throw(400, '不支持全量下载，请选择查询条件');
  ctx.body = { code: 0, data: { ticket: issueDownloadTicket(ctx.headers.authorization?.replace('Bearer ', '')) } };
}

function subsidyPhotoResponse(order) {
  const data = order.toJSON ? order.toJSON() : order;
  const photos = normalizeSubsidyPhotos(data.subsidy_photos).map(photo => ({
      ...photo,
      isLocal: photo.storage === 'local',
      accessUrl: photo.storage === 'local' && photo.id
        ? `/api/v1/sales/subsidy-photos/${data.order_id}/files/${encodeURIComponent(photo.id)}`
        : photo.url || photo.displayUrl
  }));
  return {
    orderId: data.order_id,
    orderNo: data.order_no,
    storeId: data.store_id,
    storeName: data.Store?.name || '',
    createTime: data.create_time,
    subsidyPerson: data.subsidy_person || '',
    subsidyPhone: data.customer_phone || '',
    unionpayOrderNo: data.invoice_info || '',
    photos
  };
}

async function listSubsidyPhotos(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权访问国补照片');
  const { page = 1, pageSize = 20 } = ctx.query;
  const { where, include } = buildSubsidyPhotoQuery(ctx.state.user, ctx.query);

  const currentPage = Math.max(Number(page) || 1, 1);
  const currentPageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const result = await Order.findAndCountAll({
    where,
    include,
    order: [['create_time', 'DESC'], ['order_id', 'DESC']],
    offset: (currentPage - 1) * currentPageSize,
    limit: currentPageSize,
    distinct: true
  });
  ctx.body = formatPaginatedResult(result.rows.map(subsidyPhotoResponse), {
    page: currentPage,
    pageSize: currentPageSize,
    count: result.count
  });
}

function validateSubsidyPhotoFiles(files = []) {
  if (!files.length) throw Object.assign(new Error('请至少上传一张国补照片'), { status: 400 });
  for (const file of files) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!SUBSIDY_PHOTO_ALLOWED_EXTENSIONS.has(extension) || !String(file.mimetype || '').startsWith('image/')) {
      throw Object.assign(new Error(`仅支持 JPG、PNG、WEBP 图片：${file.originalname || '未命名文件'}`), { status: 400 });
    }
    if (file.size > SUBSIDY_PHOTO_MAX_SIZE) {
      throw Object.assign(new Error(`单张照片不能超过10MB：${file.originalname || '未命名文件'}`), { status: 400 });
    }
  }
}

function safeSubsidyPhotoPath(storageName) {
  const filePath = path.resolve(SUBSIDY_PHOTO_UPLOAD_DIR, String(storageName || ''));
  return filePath.startsWith(`${SUBSIDY_PHOTO_UPLOAD_DIR}${path.sep}`) ? filePath : null;
}

async function getSubsidyPhotoOrder(orderId, user) {
  const { where, include } = buildSubsidyPhotoQuery(user);
  where.order_id = orderId;
  return Order.findOne({
    where,
    include
  });
}

async function replaceSubsidyPhotos(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权修改国补照片');
  const order = await getSubsidyPhotoOrder(ctx.params.orderId, ctx.state.user);
  if (!order) ctx.throw(404, '订单不存在或无权操作');
  const files = ctx.files || [];
  validateSubsidyPhotoFiles(files);

  await fs.promises.mkdir(SUBSIDY_PHOTO_UPLOAD_DIR, { recursive: true });
  const stored = [];
  try {
    for (const file of files) {
      const photoId = generateUUID();
      const extension = path.extname(file.originalname || '').toLowerCase();
      const storageName = `${photoId}${extension}`;
      const filePath = safeSubsidyPhotoPath(storageName);
      await fs.promises.writeFile(filePath, file.buffer);
      stored.push({
        id: photoId,
        name: path.basename(file.originalname || '国补照片').slice(0, 255),
        storage: 'local',
        storage_name: storageName,
        mime_type: file.mimetype || 'application/octet-stream',
        size: file.size || 0,
        upload_time: new Date().toISOString()
      });
    }

    const previous = normalizeSubsidyPhotos(order.subsidy_photos);
    await sequelize.transaction(async transaction => {
      await order.update({ subsidy_photos: stored, update_time: new Date() }, { transaction });
      await recordBusinessAction({
        businessType: 'sales_order',
        businessId: order.order_id,
        businessNo: order.order_no,
        action: 'subsidy_photos_updated',
        user: ctx.state.user,
        detail: { previousCount: previous.length, currentCount: stored.length, mode: 'replace' },
        transaction
      });
    });

    await Promise.all(previous
      .filter(photo => photo.storage === 'local' && photo.storageName)
      .map(photo => {
        const filePath = safeSubsidyPhotoPath(photo.storageName);
        return filePath ? fs.promises.unlink(filePath).catch(() => {}) : Promise.resolve();
      }));
  } catch (error) {
    await Promise.all(stored.map(photo => {
      const filePath = safeSubsidyPhotoPath(photo.storage_name);
      return filePath ? fs.promises.unlink(filePath).catch(() => {}) : Promise.resolve();
    }));
    throw error;
  }

  ctx.body = { code: 0, message: '国补照片已更新', data: subsidyPhotoResponse(order) };
}

async function downloadSubsidyPhoto(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权下载国补照片');
  const order = await getSubsidyPhotoOrder(ctx.params.orderId, ctx.state.user);
  if (!order) ctx.throw(404, '订单不存在或无权访问');
  const photo = normalizeSubsidyPhotos(order.subsidy_photos).find(item => item.id === String(ctx.params.photoId));
  if (!photo || photo.storage !== 'local' || !photo.storageName) ctx.throw(404, '照片不存在');
  const filePath = safeSubsidyPhotoPath(photo.storageName);
  if (!filePath || !fs.existsSync(filePath)) ctx.throw(404, '照片文件不存在');
  await recordBusinessAction({
    businessType: 'sales_order',
    businessId: order.order_id,
    businessNo: order.order_no,
    action: 'subsidy_photo_downloaded',
    user: ctx.state.user,
    detail: { photoId: photo.id, photoName: photo.name }
  });
  ctx.type = photo.mimeType || 'application/octet-stream';
  ctx.attachment(photo.name || '国补照片');
  ctx.body = fs.createReadStream(filePath);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFileName(name, index) {
  const fallback = `国补照片${index + 1}.jpg`;
  const segments = String(name || fallback)
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
  return segments.length ? segments.join('/') : fallback;
}

function inferSubsidyPhotoExtension(photo) {
  const mimeExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  };
  const candidates = [photo?.name, photo?.storageName, photo?.url, photo?.displayUrl];
  for (const candidate of candidates) {
    const cleanValue = String(candidate || '').split(/[?#]/, 1)[0];
    const extension = path.extname(cleanValue).toLowerCase();
    if (SUBSIDY_PHOTO_ALLOWED_EXTENSIONS.has(extension)) {
      return extension === '.jpeg' ? '.jpg' : extension;
    }
  }
  return mimeExtensions[String(photo?.mimeType || '').toLowerCase()] || '.jpg';
}

function subsidyPhotoFileName(photo, index) {
  const extension = inferSubsidyPhotoExtension(photo);
  const name = zipFileName(photo?.name, index);
  const nameExtension = path.extname(name).toLowerCase();
  return SUBSIDY_PHOTO_ALLOWED_EXTENSIONS.has(nameExtension) ? name : `${name}${extension}`;
}

function subsidyPhotoFolderName(order) {
  const data = order?.toJSON ? order.toJSON() : order || {};
  const createTime = data.create_time ? new Date(data.create_time) : new Date();
  const date = Number.isNaN(createTime.getTime()) ? new Date() : createTime;
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((result, item) => {
    result[item.type] = item.value;
    return result;
  }, {});
  const dateText = `${dateParts.year || '0000'}${dateParts.day || '00'}${dateParts.month || '00'}`;
  const person = String(data.subsidy_person || '').trim() || '未命名';
  const phone = String(data.customer_phone || '').trim() || '无手机号';
  return `${dateText}${person}${phone}`;
}

function createSubsidyPhotoZip(entries) {
  const output = new PassThrough();
  (async () => {
    const centralDirectory = [];
    let offset = 0;
    const usedNames = new Map();

    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const originalName = zipFileName(entry.name, index);
        const duplicateCount = usedNames.get(originalName) || 0;
        usedNames.set(originalName, duplicateCount + 1);
        const extension = path.extname(originalName);
        const stem = extension ? originalName.slice(0, -extension.length) : originalName;
        const fileName = duplicateCount ? `${stem}_${duplicateCount + 1}${extension}` : originalName;
        const nameBuffer = Buffer.from(fileName, 'utf8');
        const data = await entry.load();
        const checksum = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0800, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt16LE(0, 12);
        header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuffer.length, 26);
        header.writeUInt16LE(0, 28);
        output.write(Buffer.concat([header, nameBuffer, data]));

        centralDirectory.push({ nameBuffer, checksum, size: data.length, offset });
        offset += header.length + nameBuffer.length + data.length;
      }

      const centralOffset = offset;
      for (const entry of centralDirectory) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt16LE(0, 12);
        header.writeUInt16LE(0, 14);
        header.writeUInt32LE(entry.checksum, 16);
        header.writeUInt32LE(entry.size, 20);
        header.writeUInt32LE(entry.size, 24);
        header.writeUInt16LE(entry.nameBuffer.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(entry.offset, 42);
        output.write(Buffer.concat([header, entry.nameBuffer]));
        offset += header.length + entry.nameBuffer.length;
      }

      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0, 4);
      end.writeUInt16LE(0, 6);
      end.writeUInt16LE(centralDirectory.length, 8);
      end.writeUInt16LE(centralDirectory.length, 10);
      end.writeUInt32LE(offset - centralOffset, 12);
      end.writeUInt32LE(centralOffset, 16);
      end.writeUInt16LE(0, 20);
      output.end(end);
    } catch (error) {
      output.destroy(error);
    }
  })();
  return output;
}

async function subsidyPhotoZipEntries(order, folder = '') {
  const photos = normalizeSubsidyPhotos(order.subsidy_photos);
  const entries = [];
  const safeFolder = folder ? zipFileName(folder, 0) : '';
  for (const photo of photos) {
    if (photo.storage === 'local' && photo.storageName) {
      const filePath = safeSubsidyPhotoPath(photo.storageName);
      if (filePath && fs.existsSync(filePath)) {
        entries.push({
          id: photo.id,
          name: safeFolder ? `${safeFolder}/${subsidyPhotoFileName(photo, entries.length)}` : subsidyPhotoFileName(photo, entries.length),
          load: () => fs.promises.readFile(filePath)
        });
      }
      continue;
    }

    if (/^cloud:\/\//i.test(photo.url)) {
      entries.push({
        id: photo.id,
        name: safeFolder ? `${safeFolder}/${subsidyPhotoFileName(photo, entries.length)}` : subsidyPhotoFileName(photo, entries.length),
        load: async () => {
          let sourceUrl = photo.displayUrl;
          try {
            const signed = await getSignedCloudFileUrl(photo.url);
            sourceUrl = signed.url;
          } catch (error) {
            if (!/^https:\/\/[^/]+\.tcb\.qcloud\.la\//i.test(sourceUrl)) throw error;
          }
          const response = await fetch(sourceUrl);
          if (!response.ok) throw new Error(`云存储照片下载失败：HTTP ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        }
      });
    }
  }
  return entries;
}

async function downloadSubsidyPhotosArchive(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权下载国补照片');
  const order = await getSubsidyPhotoOrder(ctx.params.orderId, ctx.state.user);
  if (!order) ctx.throw(404, '订单不存在或无权访问');
  const entries = await subsidyPhotoZipEntries(order);
  if (!entries.length) ctx.throw(404, '没有可下载的国补照片');

  await recordBusinessAction({
    businessType: 'sales_order',
    businessId: order.order_id,
    businessNo: order.order_no,
    action: 'subsidy_photos_batch_downloaded',
    user: ctx.state.user,
    detail: { photoIds: entries.map(entry => entry.id), photoCount: entries.length }
  });

  ctx.type = 'application/zip';
  ctx.attachment(`${order.order_no || order.order_id}-国补照片.zip`);
  ctx.body = createSubsidyPhotoZip(entries);
}

async function downloadAllSubsidyPhotosArchive(ctx) {
  if (!userCanViewSubsidyPhotos(ctx.state.user)) ctx.throw(403, '无权下载国补照片');
  if (!hasSubsidyPhotoFilter(ctx.query)) ctx.throw(400, '不支持全量下载，请选择查询条件');
  const { where } = buildSubsidyPhotoQuery(ctx.state.user, ctx.query);
  const orders = await Order.findAll({
    where,
    // 批量下载只需要订单编号和照片元数据，不加载门店及其他订单字段，减少查询时间和内存占用。
    attributes: ['order_id', 'order_no', 'subsidy_photos'],
    order: [['create_time', 'DESC'], ['order_id', 'DESC']]
  });

  const entries = [];
  for (const order of orders) {
    const orderEntries = await subsidyPhotoZipEntries(order, subsidyPhotoFolderName(order));
    entries.push(...orderEntries);
  }
  if (!entries.length) ctx.throw(404, '当前查询结果没有可下载的国补照片');

  await Promise.all(orders.map(order => recordBusinessAction({
    businessType: 'sales_order',
    businessId: order.order_id,
    businessNo: order.order_no,
    action: 'subsidy_photos_batch_downloaded',
    user: ctx.state.user,
    detail: { photoCount: normalizeSubsidyPhotos(order.subsidy_photos).length, scope: 'query_result' }
  })));

  ctx.type = 'application/zip';
  ctx.attachment(`查询结果-国补照片-${getChinaDateString()}.zip`);
  ctx.body = createSubsidyPhotoZip(entries);
}

/**
 * 检查销售价格是否需要审批（价格从ProductPrice表读取）
 */
async function checkPriceApproval(items, totalAmount = 0, discountAmount = 0) {
  const normalizedItems = (items || []).map(item => applyOrderItemDefaults(normalizeOrderItemInput(item)));
  const productIds = [...new Set(normalizedItems.map(i => i.product_id).filter(Boolean))];
  if (productIds.length === 0) {
    return {
      belowPriceItems: [],
      minimumSalePriceTotal: 0,
      receivableBeforeSubsidy: Math.max(0, Number(totalAmount || 0) - Number(discountAmount || 0)),
      isBelowMinimum: false
    };
  }

  const productPrices = await ProductPrice.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const priceMap = new Map();
  productPrices.forEach(p => priceMap.set(p.product_id, p));

  const belowPriceItems = [];
  let minimumSalePriceTotal = 0;
  let hasMinimumSalePrice = normalizedItems.length > 0;
  for (const item of normalizedItems) {
    const price = priceMap.get(item.product_id);
    if (!price || !price.min_sale_price || parseFloat(price.min_sale_price) <= 0) {
      hasMinimumSalePrice = false;
      continue;
    }
    const minPrice = parseFloat(price.min_sale_price);
    minimumSalePriceTotal += minPrice * Math.max(1, Number(item.quantity || 1));
    if (parseFloat(item.sale_price) < minPrice) {
      belowPriceItems.push({
        productId: item.product_id,
        productName: item.product_name,
        salePrice: item.sale_price,
        standardPrice: price.standard_price,
        minSalePrice: price.min_sale_price
      });
    }
  }
  const receivableBeforeSubsidy = Math.max(0, Number(totalAmount || 0) - Number(discountAmount || 0));
  return {
    belowPriceItems,
    minimumSalePriceTotal,
    receivableBeforeSubsidy,
    isBelowMinimum: hasMinimumSalePrice && receivableBeforeSubsidy < minimumSalePriceTotal - 0.005
  };
}

function firstNonEmpty(source, keys, defaultValue = '') {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return typeof value === 'string' ? value.trim() : value;
    }
  }
  return defaultValue;
}

function normalizeAuxiliarySalesList(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.reduce((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const staffId = item.staffId ?? item.staff_id ?? item.id ?? '';
    const name = item.name ?? item.staffName ?? item.staff_name ?? item.selected ?? '';
    const key = staffId ? `id:${staffId}` : `name:${String(name).trim()}`;
    if (key === 'name:' || seen.has(key)) return result;
    seen.add(key);
    result.push({
      staffId: staffId === '' ? null : staffId,
      name: String(name || '').trim() || String(item.selected || '').trim(),
      selected: String(item.selected || name || '').trim()
    });
    return result;
  }, []);
}

function normalizeOrderExtendedFields(source = {}) {
  const fieldAliases = {
    customer_source_detail: ['customer_source_detail', 'customerSourceDetail'],
    auxiliary_sales_list: ['auxiliary_sales_list', 'auxiliarySalesList'],
    invoice_info: ['invoice_info', 'invoiceInfo'],
    invoice_amount: ['invoice_amount', 'invoiceAmount'],
    subsidy_status: ['subsidy_status', 'subsidyStatus'],
    subsidy_person: ['subsidy_person', 'subsidyPerson'],
    subsidy_id: ['subsidy_id', 'subsidyId'],
    subsidy_photos: ['subsidy_photos', 'subsidyPhotos'],
    product_photo_urls: ['product_photo_urls', 'productPhotoUrls'],
    education_subsidy_photo_url: ['education_subsidy_photo_url', 'educationSubsidyPhotoUrl'],
    education_subsidy_coupon_code: ['education_subsidy_coupon_code', 'educationSubsidyCouponCode'],
    education_subsidy_ocr_text: ['education_subsidy_ocr_text', 'educationSubsidyOcrText'],
    personal_info_photo: ['personal_info_photo', 'personalInfoPhoto']
  };
  const result = {};
  Object.entries(fieldAliases).forEach(([field, aliases]) => {
    const key = aliases.find(alias => Object.prototype.hasOwnProperty.call(source, alias));
    if (!key) return;
    if (field === 'invoice_amount') {
      result[field] = money(source[key]);
    } else if (field === 'auxiliary_sales_list') {
      result[field] = normalizeAuxiliarySalesList(source[key]);
    } else {
      result[field] = source[key];
    }
  });
  return result;
}

function toBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function pickOrderItemsPayload(data = {}) {
  const candidates = [
    data.items,
    data.goods,
    data.OrderItems,
    data.orderItems,
    data.order_items,
    data.productItems,
    data.saleItems,
    data.salesItems,
    data.itemList,
    data.goodsList,
    data.products
  ];
  return candidates.find(Array.isArray) || [];
}

function selectedResourcesFromJson(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeOrderItemInput(item = {}) {
  const rawSalePrice = firstNonEmpty(item, ['salePrice', 'sale_price', 'SALE_PRICE', 'unitPrice', 'unit_price', 'price'], null);
  const rawQuantity = firstNonEmpty(item, ['quantity', 'QUANTITY'], null);
  const rawSubtotal = firstNonEmpty(item, ['subtotal', 'SUBTOTAL'], null);
  const salePrice = rawSalePrice === null ? undefined : Number(rawSalePrice);
  const quantity = rawQuantity === null ? undefined : (Number(rawQuantity) || 1);
  const subtotal = rawSubtotal === null
    ? (salePrice !== undefined && quantity !== undefined ? salePrice * quantity : undefined)
    : Number(rawSubtotal);
  const snId = firstNonEmpty(item, ['snId', 'sn_id', 'SN_ID', 'inventoryId', 'inventory_id', 'INVENTORY_ID', 'inventorySnId', 'inventory_sn_id']);
  const snCode = firstNonEmpty(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn']);
  const rawResourceTypes = firstNonEmpty(item, ['selectedResourceTypes', 'selected_resource_types'], []);
  let selectedResourceTypes = selectedResourcesFromJson(rawResourceTypes);
  selectedResourceTypes = [...new Set(selectedResourceTypes.map(value => String(value || '').trim()).filter(Boolean))];

  return {
    item_id: firstNonEmpty(item, ['itemId', 'item_id', 'ITEM_ID', 'orderItemId', 'order_item_id', '_id', 'id']),
    product_id: firstNonEmpty(item, ['productId', 'product_id', 'PRODUCT_ID']),
    product_name: firstNonEmpty(item, ['productName', 'product_name', 'PRODUCT_NAME', 'name']),
    pn_code: firstNonEmpty(item, ['pnCode', 'pn_code', 'PN_CODE', 'pn', 'PN']),
    mtm_code: firstNonEmpty(item, ['mtmCode', 'mtm_code', 'MTM_CODE']),
    sn_id: snId,
    sn_code: snCode,
    supplier_id: firstNonEmpty(item, ['supplierId', 'supplier_id', 'SUPPLIER_ID']),
    supplier_name: firstNonEmpty(item, ['supplierName', 'supplier_name', 'SUPPLIER_NAME']),
    imei1: firstNonEmpty(item, ['imei1', 'imei_1', 'IMEI1']),
    imei2: firstNonEmpty(item, ['imei2', 'imei_2', 'IMEI2']),
    use_gov_subsidy: selectedResourceTypes.includes('GOV_SUBSIDY') || toBoolean(firstNonEmpty(item, ['useGovSubsidy', 'use_gov_subsidy'], false)),
    use_edu_subsidy: selectedResourceTypes.includes('EDU_SUBSIDY') || toBoolean(firstNonEmpty(item, ['useEduSubsidy', 'use_edu_subsidy'], false)),
    use_sales_report: selectedResourceTypes.includes('SALES_REPORT') || toBoolean(firstNonEmpty(item, ['useSalesReport', 'use_sales_report'], false)),
    selected_resource_types: selectedResourceTypes,
    sale_price: salePrice,
    quantity,
    subtotal
  };
}

function applyOrderItemDefaults(item) {
  const salePrice = Number(item.sale_price || 0);
  const quantity = Number(item.quantity || 1) || 1;
  const subtotal = item.subtotal === undefined || item.subtotal === null
    ? salePrice * quantity
    : Number(item.subtotal || 0);
  return Object.assign({}, item, {
    sale_price: salePrice,
    quantity,
    subtotal
  });
}

function compactUpdatePayload(payload) {
  const result = {};
  Object.keys(payload).forEach(key => {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      result[key] = value;
    }
  });
  return result;
}

async function syncOrderItemsFromPayload(order, data = {}, transaction = null) {
  const rawItems = pickOrderItemsPayload(data);
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const existingItems = await OrderItem.findAll({
    where: { order_id: order.order_id },
    order: [['item_id', 'ASC']],
    transaction
  });
  const existingById = new Map(existingItems.map(item => [String(item.item_id), item]));
  const results = [];
  let hasLockedResource = null;

  for (let index = 0; index < rawItems.length; index++) {
    const normalized = normalizeOrderItemInput(rawItems[index]);
    const existing = normalized.item_id
      ? existingById.get(String(normalized.item_id))
      : existingItems[index];
    if (!existing) continue;
    const snChanged = (normalized.sn_id && normalized.sn_id !== existing.sn_id) ||
      (normalized.sn_code && normalized.sn_code !== existing.sn_code);
    if (snChanged) {
      if (hasLockedResource === null) {
        hasLockedResource = await InventoryResourceRight.count({
          where: {
            current_status: 'LOCKED',
            locked_source_type: 'SALE_ORDER',
            locked_source_id: order.order_id
          },
          transaction
        }) > 0;
      }
      if (hasLockedResource) {
        throw Object.assign(new Error('该订单存在已锁定的SN资源权益，不能更换SN；请先取消订单后重新开单'), { status: 409 });
      }
    }

    const updatePayload = compactUpdatePayload({
      product_id: normalized.product_id,
      product_name: normalized.product_name,
      pn_code: normalized.pn_code,
      mtm_code: normalized.mtm_code,
      sn_id: normalized.sn_id,
      sn_code: normalized.sn_code,
      supplier_id: normalized.supplier_id,
      supplier_name: normalized.supplier_name,
      imei1: normalized.imei1,
      imei2: normalized.imei2,
      sale_price: normalized.sale_price,
      quantity: normalized.quantity,
      subtotal: normalized.subtotal
    });

    if (Object.keys(updatePayload).length === 0) continue;
    await existing.update(updatePayload, { transaction });
    results.push({
      item_id: existing.item_id,
      updated: updatePayload
    });
  }

  return results;
}

/**
 * 创建销售订单
 */
async function create(ctx) {
  const user = ctx.state.user;
  const requestBody = ctx.request.body || {};
  const {
    customerName, customerPhone, customerSource,
    items, payments = [], discountAmount = 0,
    nationalSubsidy = 0, educationSubsidy = 0,
    invoiceStatus = '不开票', remark, storeId, status, orderStatus, untaxedInvoiceConfirmed = false,
    saveDraft = false, orderId: requestedOrderId
  } = requestBody;
  const isDraft = Boolean(saveDraft);
  const extendedOrderFields = normalizeOrderExtendedFields(requestBody);
  if (extendedOrderFields.auxiliary_sales_list) {
    extendedOrderFields.auxiliary_sales_list = extendedOrderFields.auxiliary_sales_list.filter(item => (
      String(item.staffId || '') !== String(user.staffId)
    ));
  }

  if (!Array.isArray(items) || (!isDraft && items.length === 0)) {
    ctx.throw(400, '订单中没有商品');
  }
  if (!Array.isArray(payments)) {
    ctx.throw(400, '收款方式格式不正确');
  }

  let existingOrder = null;
  if (requestedOrderId) {
    existingOrder = await Order.findOne({ where: { order_id: requestedOrderId, is_deleted: 0 } });
    if (!existingOrder) ctx.throw(404, '销售订单不存在');
    assertStoreVisible(existingOrder.store_id, user);
    if (existingOrder.order_status !== 'draft') ctx.throw(400, '只有草稿状态的销售订单可以保存或提交');
    if (!canEditSalesDraft(user, existingOrder)) ctx.throw(403, '只有草稿创建人、店长或管理员可以编辑');
  }

  const orderNo = existingOrder?.order_no || generateOrderNo();
  const orderId = existingOrder?.order_id || generateUUID();
  const actualStoreId = existingOrder?.store_id || storeId || user.storeId || '';

  const normalizedItems = items.map(item => applyOrderItemDefaults(normalizeOrderItemInput(item)));
  const totalAmount = normalizedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  const payableBeforeDeposit = Math.max(0, money(totalAmount - Number(discountAmount) - Number(nationalSubsidy) - Number(educationSubsidy)));
  const depositDeductions = normalizeDepositDeductions(requestBody);
  if (!isDraft && depositDeductions.length > 1) {
    ctx.throw(400, '一张正式订单只能绑定一张定金单');
  }
  const depositDeductionTotal = money(depositDeductions.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const declaredDepositTotal = firstNonEmpty(requestBody, ['depositDeductionTotal', 'deposit_deduction_total'], null);
  if (!isDraft && declaredDepositTotal !== null && Math.abs(money(declaredDepositTotal) - depositDeductionTotal) > 0.01) {
    ctx.throw(400, '定金抵扣汇总与明细金额不一致');
  }
  if (!isDraft && depositDeductionTotal - payableBeforeDeposit > 0.01) {
    ctx.throw(400, '定金抵扣金额不能超过订单应付金额');
  }

  const actualPayment = Math.max(0, money(payableBeforeDeposit - depositDeductionTotal));
  const orderPayments = payments.filter(payment => !isDepositPayment(payment));
  const collectedPayments = orderPayments.filter(payment => !isPolicySubsidyReceivable(payment));
  if (!isDraft && actualPayment > 0 && collectedPayments.length === 0) {
    ctx.throw(400, '请填写收款方式');
  }
  const paymentTotal = money(collectedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  if (!isDraft && Math.abs(paymentTotal - actualPayment) > 0.01) {
    ctx.throw(400, '收款金额与订单实付金额不一致');
  }

  const priceApproval = isDraft
    ? { belowPriceItems: [], minimumSalePriceTotal: 0, receivableBeforeSubsidy: 0, isBelowMinimum: false }
    : await checkPriceApproval(items, totalAmount, discountAmount);
  const belowPriceItems = priceApproval.belowPriceItems;
  const needsApproval = priceApproval.isBelowMinimum;

  const productIds = [...new Set(normalizedItems.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const productMap = new Map();
  products.forEach(p => productMap.set(p.product_id, p));

  // 未归档订单允许先记录尚未进入商品主数据的 PN/SN。
  // 无效的商品/库存关联不写入外键，归档时再按 PN/SN 解析并校验。
  for (const item of normalizedItems) {
    if (!productMap.has(item.product_id)) item.product_id = null;
    item.sn_id = null;
  }

  if (!isDraft) {
    const missingSnItem = normalizedItems.find(item => {
      const product = productMap.get(item.product_id);
      return Number(product?.need_sn || 0) === 1 && !String(item.sn_code || '').trim();
    });
    if (missingSnItem) {
      ctx.throw(400, `商品 ${missingSnItem.product_name || missingSnItem.product_id || ''} 需要SN管理，请填写SN码`);
    }
  }

  const snItems = normalizedItems.filter(item => item.sn_id || item.sn_code);
  if (Number(nationalSubsidy) > 0 && !normalizedItems.some(item => item.use_gov_subsidy)) {
    // 创建阶段不因 SN 缺失或尚不存在而阻断；仅在唯一明确的 SN 行上预标记权益。
    if (snItems.length === 1) {
      snItems[0].use_gov_subsidy = true;
      snItems[0].selected_resource_types = [...new Set([...(snItems[0].selected_resource_types || []), 'GOV_SUBSIDY'])];
    }
  }
  if (Number(educationSubsidy) > 0 && !normalizedItems.some(item => item.use_edu_subsidy)) {
    if (snItems.length === 1) {
      snItems[0].use_edu_subsidy = true;
      snItems[0].selected_resource_types = [...new Set([...(snItems[0].selected_resource_types || []), 'EDU_SUBSIDY'])];
    }
  }
  if (!isDraft && invoiceStatus && invoiceStatus !== '不开票' && snItems.length) {
    const snWhere = snItems.map(item => item.sn_id ? { sn_id: item.sn_id } : { sn_code: item.sn_code, product_id: item.product_id });
    const selectedSns = await ProductSn.findAll({ where: { [Op.or]: snWhere, is_deleted: 0 } });
    if (selectedSns.some(sn => sn.tax_type === 'UNTAXED') && !untaxedInvoiceConfirmed) {
      ctx.throw(409, '该机器为未税库存，请确认是否允许开票销售');
    }
  }

  const finalOrderStatus = isDraft ? 'draft' : (status || orderStatus || (needsApproval ? 'pending_approval' : '未归档'));
  const previousOrderStatus = existingOrder?.order_status || null;
  const auditAction = isDraft ? (existingOrder ? 'draft_saved' : 'draft_created') : (existingOrder ? 'submitted' : 'created');
  const auditTime = new Date();

  await sequelize.transaction(async (transaction) => {
  let reservedDeposit = null;
  if (!isDraft && depositDeductions.length === 1) {
    reservedDeposit = await validateDepositReservation({
      payment: depositDeductions[0],
      user,
      customerPhone,
      payableBeforeDeposit,
      transaction
    });
  }

  const orderPayload = {
    order_id: orderId,
    order_no: orderNo,
    store_id: actualStoreId,
    create_staff_id: existingOrder?.create_staff_id || user.staffId,
    create_user: existingOrder?.create_user || user.name,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_source: customerSource,
    ...extendedOrderFields,
    total_amount: totalAmount,
    discount_amount: discountAmount,
    national_subsidy: nationalSubsidy,
    education_subsidy: educationSubsidy,
    deposit_deduction_total: depositDeductionTotal,
    deposit_items: depositDeductions,
    actual_payment: actualPayment,
    invoice_status: invoiceStatus,
    order_status: finalOrderStatus,
    inventory_reserved: isDraft ? 0 : 1,
    remark: remark || (needsApproval ? '售价低于定价, 待审批' : '')
  };
  if (!isDraft) {
    orderPayload.submit_user = user.name || user.phone || String(user.staffId || '');
    orderPayload.submit_time = auditTime;
  }
  if (existingOrder) {
    await existingOrder.update(orderPayload, { transaction });
    await OrderItem.destroy({ where: { order_id: orderId }, transaction });
    await OrderPayment.destroy({ where: { order_id: orderId }, transaction });
  } else {
    await Order.create(orderPayload, { transaction });
  }

  await recordBusinessAction({
    businessType: 'sales_order',
    businessId: orderId,
    businessNo: orderNo,
    action: auditAction,
    fromStatus: previousOrderStatus,
    toStatus: finalOrderStatus,
    user,
    transaction
  });

  for (const item of normalizedItems) {
    await OrderItem.create({
      order_id: orderId,
      product_id: item.product_id || null,
      product_name: item.product_name,
      pn_code: item.pn_code,
      sn_id: null,
      sn_code: item.sn_code,
      supplier_id: item.supplier_id || null,
      supplier_name: item.supplier_name || null,
      imei1: item.imei1,
      imei2: item.imei2,
      sale_price: item.sale_price,
      quantity: item.quantity || 1,
      subtotal: item.subtotal,
      use_gov_subsidy: item.use_gov_subsidy ? 1 : 0,
      use_edu_subsidy: item.use_edu_subsidy ? 1 : 0,
      use_sales_report: item.use_sales_report ? 1 : 0,
      selected_resource_types: JSON.stringify(item.selected_resource_types || [])
    }, { transaction });
  }

  for (const payment of orderPayments) {
    await OrderPayment.create({
      order_id: orderId,
      payment_method: payment.method,
      deposit_id: payment.depositId || payment.deposit_id || null,
      amount: payment.amount
    }, { transaction });
  }

  if (!isDraft) {
    const savedOrder = existingOrder || await Order.findByPk(orderId, { transaction });
    await reserveInventoryForOrder(savedOrder, transaction);
  }

  if (reservedDeposit) {
    await reserveDepositForOrder({
      deposit: reservedDeposit.deposit,
      orderId,
      orderNo,
      amount: reservedDeposit.amount,
      user,
      transaction
    });
  }

  });

  ctx.body = {
    orderId, orderNo,
    needsApproval,
    belowPriceItems,
    minimumSalePriceTotal: priceApproval.minimumSalePriceTotal,
    receivableBeforeSubsidy: priceApproval.receivableBeforeSubsidy,
    status: finalOrderStatus,
    message: isDraft ? '销售订单草稿已保存' : (needsApproval ? '订单已创建，售价低于定价需要审批' : '订单创建成功')
  };
}

function canEditSalesDraft(user, order) {
  const roles = getUserRoles(user);
  const privileged = roles.some(role => ['boss', 'admin', 'manager', 'store_manager'].includes(role));
  return privileged || String(user?.staffId || '') === String(order.create_staff_id || '') || String(user?.name || '') === String(order.create_user || '');
}

async function saveSalesDraft(ctx) {
  ctx.request.body = { ...(ctx.request.body || {}), saveDraft: true };
  return create(ctx);
}

async function updateSalesDraft(ctx) {
  ctx.request.body = { ...(ctx.request.body || {}), saveDraft: true, orderId: ctx.params.orderId };
  return create(ctx);
}

async function submitSalesDraft(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;
  const order = await Order.findOne({
    where: { order_id: orderId, is_deleted: 0 },
    include: [{ model: OrderItem }, { model: OrderPayment }]
  });
  if (!order) ctx.throw(404, '销售订单不存在');
  assertStoreVisible(order.store_id, user);
  if (order.order_status !== 'draft') ctx.throw(400, '只有草稿状态的销售订单可以提交');
  if (!canEditSalesDraft(user, order)) ctx.throw(403, '只有草稿创建人、店长或管理员可以提交');

  const orderJson = order.toJSON();
  const parseJson = value => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try { return JSON.parse(value); } catch (_) { return []; }
  };
  const draftPayments = (orderJson.OrderPayments || []).map(payment => ({
    method: payment.payment_method,
    amount: payment.amount,
    depositId: payment.deposit_id || undefined
  }));
  const depositItems = parseJson(order.deposit_items);
  if (depositItems.length > 0) {
    draftPayments.push({
      method: '定金',
      amount: depositItems[0].amount,
      depositId: depositItems[0].depositId || depositItems[0].deposit_id || undefined
    });
  }
  ctx.request.body = {
    orderId: order.order_id,
    storeId: order.store_id,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerSource: order.customer_source,
    invoiceStatus: order.invoice_status || '不开票',
    items: (orderJson.OrderItems || []).map(item => ({
      productId: item.product_id,
      productName: item.product_name,
      pnCode: item.pn_code,
      snCode: item.sn_code,
      snId: item.sn_id,
      supplierId: item.supplier_id,
      supplierName: item.supplier_name,
      salePrice: item.sale_price,
      quantity: item.quantity,
      subtotal: item.subtotal,
      useGovSubsidy: item.use_gov_subsidy,
      useEduSubsidy: item.use_edu_subsidy,
      useSalesReport: item.use_sales_report,
      selectedResourceTypes: parseJson(item.selected_resource_types)
    })),
    payments: draftPayments,
    nationalSubsidy: order.national_subsidy,
    educationSubsidy: order.education_subsidy,
    discountAmount: order.discount_amount,
    remark: order.remark
  };
  return create(ctx);
}

async function deleteSalesDraft(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;
  const order = await Order.findOne({ where: { order_id: orderId, is_deleted: 0 } });
  if (!order) ctx.throw(404, '销售订单不存在');
  assertStoreVisible(order.store_id, user);
  if (order.order_status !== 'draft' || order.submit_time) ctx.throw(400, '只有从未提交过的销售订单草稿可以删除');
  if (!canEditSalesDraft(user, order)) ctx.throw(403, '只有草稿创建人、店长或管理员可以删除');
  await order.update({ is_deleted: 1, update_time: new Date() });
  await recordBusinessAction({
    businessType: 'sales_order',
    businessId: order.order_id,
    businessNo: order.order_no,
    action: 'deleted',
    fromStatus: 'draft',
    toStatus: 'deleted',
    user
  });
  ctx.body = { code: 0, message: '销售订单草稿已删除', orderId };
}

/**
 * 订单详情
 */
async function detail(ctx) {
  const { orderId } = ctx.params;

  const order = await Order.findByPk(orderId, {
    include: [
      { model: Store },
      {
        model: Staff,
        as: 'Applicant',
        attributes: ['staff_id', 'name', 'role_code', 'store_id', 'distributor_id'],
        required: false,
        include: [
          { model: Store, as: 'Store', attributes: ['store_id', 'name'], required: false },
          { model: Distributor, attributes: ['distributor_id', 'name'], required: false }
        ]
      },
      { model: OrderItem, include: [{ model: Product, attributes: ['product_id', 'need_sn'] }] },
      { model: OrderPayment, include: [{ model: DepositOrder }] },
      { model: OrderSupplement, as: 'supplements', where: { is_deleted: 0 }, required: false },
      { model: DepositRedemption, as: 'depositRedemptions' },
      { model: OrderAttachment }
    ]
  });

  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  assertSalesOrderVisible(order.store_id, ctx.state.user, order.Store?.distributor_id);
  if (String(ctx.query.trace || '') === '1') {
    const orderData = order.toJSON();
    if (!canViewSnTraceReference(ctx.state.user, {
      store_id: order.store_id,
      distributor_id: orderData.Store?.distributor_id,
      creator_names: [order.create_user]
    })) {
      ctx.throw(403, '无权查看该销售原始订单');
    }
  }

  const result = order.toJSON();
  const items = result.OrderItems || [];
  const snCodes = items.map(item => item.sn_code).filter(Boolean);
  if (snCodes.length > 0) {
    const snRows = await ProductSn.findAll({
      where: { sn_code: { [Op.in]: snCodes } },
      attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type', 'tax_type', 'status'],
      raw: true
    });
    const snMap = new Map(snRows.map(sn => [`${sn.pn_code || ''}|${sn.sn_code}`, sn]));
    const summaryMap = await summariesForSns(snRows);
    result.OrderItems = items.map(item => {
      const sn = snMap.get(`${item.pn_code || ''}|${item.sn_code}`) || snRows.find(row => row.sn_code === item.sn_code);
      return {
        ...item,
        pn_code: item.pn_code || sn?.pn_code || '',
        sn_code: item.sn_code || '',
        inventory_type: item.inventory_type || sn?.inventory_type || '',
        inventory_status: item.inventory_status || sn?.status || '',
        inventory_status_label: sn?.status === 'reserved' || sn?.status === 'occupied'
          ? '已占用'
          : (sn?.status === 'sold' ? '已销售' : (sn?.status || '')),
        resource_summary: sn ? summaryMap.get(sn.sn_id) : null
      };
    });
  }
  if (!canSeeCost(ctx.state.user)) {
    result.OrderItems = (result.OrderItems || items).map(item => {
      const sanitized = { ...item };
      delete sanitized.original_inventory_cost;
      delete sanitized.original_pickup_price;
      delete sanitized.current_pickup_price_at_sale;
      return sanitized;
    });
  }

  result.action_logs = await listBusinessActions('sales_order', order.order_id);

  ctx.body = result;
}

/**
 * 审批通过
 */
async function approve(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!getUserRoles(user).some(role => allowedRoles.includes(role))) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  assertStoreVisible(order.store_id, user);
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  const previousStatus = order.order_status;
  const approveTime = new Date();
  await sequelize.transaction(async (transaction) => {
    await order.update({
      order_status: '未归档',
      approve_user: user.name || user.phone || String(user.staffId || ''),
      approve_time: approveTime,
      approve_comment: '审批通过',
      remark: (order.remark || '') + '\n已审批通过',
      update_time: approveTime
    }, { transaction });
    await recordBusinessAction({
      businessType: 'sales_order',
      businessId: order.order_id,
      businessNo: order.order_no,
      action: 'approved',
      fromStatus: previousStatus,
      toStatus: '未归档',
      user,
      comment: '审批通过',
      transaction
    });
  });

  ctx.body = { code: 0, message: '审批通过，订单待归档' };
}

/**
 * 审批拒绝
 */
async function reject(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!getUserRoles(user).some(role => allowedRoles.includes(role))) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  assertStoreVisible(order.store_id, user);
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  const { reason } = ctx.request.body;
  const previousStatus = order.order_status;

  await sequelize.transaction(async (transaction) => {
    const approveTime = new Date();
    if (order.inventory_reserved) {
      await releaseReservedInventoryForOrder(order, transaction);
    }
    const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
    await releaseSaleRights(order, items, transaction);
    await releaseDepositRedemptionForOrder(order, transaction, '订单审批拒绝');
    await order.update({
      order_status: 'cancelled',
      inventory_reserved: 0,
      approve_user: user.name || user.phone || String(user.staffId || ''),
      approve_time: approveTime,
      approve_comment: reason || '',
      remark: (order.remark || '') + '\n审批拒绝: ' + (reason || '无'),
      update_time: approveTime
    }, { transaction });
    await recordBusinessAction({
      businessType: 'sales_order',
      businessId: order.order_id,
      businessNo: order.order_no,
      action: 'rejected',
      fromStatus: previousStatus,
      toStatus: 'cancelled',
      user,
      comment: reason || '',
      transaction
    });
  });

  ctx.body = { code: 0, message: '已拒绝' };
}

/**
 * 更新订单
 */
async function update(ctx) {
  const { orderId } = ctx.params;
  const data = Object.assign({}, ctx.request.body, normalizeOrderExtendedFields(ctx.request.body || {}));

  const order = await Order.findByPk(orderId);
  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  assertStoreVisible(order.store_id, ctx.state.user);
  if (data.auxiliary_sales_list) {
    data.auxiliary_sales_list = data.auxiliary_sales_list.filter(item => (
      String(item.staffId || '') !== String(order.create_staff_id || '')
    ));
  }

  const nextStatus = data.order_status || data.status;
  const previousStatus = order.order_status;
  let archivedNow = false;
  await sequelize.transaction(async (transaction) => {
    await syncOrderItemsFromPayload(order, data, transaction);

    if (isArchiveStatus(nextStatus) && !isArchiveStatus(order.order_status)) {
      await validateAndDeductInventoryForArchive(order, transaction);
      await redeemReservedDepositsForOrder(order, transaction);
      const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await lockSaleRights(order, items, transaction);
      await finishSaleRights(order, items, transaction);
      await calculateSalesSettlementCosts(order, transaction);
      const refreshedItems = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await triggerSaleResourceBenefits(order, refreshedItems, transaction);
      data.order_status = '已归档';
      data.status = '已归档';
      data.inventory_reserved = 0;
      archivedNow = true;
    } else if (isCancelStatus(nextStatus) && !isCancelStatus(order.order_status)) {
      if (order.inventory_reserved) {
        await releaseReservedInventoryForOrder(order, transaction);
      }
      const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await releaseSaleRights(order, items, transaction);
      await releaseDepositRedemptionForOrder(order, transaction, '订单取消');
      data.inventory_reserved = 0;
    }

    await order.update(data, { transaction });
    const statusAfterUpdate = order.order_status;
    if (statusAfterUpdate !== previousStatus) {
      await recordBusinessAction({
        businessType: 'sales_order',
        businessId: order.order_id,
        businessNo: order.order_no,
        action: archivedNow ? 'archived' : isCancelStatus(statusAfterUpdate) ? 'cancelled' : 'status_updated',
        fromStatus: previousStatus,
        toStatus: statusAfterUpdate,
        user: ctx.state.user,
        transaction
      });
    }
    if (archivedNow) {
      await calculateAndSaveOrderGrossProfit(order.order_id, {
        transaction,
        calculatedBy: ctx.state.user?.name || 'system',
        force: true,
        final: true
      });
    } else {
      const affectsGrossProfit = [
        'invoice_amount', 'invoiceAmount', 'order_status', 'status'
      ].some(key => data[key] !== undefined);
      const existingGrossProfit = affectsGrossProfit
        ? await OrderGrossProfit.findOne({
            where: { order_id: order.order_id },
            transaction
          })
        : null;
      if (existingGrossProfit) {
        await calculateAndSaveOrderGrossProfit(order.order_id, {
          transaction,
          calculatedBy: ctx.state.user?.name || 'system',
          force: true,
          final: isArchiveStatus(data.order_status || order.order_status)
        });
      }
    }
  });
  if (archivedNow) {
    syncToDailyStatement(orderId, order.store_id).catch(err => console.error('[DailySync] archive error:', err.message));
  }
  ctx.body = { message: '订单更新成功' };
}

async function getGrossProfit(ctx) {
  const { orderId } = ctx.params;
  if (!canSeeCost(ctx.state.user)) {
    ctx.throw(403, '无权查看订单毛利');
  }
  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  const store = await Store.findByPk(order.store_id, { attributes: ['store_id', 'distributor_id'] });
  assertSalesOrderVisible(order.store_id, ctx.state.user, store?.distributor_id);

  const snapshot = await calculateAndSaveOrderGrossProfit(orderId, {
    calculatedBy: ctx.state.user?.name || 'system'
  });
  ctx.body = { code: 0, data: snapshotToResponse(snapshot, order) };
}

async function updateSupplements(ctx) {
  const { orderId } = ctx.params;
  const supplements = ctx.request.body?.supplements;
  if (!Array.isArray(supplements)) ctx.throw(400, '补录数据格式不正确');
  if (supplements.length > 50) ctx.throw(400, '单笔订单最多保存50条补录记录');

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  assertStoreVisible(order.store_id, ctx.state.user);

  const normalized = [];
  for (const item of supplements) {
    const itemId = item.itemId || item.item_id || '';
    const itemName = String(item.itemName || item.item_name || '').trim();
    const amount = money(item.amount);
    if (!itemName) ctx.throw(400, '补录项目名称不能为空');
    if (amount <= 0) ctx.throw(400, `补录项目“${itemName}”金额必须大于0`);

    const dictionaryItem = itemId
      ? await SupplementItem.findByPk(itemId)
      : await SupplementItem.findOne({ where: { name: itemName } });
    if (!dictionaryItem) ctx.throw(400, `补录项目“${itemName}”不存在`);
    normalized.push({
      supplement_id: generateUUID(),
      order_id: order.order_id,
      item_id: dictionaryItem.item_id,
      item_name: dictionaryItem.name,
      amount,
      amount_type: dictionaryItem.amount_type === 'decrease' ? 'decrease' : 'increase',
      content: String(item.content || '').trim().slice(0, 500),
      proof_photo_url: String(item.proofPhotoUrl || item.proof_photo_url || '').trim().slice(0, 1024),
      coupon_code: String(item.couponCode || item.coupon_code || '').trim().slice(0, 128),
      coupon_ocr_text: String(item.couponOcrText || item.coupon_ocr_text || '').trim(),
      create_staff_id: ctx.state.user?.staffId || null,
      create_user: ctx.state.user?.name || '',
      create_time: new Date(),
      update_time: new Date(),
      is_deleted: 0
    });
  }

  let snapshot;
  await sequelize.transaction(async transaction => {
    await OrderSupplement.update(
      { is_deleted: 1, update_time: new Date() },
      { where: { order_id: order.order_id, is_deleted: 0 }, transaction }
    );
    if (normalized.length) {
      await OrderSupplement.bulkCreate(normalized, { transaction });
    }
    snapshot = await calculateAndSaveOrderGrossProfit(order.order_id, {
      transaction,
      calculatedBy: ctx.state.user?.name || 'system',
      force: true,
      final: isArchiveStatus(order.order_status)
    });
  });

  ctx.body = {
    code: 0,
    message: '金额补录已保存',
    data: {
      supplements: normalized.map(item => ({
        supplementId: item.supplement_id,
        itemId: item.item_id,
        itemName: item.item_name,
        amount: item.amount,
        amountType: item.amount_type,
        content: item.content,
        proofPhotoUrl: item.proof_photo_url,
        couponCode: item.coupon_code,
        couponOcrText: item.coupon_ocr_text
      })),
      grossProfit: snapshotToResponse(snapshot, order)
    }
  };
}

async function updateOrderItems(ctx) {
  const data = ctx.request.body || {};
  const orderNo = firstNonEmpty(data, ['orderNo', 'order_no', 'ORDER_NO']);
  const orderId = firstNonEmpty(data, ['orderId', 'order_id', 'ORDER_ID']);

  const where = orderId ? { order_id: orderId } : { order_no: orderNo };
  if (!orderId && !orderNo) {
    ctx.throw(400, '订单编号不能为空');
  }

  const order = await Order.findOne({ where });
  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  assertStoreVisible(order.store_id, ctx.state.user);

  let results = [];
  await sequelize.transaction(async (transaction) => {
    results = await syncOrderItemsFromPayload(order, data, transaction);
  });

  ctx.body = {
    code: 0,
    message: '订单明细更新成功',
    data: {
      orderId: order.order_id,
      orderNo: order.order_no,
      results
    }
  };
}

/**
 * 销售统计
 */
async function stats(ctx) {
  const { storeId, startDate, endDate } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const where = {
    is_deleted: 0,
    store_id: storeIds
  };

  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  const statsByStore = await Order.findAll({
    where,
    attributes: [
      'store_id',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment']
    ],
    include: [{ model: Store, attributes: ['name'] }],
    group: ['store_id'],
    raw: true
  });

  ctx.body = { statsByStore };
}

/**
 * 获取支付方式列表
 */
async function paymentMethods(ctx) {
  const methods = await PaymentMethod.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: methods, message: 'success' };
}

async function listDeposits(ctx) {
  const { storeId, status, customerPhone, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const where = { is_deleted: 0 };

  if (status) where.status = status;
  if (customerPhone) where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  if (storeId) {
    where.store_id = storeId;
  } else if (!user.accessibleStoreIds.includes('*')) {
    where.store_id = user.accessibleStoreIds;
  }

  const { count, rows } = await DepositOrder.findAndCountAll({
    where,
    include: [{ model: Store }],
    distinct: true,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'DepositOrder.status',
      pendingStatuses: ['submitted'],
      dateColumns: ['DepositOrder.create_time'],
      idColumn: 'DepositOrder.deposit_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function createDeposit(ctx) {
  const user = ctx.state.user;
  const {
    storeId, store_id,
    customerName, customerPhone, customerSource,
    amount, remark,
    paymentMethod, payment_method
  } = ctx.request.body;
  const actualStoreId = storeId || store_id || user.storeId || '';
  const depositAmount = money(amount);
  const actualPaymentMethod = String(paymentMethod || payment_method || '').trim();

  if (!actualStoreId) ctx.throw(400, '请选择门店');
  if (!customerName || !customerPhone) ctx.throw(400, '请填写客户信息');
  if (depositAmount <= 0) ctx.throw(400, '定金金额必须大于0');
  if (!actualPaymentMethod) ctx.throw(400, '请选择收款方式');
  if (isDepositPayment({ method: actualPaymentMethod }) || isPolicySubsidyReceivable({ method: actualPaymentMethod })) {
    ctx.throw(400, '定金收款不能使用定金抵扣或政策补贴应收');
  }

  const paymentMethodRecord = await PaymentMethod.findOne({
    where: { name: actualPaymentMethod, status: 1 }
  });
  if (!paymentMethodRecord) ctx.throw(400, '收款方式不存在或已停用');

  if (Number(paymentMethodRecord.is_global) !== 1) {
    const { PaymentMethodStore } = require('../../models');
    const storeConfig = await PaymentMethodStore.findOne({
      where: { method_id: paymentMethodRecord.method_id, store_id: actualStoreId }
    });
    if (!storeConfig) ctx.throw(400, '该门店未配置此收款方式');
  }

  const depositId = generateUUID();
  const depositNo = generateBusinessNo('DEP');

  await sequelize.transaction(async transaction => {
    await DepositOrder.create({
      deposit_id: depositId,
      deposit_no: depositNo,
      store_id: actualStoreId,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_source: customerSource || '',
      amount: depositAmount,
      payment_method: actualPaymentMethod,
      redeemed_amount: 0,
      refunded_amount: 0,
      status: 'available',
      remark: remark || '',
      create_staff_id: user.staffId,
      create_user: user.name
    }, { transaction });

    await syncDepositToDailyStatement({
      depositId,
      depositNo,
      storeId: actualStoreId,
      customerName,
      paymentMethod: actualPaymentMethod,
      amount: depositAmount
    }, transaction);
  });

  ctx.body = { depositId, depositNo, status: 'available', message: '定金已存入客户定金库' };
}

async function archiveDeposit(ctx) {
  const { depositId } = ctx.params;
  const user = ctx.state.user;

  if (!depositId) ctx.throw(400, '缺少定金单ID');
  const deposit = await DepositOrder.findOne({ where: { deposit_id: depositId, is_deleted: 0 } });
  if (!deposit) ctx.throw(404, '定金单不存在');
  assertDepositStoreVisible(deposit, user);
  if (deposit.status !== 'submitted') {
    ctx.throw(400, '只有已提交的定金单可以归档');
  }

  await deposit.update({
    status: 'archived',
    archive_user: user.name,
    archive_time: new Date(),
    update_time: new Date()
  });

  ctx.body = { message: '定金单已归档' };
}

async function refundDeposit(ctx) {
  const { depositId } = ctx.params;
  const user = ctx.state.user;
  const { amount, reason } = ctx.request.body || {};

  if (!depositId) ctx.throw(400, '缺少定金单ID');
  await sequelize.transaction(async (transaction) => {
    const deposit = await DepositOrder.findOne({
      where: { deposit_id: depositId, is_deleted: 0 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!deposit) ctx.throw(404, '定金单不存在');
    assertDepositStoreVisible(deposit, user);
    assertDepositCreator(deposit, user, '只能退款自己收的定金单');
    if (!['submitted', 'available', 'archived'].includes(deposit.status)) {
      ctx.throw(400, '只有未核销的定金单可以退款');
    }

    const availableAmount = getDepositAvailableAmount(deposit);
    const refundAmount = amount === undefined || amount === null || amount === ''
      ? availableAmount
      : money(amount);
    if (refundAmount <= 0) ctx.throw(400, '退款金额必须大于0');
    if (Math.abs(refundAmount - availableAmount) > 0.01) {
      ctx.throw(400, '定金当前只支持全额退款记录');
    }

    await DepositRefund.create({
      refund_id: generateUUID(),
      refund_no: generateBusinessNo('DRF'),
      deposit_id: deposit.deposit_id,
      amount: refundAmount,
      reason: reason || '',
      create_staff_id: user.staffId,
      create_user: user.name
    }, { transaction });

    await deposit.update({
      refunded_amount: refundAmount,
      status: 'refunded',
      update_time: new Date()
    }, { transaction });
  });

  ctx.body = { message: '定金退款记录已生成' };
}

async function availableDeposits(ctx) {
  const user = ctx.state.user;
  const { customerPhone, storeId } = ctx.query;
  const where = {
    is_deleted: 0,
    status: { [Op.in]: ['submitted', 'available', 'archived'] },
    create_staff_id: user.staffId
  };
  if (customerPhone) where.customer_phone = customerPhone;
  if (storeId) where.store_id = storeId;
  else if (!user.accessibleStoreIds.includes('*')) where.store_id = user.accessibleStoreIds;

  const rows = await DepositOrder.findAll({
    where,
    order: [['create_time', 'DESC']]
  });

  const availableRows = rows
    .filter(row => getDepositAvailableAmount(row) > 0)
    .map(row => ({
      ...row.toJSON(),
      available_amount: getDepositAvailableAmount(row)
    }));

  ctx.body = { code: 0, data: availableRows, message: 'success' };
}

async function getProductPns(ctx) {
  const { storeId, productId } = ctx.params;
  const product = await Product.findByPk(productId);
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  if (product.need_sn === 1) {
    const snRecords = await ProductSn.findAll({
      where: {
        product_id: productId,
        store_id: storeId,
        status: 'in_stock',
        is_deleted: 0
      },
      attributes: ['pn_code'],
      group: ['pn_code'],
      raw: true
    });
    ctx.body = { code: 0, data: snRecords.map(s => s.pn_code).filter(Boolean) };
    return;
  }

  const inv = storeId ? await Inventory.findOne({ where: { product_id: productId, store_id: storeId } }) : null;
  const normalStock = inv ? Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  ) : 0;
  const totalStock = inv ? normalStock + Number(inv.display_qty || 0) : 0;
  if (totalStock <= 0) {
    ctx.body = { code: 0, data: [] };
    return;
  }

  const pnRecords = await ProductPn.findAll({
    where: { product_id: productId, is_deleted: 0 },
    attributes: ['pn_code'],
    order: [['pn_code', 'ASC']],
    raw: true
  });
  const allPnCodes = new Set((product.manufacturer_code || '').split(/[,\s，、]+/).filter(Boolean));
  for (const pn of pnRecords) {
    if (pn.pn_code) allPnCodes.add(pn.pn_code);
  }

  ctx.body = { code: 0, data: [...allPnCodes] };
}

async function getProductSns(ctx) {
  const { storeId, productId } = ctx.params;
  const { pnCode } = ctx.query;
  assertStoreVisible(storeId, ctx.state.user);

  const where = {
    product_id: productId,
    store_id: storeId,
    status: 'in_stock',
    is_deleted: 0,
    inventory_type: { [Op.ne]: 'rental_demo_qty' }
  };
  if (pnCode) {
    where.pn_code = pnCode;
  }

  const snRecords = await ProductSn.findAll({
    where,
    attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type', 'tax_type', 'supplier_id', 'supplier_name', 'location_id'],
    order: [['sn_code', 'ASC']]
  });
  const saleableSnRecords = [];
  for (const sn of snRecords) {
    if (!(await isRentalDemoSn(sn))) saleableSnRecords.push(sn);
  }

  const store = await Store.findOne({
    where: { store_id: storeId, is_deleted: 0 },
    attributes: ['store_id', 'distributor_id'],
    raw: true
  });
  if (!store) ctx.throw(404, '门店不存在');
  const productPrice = await ProductPrice.findOne({
    where: { product_id: productId, status: 1 },
    attributes: ['standard_price', 'min_sale_price'],
    raw: true
  });
  const snIds = saleableSnRecords.map(row => row.sn_id);
  const specialPrices = snIds.length > 0 && store.distributor_id
    ? await SnDistributorPrice.findAll({
      where: {
        sn_id: { [Op.in]: snIds },
        distributor_id: store.distributor_id,
        status: 1
      },
      attributes: ['sn_id', 'special_price', 'remark'],
      raw: true
    })
    : [];
  const specialPriceMap = new Map(specialPrices.map(row => [row.sn_id, row]));
  const unifiedSalePrice = Number(productPrice?.standard_price || 0);
  const minSalePrice = Number(productPrice?.min_sale_price || 0);
  const summaryMap = await summariesForSns(saleableSnRecords);
  ctx.body = {
    code: 0,
    data: saleableSnRecords.map(s => {
      const special = specialPriceMap.get(s.sn_id);
      const specialPrice = special ? Number(special.special_price || 0) : null;
      return {
        sn_id: s.sn_id,
        sn_code: s.sn_code,
        pn_code: s.pn_code,
        inventory_type: s.inventory_type,
        supplier_id: s.supplier_id || '',
        supplier_name: s.supplier_name || '',
        unified_sale_price: unifiedSalePrice,
        min_sale_price: minSalePrice,
        special_price: specialPrice,
        is_special_price: Boolean(special),
        effective_sale_price: specialPrice > 0 ? specialPrice : unifiedSalePrice,
        special_price_remark: special?.remark || '',
        ...summaryMap.get(s.sn_id)
      };
    })
  };
}

async function recalculateSettlementCost(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;
  const roles = getUserRoles(user);
  if (!roles.some(role => ['boss', 'admin', 'finance'].includes(role))) {
    ctx.throw(403, '无权重算销售结算成本');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (!isArchiveStatus(order.order_status)) {
    ctx.throw(400, '只有已归档订单可以重算销售结算成本');
  }

  await sequelize.transaction(async (transaction) => {
    await calculateSalesSettlementCosts(order, transaction, { force: true });
    await order.update({ update_time: new Date() }, { transaction });
    await calculateAndSaveOrderGrossProfit(order.order_id, {
      transaction,
      calculatedBy: user?.name || 'system',
      force: true,
      final: true
    });
  });

  ctx.body = { code: 0, message: '销售结算成本已重算' };
}

function isArchiveStatus(status) {
  return ['已归档', 'completed', 'archived'].includes(String(status || ''));
}

function archiveError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function money(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

function generateBusinessNo(prefix) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `${prefix}${yyyy}${mm}${dd}${hh}${mi}${ss}${random}`;
}

function pickReturnItemQuantity(item, sourceItem, defaultQuantity = Number(sourceItem.quantity || 1)) {
  const value = item?.quantity ?? item?.returnQuantity ?? item?.return_quantity;
  if (value === undefined || value === null || value === '') return defaultQuantity;
  const quantity = Math.floor(Number(value));
  return Number.isFinite(quantity) ? Math.min(Math.max(quantity, 0), Number(sourceItem.quantity || 1)) : 0;
}

/**
 * 销售退单申请列表
 */
async function listSalesReturnRequests(ctx) {
  const { status, approvalStage, storeId, orderId, page = 1, pageSize = 100 } = ctx.query;
  const where = {};
  if (status) where.status = status;
  if (approvalStage) where.approval_stage = approvalStage;
  if (storeId) where.store_id = storeId;
  if (orderId) where.order_id = orderId;
  if (storeId) assertStoreVisible(storeId, ctx.state.user);
  if (!ctx.state.user.accessibleStoreIds.includes('*') && !storeId) {
    where.store_id = ctx.state.user.accessibleStoreIds;
  }

  const { count, rows } = await SalesReturnRequest.findAndCountAll({
    where,
    include: [{ model: SalesReturnRequestItem, as: 'items' }],
    order: [['create_time', 'DESC'], ['return_id', 'DESC']],
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 为已归档销售订单创建退单申请。
 * 申请阶段只改变订单状态，不直接扣库存或执行退款；审批完成后的执行流程另行处理。
 */
async function requestSalesReturn(ctx) {
  const { orderId: bodyOrderId, reason = '', items: requestedItems } = ctx.request.body || {};
  const orderId = ctx.params.orderId || bodyOrderId;
  const user = ctx.state.user;
  if (!orderId) ctx.throw(400, '订单ID不能为空');

  const result = await sequelize.transaction(async transaction => {
    const order = await Order.findByPk(orderId, {
      include: [{ model: OrderItem }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!order) ctx.throw(404, '订单不存在');
    assertStoreVisible(order.store_id, user);
    if (!isArchiveStatus(order.order_status)) {
      ctx.throw(400, '只有已归档订单才能提交退单申请');
    }

    const activeRequest = await SalesReturnRequest.findOne({
      where: { order_id: order.order_id, status: { [Op.in]: ['pending', 'approved'] } },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (activeRequest) ctx.throw(409, '该订单已有待处理的退单申请');

    const orderItems = order.OrderItems || [];
    if (orderItems.length === 0) ctx.throw(400, '订单没有商品明细，无法提交退单申请');
    const requested = Array.isArray(requestedItems) ? requestedItems : [];
    const hasExplicitItems = requested.length > 0;
    const completedReturns = await SalesReturnRequest.findAll({
      where: { order_id: order.order_id, status: 'completed' },
      include: [{ model: SalesReturnRequestItem, as: 'items' }],
      transaction
    });
    const returnedQuantityByItemId = new Map();
    completedReturns.forEach(completedReturn => {
      (completedReturn.items || []).forEach(item => {
        const key = String(item.order_item_id || '');
        returnedQuantityByItemId.set(key, (returnedQuantityByItemId.get(key) || 0) + Number(item.quantity || 0));
      });
    });
    const requestedById = new Map(requested.map(item => [String(item.itemId || item.item_id || item.orderItemId || item.order_item_id || item.id || ''), item]));
    const selectedItems = orderItems.map(sourceItem => {
      const item = requestedById.get(String(sourceItem.item_id)) || requested.find(candidate => {
        const candidateSn = String(candidate.snCode || candidate.sn_code || '');
        const candidatePn = String(candidate.pnCode || candidate.pn_code || '');
        return (candidateSn || candidatePn) &&
          candidateSn === String(sourceItem.sn_code || '') &&
          candidatePn === String(sourceItem.pn_code || '');
      });
      const requestedQuantity = hasExplicitItems
        ? pickReturnItemQuantity(item, sourceItem, 0)
        : pickReturnItemQuantity(item, sourceItem);
      const returnedQuantity = returnedQuantityByItemId.get(String(sourceItem.item_id)) || 0;
      const remainingQuantity = Math.max(Number(sourceItem.quantity || 0) - returnedQuantity, 0);
      if (requestedQuantity > remainingQuantity) {
        ctx.throw(400, `商品 ${sourceItem.product_name || sourceItem.product_id} 可退数量仅剩 ${remainingQuantity}`);
      }
      const quantity = requestedQuantity;
      return { sourceItem, quantity };
    }).filter(row => row.quantity > 0);
    if (selectedItems.length === 0) ctx.throw(400, '退单商品明细不能为空');

    const maxRefundAmount = money(order.actual_payment || order.total_amount || 0);
    const requestedRefund = ctx.request.body?.refundAmount ?? ctx.request.body?.refund_amount;
    const refundAmount = requestedRefund === undefined || requestedRefund === null || requestedRefund === ''
      ? maxRefundAmount
      : Math.min(Math.max(money(requestedRefund), 0), maxRefundAmount);
    const returnId = generateUUID();
    const returnNo = generateBusinessNo('RET');

    const selectedQuantity = selectedItems.reduce((sum, row) => sum + row.quantity, 0);
    const orderQuantity = orderItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const returnType = selectedQuantity < orderQuantity ? 'partial' : 'full';
    await SalesReturnRequest.create({
      return_id: returnId,
      return_no: returnNo,
      order_id: order.order_id,
      order_no: order.order_no,
      store_id: order.store_id,
      customer_name: order.customer_name || '',
      customer_phone: order.customer_phone || '',
      return_type: returnType,
      refund_amount: refundAmount,
      reason: String(reason || '').trim() || '客户退单',
      status: 'pending',
      approval_stage: 'pending_store',
      create_staff_id: user.staffId || null,
      create_user: user.name || user.staffId || '',
      create_time: new Date(),
      update_time: new Date()
    }, { transaction });

    for (const { sourceItem, quantity } of selectedItems) {
      const unitPrice = money(sourceItem.sale_price);
      await SalesReturnRequestItem.create({
        return_id: returnId,
        order_item_id: sourceItem.item_id,
        product_id: sourceItem.product_id || null,
        product_name: sourceItem.product_name || '',
        pn_code: sourceItem.pn_code || '',
        sn_code: sourceItem.sn_code || '',
        quantity,
        unit_price: unitPrice,
        subtotal: money(unitPrice * quantity)
      }, { transaction });
    }

    await order.update({ order_status: 'return_pending', update_time: new Date() }, { transaction });
    return { returnId, returnNo, orderId: order.order_id, status: 'pending', approvalStage: 'pending_store' };
  });

  ctx.body = { code: 0, data: result, message: '退单申请已提交，待店长审批' };
}

/**
 * 销售退单两级审批：店长通过后进入经销商总权限审批。
 */
async function createSalesReturnInbound({ request, user, transaction, ctx }) {
  const existing = await Inbound.findOne({
    where: { source_type: 'SALES_RETURN', source_no: request.return_no },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (existing) return existing;

  const requestItems = await SalesReturnRequestItem.findAll({
    where: { return_id: request.return_id },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!requestItems.length) ctx.throw(400, 'Sales return request has no items');

  const orderItems = await OrderItem.findAll({
    where: { item_id: { [Op.in]: requestItems.map(item => item.order_item_id).filter(Boolean) } },
    transaction
  });
  const orderItemMap = new Map(orderItems.map(item => [String(item.item_id), item]));
  const productIds = [...new Set(requestItems.map(item => item.product_id).filter(Boolean))];
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds }, is_deleted: 0 },
    transaction
  });
  const productMap = new Map(products.map(product => [String(product.product_id), product]));
  const inboundItems = [];
  let totalQuantity = 0;
  let totalAmount = 0;

  for (const item of requestItems) {
    const product = productMap.get(String(item.product_id || ''));
    if (!product) ctx.throw(400, `Sales return product does not exist: ${item.product_name || item.product_id}`);

    const quantity = Math.max(1, Number(item.quantity || 1));
    const orderItem = orderItemMap.get(String(item.order_item_id || ''));
    const unitPrice = money(orderItem?.original_inventory_cost || item.unit_price || 0);
    let snId = null;
    const snCode = String(item.sn_code || '').trim();

    if (Number(product.need_sn) === 1) {
      if (!snCode || quantity !== 1) ctx.throw(400, `Invalid SN return item: ${item.product_name || product.name}`);
      const sn = await ProductSn.findOne({
        where: {
          product_id: item.product_id,
          store_id: request.store_id,
          sn_code: snCode,
          status: { [Op.in]: ['sold', 'return_pending'] },
          is_deleted: 0
        },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!sn) ctx.throw(409, `SN[${snCode}] is not in a returnable state`);
      snId = sn.sn_id;
      if (sn.status === 'sold') {
        await sn.update({
          status: 'return_pending',
          remark: `${sn.remark || ''} [sales return pending inbound:${request.return_no}]`.trim()
        }, { transaction });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: sn.sn_id,
          sn_code: sn.sn_code,
          product_id: sn.product_id,
          product_name: sn.product_name || product.name,
          store_id: request.store_id,
          action: 'return',
          remark: `Sales return approved, pending re-inbound: ${request.return_no}`,
          create_user: user.name || user.staffId || '',
          create_time: new Date()
        }, { transaction });
      }
    }

    inboundItems.push({
      product_id: item.product_id,
      product_name: item.product_name || product.name,
      pn_code: item.pn_code || '',
      sn_id: snId,
      sn_code: snCode,
      unit_price: unitPrice,
      quantity,
      remark: `Sales return: ${request.return_no}`,
      inventory_type: 'normal_qty'
    });
    totalQuantity += quantity;
    totalAmount += unitPrice * quantity;
  }

  const inbound = await Inbound.create({
    inbound_id: generateUUID(),
    inbound_no: generateInboundNo(),
    store_id: request.store_id,
    source_type: 'SALES_RETURN',
    source_no: request.return_no,
    total_amount: money(totalAmount),
    total_quantity: totalQuantity,
    status: 'pending',
    create_user: user.name || user.staffId || '',
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });

  for (const item of inboundItems) {
    await InboundItem.create({ inbound_id: inbound.inbound_id, ...item }, { transaction });
  }
  return inbound;
}

async function reviewSalesReturn(ctx) {
  const { returnId } = ctx.params;
  const { action = 'approved', comment = '' } = ctx.request.body || {};
  const user = ctx.state.user;
  const roles = getUserRoles(user);
  const isAdmin = roles.some(role => ['boss', 'admin'].includes(role));
  const isManager = roles.some(role => ['boss', 'admin', 'manager'].includes(role));
  if (!isManager) ctx.throw(403, '仅店长或经销商总权限账号可以审批销售退单');

  const result = await sequelize.transaction(async transaction => {
    const request = await SalesReturnRequest.findByPk(returnId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!request) ctx.throw(404, '退单申请不存在');
    assertStoreVisible(request.store_id, user);
    if (request.status !== 'pending') ctx.throw(400, '该退单申请当前无需审批');

    const now = new Date();
    const rejected = action === 'rejected';
    const stage = request.approval_stage || 'pending_store';
    if (stage === 'pending_distributor' && !isAdmin) {
      ctx.throw(403, '仅经销商总权限账号可以审批该退单申请');
    }

    const reviewData = stage === 'pending_distributor'
      ? { distributor_review_user: user.name || user.staffId || '', distributor_review_comment: comment || '', distributor_review_time: now }
      : { store_review_user: user.name || user.staffId || '', store_review_comment: comment || '', store_review_time: now };
    let nextStatus = 'pending';
    let nextStage = stage;
    if (rejected) {
      nextStatus = 'rejected';
      nextStage = 'rejected';
    } else if (stage === 'pending_store') {
      nextStage = 'pending_distributor';
    } else {
      nextStatus = 'approved';
      nextStage = 'approved';
    }

    await request.update({ status: nextStatus, approval_stage: nextStage, update_time: now, ...reviewData }, { transaction });
    let inbound = null;
    if (nextStatus === 'approved') {
      inbound = await createSalesReturnInbound({ request, user, transaction, ctx });
    }
    if (rejected) {
      await Order.update(
        { order_status: '已归档', update_time: now },
        { where: { order_id: request.order_id }, transaction }
      );
    }
    return {
      returnId,
      status: nextStatus,
      approvalStage: nextStage,
      inboundId: inbound?.inbound_id || '',
      inboundNo: inbound?.inbound_no || ''
    };
  });

  ctx.body = {
    code: 0,
    data: result,
    message: result.status === 'rejected'
      ? '退单申请已拒绝'
      : result.inboundNo
        ? `退单审批已完成，已生成待重新入库单 ${result.inboundNo}`
        : '退单审批已完成'
  };
}

function isDepositPayment(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim().toLowerCase();
  return method === '定金' || method === '定金抵扣' || method === 'deposit';
}

function isPolicySubsidyReceivable(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim();
  return method.includes('政策补贴应收');
}

function isNationalSubsidyPayment(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim();
  return method.startsWith('\u56fd\u8865POS');
}

function isNationalSubsidyCustomerReceipt(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim();
  return isNationalSubsidyPayment(payment) && method.endsWith('-\u5ba2\u6237\u5b9e\u6536');
}

function normalizeDepositDeductions(data = {}) {
  const explicitItems = [
    data.depositItems,
    data.deposit_items,
    data.deposits
  ].find(Array.isArray);
  const source = explicitItems && explicitItems.length
    ? explicitItems
    : (Array.isArray(data.payments) ? data.payments.filter(isDepositPayment) : []);

  return source.map(item => ({
    depositId: firstNonEmpty(item, ['depositId', 'deposit_id', '_id']),
    depositNo: firstNonEmpty(item, ['depositNo', 'deposit_no']),
    customerName: firstNonEmpty(item, ['customerName', 'customer_name']),
    customerPhone: firstNonEmpty(item, ['customerPhone', 'customer_phone']),
    amount: money(firstNonEmpty(item, ['amount', 'deductionAmount', 'deduction_amount'], 0))
  }));
}

function getDepositAvailableAmount(deposit) {
  return money(Number(deposit.amount || 0) - Number(deposit.redeemed_amount || 0) - Number(deposit.refunded_amount || 0));
}

function assertDepositCreator(deposit, user, message = '只能核销自己收的定金单') {
  if (String(deposit.create_staff_id || '') !== String(user.staffId || '')) {
    const error = new Error(message);
    error.status = 403;
    throw error;
  }
}

function assertDepositStoreVisible(deposit, user) {
  assertStoreVisible(deposit.store_id, user, '无权访问该门店定金单');
}

function assertStoreVisible(storeId, user, message = '无权访问该门店数据') {
  if (user.accessibleStoreIds?.includes('*')) return;
  if (!(user.accessibleStoreIds || []).map(String).includes(String(storeId || ''))) {
    const error = new Error(message);
    error.status = 403;
    throw error;
  }
}

function assertSalesOrderVisible(storeId, user, distributorId = '') {
  assertStoreVisible(storeId, user, '无权访问该销售订单');
}

async function validateDepositReservation({ payment, user, customerPhone, payableBeforeDeposit, transaction }) {
  const depositId = payment.depositId || payment.deposit_id;
  if (!depositId) {
    throw archiveError('请选择需要占用的定金单');
  }
  const deposit = await DepositOrder.findOne({
    where: { deposit_id: depositId, is_deleted: 0 },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!deposit) {
    throw archiveError('定金单不存在');
  }
  assertDepositCreator(deposit, user, '只能占用自己收的定金单');
  if (!['submitted', 'available', 'archived'].includes(deposit.status)) {
    throw archiveError('该定金单当前不可用于抵扣订单');
  }
  if (customerPhone && deposit.customer_phone && String(customerPhone).trim() !== String(deposit.customer_phone).trim()) {
    throw archiveError('定金单客户电话与当前订单客户电话不一致');
  }

  const availableAmount = getDepositAvailableAmount(deposit);
  if (availableAmount <= 0) {
    throw archiveError('定金单没有可核销余额');
  }
  const requestedAmount = money(payment.amount);
  if (requestedAmount <= 0) {
    throw archiveError('定金抵扣金额必须大于0');
  }
  if (requestedAmount - availableAmount > 0.01) {
    throw archiveError('定金抵扣金额不能超过可用余额');
  }
  if (requestedAmount - payableBeforeDeposit > 0.01) {
    throw archiveError('定金抵扣金额不能超过订单应付金额');
  }

  return { deposit, amount: requestedAmount };
}

async function reserveDepositForOrder({ deposit, orderId, orderNo, amount, user, transaction }) {
  await DepositRedemption.create({
    redemption_id: generateUUID(),
    deposit_id: deposit.deposit_id,
    order_id: orderId,
    order_no: orderNo,
    amount,
    status: 'reserved',
    create_staff_id: user.staffId,
    create_user: user.name
  }, { transaction });

  await deposit.update({
    status: 'occupied',
    related_order_id: orderId,
    related_order_no: orderNo,
    update_time: new Date()
  }, { transaction });
}

async function redeemReservedDepositsForOrder(order, transaction = null) {
  const reservations = await DepositRedemption.findAll({
    where: { order_id: order.order_id, status: 'reserved' },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });

  for (const reservation of reservations) {
    const deposit = await DepositOrder.findByPk(reservation.deposit_id, {
      transaction,
      lock: transaction?.LOCK?.UPDATE
    });
    if (!deposit) {
      throw archiveError('订单关联的定金单不存在');
    }
    if (deposit.status !== 'occupied') {
      throw archiveError('订单关联的定金单不是已占用状态');
    }

    const redeemedAmount = money(
      Number(deposit.redeemed_amount || 0) + Number(reservation.amount || 0)
    );
    await deposit.update({
      redeemed_amount: redeemedAmount,
      status: 'redeemed',
      update_time: new Date()
    }, { transaction });
    await reservation.update({ status: 'redeemed' }, { transaction });
  }
}

async function releaseDepositRedemptionForOrder(order, transaction = null, reason = '订单取消') {
  const redemptions = await DepositRedemption.findAll({
    where: { order_id: order.order_id, status: { [Op.in]: ['reserved', 'active', 'redeemed'] } },
    transaction
  });
  for (const redemption of redemptions) {
    const deposit = await DepositOrder.findByPk(redemption.deposit_id, {
      transaction,
      lock: transaction?.LOCK?.UPDATE
    });
    if (deposit) {
      const wasReserved = redemption.status === 'reserved';
      const restoredRedeemedAmount = wasReserved
        ? money(deposit.redeemed_amount || 0)
        : Math.max(0, money(Number(deposit.redeemed_amount || 0) - Number(redemption.amount || 0)));
      await deposit.update({
        redeemed_amount: restoredRedeemedAmount,
        status: 'available',
        related_order_id: deposit.related_order_id === order.order_id ? null : deposit.related_order_id,
        related_order_no: deposit.related_order_no === order.order_no ? null : deposit.related_order_no,
        update_time: new Date()
      }, { transaction });
    }
    await redemption.update({
      status: 'voided',
      void_reason: reason,
      void_time: new Date()
    }, { transaction });
  }
}

function canSeeCost(user) {
  // 毛利查询属于已授权账号的经营查询能力，门店数据范围仍由 assertStoreVisible 控制。
  return Boolean(user && user.staffId);
}

async function findCurrentManufacturerPrice({ productId, pn, saleDate, transaction = null }) {
  if (!pn) return null;
  const date = saleDate || new Date();
  return ManufacturerPriceHistory.findOne({
    where: {
      pn,
      [Op.and]: [
        { effective_date: { [Op.lte]: date } },
        {
          [Op.or]: [
            { expire_date: null },
            { expire_date: { [Op.gte]: date } }
          ]
        },
        {
          [Op.or]: [
            { product_id: productId },
            { product_id: null },
            { product_id: '' }
          ]
        }
      ]
    },
    order: [['effective_date', 'DESC'], ['created_at', 'DESC']],
    transaction
  });
}

async function findActiveManufacturerPolicies({ supplierId, productId, pn, saleDate, transaction = null }) {
  if (!supplierId) return [];
  const date = saleDate || new Date();
  return ManufacturerRebatePolicy.findAll({
    where: {
      supplier_id: supplierId,
      status: 1,
      [Op.and]: [
        {
          [Op.or]: [
            { start_date: null },
            { start_date: { [Op.lte]: date } }
          ]
        },
        {
          [Op.or]: [
            { end_date: null },
            { end_date: { [Op.gte]: date } }
          ]
        },
        {
          [Op.or]: [
            { product_id: productId },
            { product_id: null },
            { product_id: '' }
          ]
        },
        {
          [Op.or]: [
            { pn },
            { pn: null },
            { pn: '' }
          ]
        }
      ]
    },
    order: [['create_time', 'DESC']],
    transaction
  });
}

function calculatePolicyRebate(policy, baseAmount) {
  if (policy.rebate_calculation_type === 'percentage') {
    return money(baseAmount * Number(policy.rebate_rate || 0) / 100);
  }
  return money(policy.rebate_amount || 0);
}

function calculateCostAdjustment(policy, rebateAmount) {
  if (!policy.affect_sales_settlement_cost) return 0;
  let amount = 0;
  if (policy.cost_adjustment_type === 'fixed_amount') {
    amount = Number(policy.cost_adjustment_value || 0);
  } else if (policy.cost_adjustment_type === 'percentage') {
    amount = rebateAmount * Number(policy.cost_adjustment_value || 0) / 100;
  } else {
    amount = 0;
  }
  const max = Number(policy.max_cost_adjustment_amount || 0);
  if (max > 0) amount = Math.min(amount, max);
  return money(amount);
}

async function createEstimateAndAdjustment({
  order,
  item,
  priceHistory,
  policy,
  policyName,
  policyType,
  rebateAmount,
  affectCost,
  costAdjustmentAmount,
  originalInventoryCost,
  originalPickupPrice,
  currentPickupPrice,
  finalSalesSettlementCost,
  remark,
  transaction
}) {
  const estimateId = generateUUID();
  await RebateEstimate.create({
    estimate_id: estimateId,
    sales_order_id: order.order_id,
    sales_order_no: order.order_no,
    sales_order_item_id: item.item_id,
    supplier_id: priceHistory?.supplier_id || policy?.supplier_id || '',
    supplier_name: priceHistory?.supplier_name || policy?.supplier_name || '',
    product_id: item.product_id,
    product_name: item.product_name,
    pn: item.pn_code,
    sn: item.sn_code,
    policy_id: policy?.policy_id || null,
    policy_name: policyName,
    policy_type: policyType,
    rebate_estimate_amount: rebateAmount,
    status: 'estimated',
    remark
  }, { transaction });

  await createPendingSettlement({
    sourceType: 'MANUFACTURER_REBATE', sourceId: estimateId,
    sn: { sn_id: item.sn_id || `NO_SN_${item.item_id}`, sn_code: item.sn_code || '', product_id: item.product_id },
    resourceType: 'MANUFACTURER_REBATE', amount: rebateAmount,
    counterpartyId: priceHistory?.supplier_id || policy?.supplier_id || null,
    counterpartyName: priceHistory?.supplier_name || policy?.supplier_name || '',
    remark: `销售订单 ${order.order_no} 厂商返利预估到账确认`, transaction
  });

  await SalesSettlementCostAdjustment.create({
    id: generateUUID(),
    sales_order_id: order.order_id,
    sales_order_no: order.order_no,
    sales_order_item_id: item.item_id,
    supplier_id: priceHistory?.supplier_id || policy?.supplier_id || '',
    supplier_name: priceHistory?.supplier_name || policy?.supplier_name || '',
    product_id: item.product_id,
    product_name: item.product_name,
    pn: item.pn_code,
    sn: item.sn_code,
    original_inventory_cost: originalInventoryCost,
    original_pickup_price: originalPickupPrice,
    current_pickup_price_at_sale: currentPickupPrice,
    policy_id: policy?.policy_id || null,
    policy_name: policyName,
    policy_type: policyType,
    rebate_estimate_id: estimateId,
    rebate_estimate_amount: rebateAmount,
    affect_sales_settlement_cost: affectCost ? 1 : 0,
    cost_adjustment_amount: costAdjustmentAmount,
    final_sales_settlement_cost: finalSalesSettlementCost,
    remark
  }, { transaction });
}

async function calculateSalesSettlementCosts(order, transaction = null, options = {}) {
  const existing = await SalesSettlementCostAdjustment.count({
    where: { sales_order_id: order.order_id },
    transaction
  });
  if (existing > 0 && !options.force) return;

  if (options.force) {
    const estimates = await RebateEstimate.findAll({ where: { sales_order_id: order.order_id }, attributes: ['estimate_id'], transaction });
    const estimateIds = estimates.map(item => item.estimate_id);
    if (estimateIds.length > 0) {
      const settledCount = await ResourceSettlement.count({ where: { source_type: 'MANUFACTURER_REBATE', source_id: { [Op.in]: estimateIds }, status: 'SETTLED' }, transaction });
      if (settledCount > 0) throw Object.assign(new Error('该订单的厂商返利已下账，不能重算'), { status: 409 });
      await ResourceSettlement.destroy({ where: { source_type: 'MANUFACTURER_REBATE', source_id: { [Op.in]: estimateIds }, status: 'PENDING' }, transaction });
    }
    await SalesSettlementCostAdjustment.destroy({ where: { sales_order_id: order.order_id }, transaction });
    await RebateEstimate.destroy({ where: { sales_order_id: order.order_id }, transaction });
  }

  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const productPrices = await ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction });
  const priceMap = new Map(productPrices.map(price => [price.product_id, price]));
  const saleDate = order.create_time || new Date();

  for (const item of items) {
    const snRecord = item.sn_code
      ? await ProductSn.findOne({ where: { sn_code: item.sn_code, product_id: item.product_id }, transaction })
      : null;
    const productPrice = priceMap.get(item.product_id);
    const originalInventoryCost = money(snRecord?.inbound_price || productPrice?.cost_price || 0);
    const originalPickupPrice = money(snRecord?.original_pickup_price || snRecord?.inbound_price || item.original_pickup_price || 0);
    const priceHistory = await findCurrentManufacturerPrice({
      productId: item.product_id,
      pn: item.pn_code,
      saleDate,
      transaction
    });
    const currentPickupPrice = money(priceHistory?.pickup_price || 0);
    const p0DifferenceAmount = originalPickupPrice > currentPickupPrice && currentPickupPrice > 0
      ? money(originalPickupPrice - currentPickupPrice)
      : 0;

    let totalCostAdjustment = 0;
    const pendingRows = [];

    if (p0DifferenceAmount > 0) {
      totalCostAdjustment += p0DifferenceAmount;
      pendingRows.push({
        policy: null,
        policyName: 'P差',
        policyType: 'p0_difference',
        rebateAmount: p0DifferenceAmount,
        affectCost: true,
        costAdjustmentAmount: p0DifferenceAmount,
        remark: 'P差 = 原始提货价 - 销售时厂家当前提货价'
      });
    }

    const policies = await findActiveManufacturerPolicies({
      supplierId: priceHistory?.supplier_id,
      productId: item.product_id,
      pn: item.pn_code,
      saleDate,
      transaction
    });

    for (const policy of policies) {
      if (policy.policy_type === 'p0_difference') continue;
      const rebateAmount = calculatePolicyRebate(policy, originalInventoryCost);
      if (rebateAmount <= 0) continue;
      const costAdjustmentAmount = calculateCostAdjustment(policy, rebateAmount);
      totalCostAdjustment += costAdjustmentAmount;
      pendingRows.push({
        policy,
        policyName: policy.policy_name,
        policyType: policy.policy_type,
        rebateAmount,
        affectCost: !!policy.affect_sales_settlement_cost,
        costAdjustmentAmount,
        remark: policy.cost_adjustment_remark || policy.remark || ''
      });
    }

    totalCostAdjustment = money(totalCostAdjustment);
    const finalSalesSettlementCost = money(Math.max(0, originalInventoryCost - totalCostAdjustment));
    const salesGrossProfit = money(Number(item.subtotal || 0) - finalSalesSettlementCost * Number(item.quantity || 1));

    for (const row of pendingRows) {
      await createEstimateAndAdjustment({
        order,
        item,
        priceHistory,
        policy: row.policy,
        policyName: row.policyName,
        policyType: row.policyType,
        rebateAmount: row.rebateAmount,
        affectCost: row.affectCost,
        costAdjustmentAmount: row.costAdjustmentAmount,
        originalInventoryCost,
        originalPickupPrice,
        currentPickupPrice,
        finalSalesSettlementCost,
        remark: row.remark,
        transaction
      });
    }

    await item.update({
      original_inventory_cost: originalInventoryCost,
      original_pickup_price: originalPickupPrice,
      current_pickup_price_at_sale: currentPickupPrice,
      p0_difference_amount: p0DifferenceAmount,
      cost_adjustment_amount: totalCostAdjustment,
      sales_settlement_cost: finalSalesSettlementCost,
      sales_gross_profit: salesGrossProfit
    }, { transaction });
  }
}

function isCancelStatus(status) {
  return ['cancelled', 'canceled', 'voided', '已取消', '作废', '已作废'].includes(String(status || ''));
}

async function reserveInventoryForOrder(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  if (!items.length) {
    throw archiveError('订单中没有商品，无法占用库存');
  }

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction });
  const productMap = new Map(products.map(product => [product.product_id, product]));
  const operations = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) {
      throw archiveError(`商品 ${item.product_id || item.product_name || ''} 不存在`);
    }

    const quantity = Number(item.quantity || 1);
    if (Number(product.need_sn || 0) === 1) {
      const snCode = String(item.sn_code || '').trim();
      if (!snCode) {
        throw archiveError(`商品 ${item.product_name || product.name} 需要SN管理，请先填写SN码`);
      }

      const snWhere = {
        sn_code: snCode,
        product_id: item.product_id,
        store_id: order.store_id,
        status: 'in_stock',
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;

      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord) {
        throw archiveError(`SN码 [${snCode}] 在当前门店没有可用库存，不能提交订单`);
      }
      if (await isRentalDemoSn(snRecord, transaction)) {
        throw archiveError(`SN码 [${snCode}] 属于租赁样机仓，不允许销售`);
      }

      operations.push({ item, quantity, snRecord, inventoryType: snRecord.inventory_type || 'normal_qty' });
    } else {
      await assertAvailableInventory(item, product, order.store_id, quantity, '提交订单', transaction);
      operations.push({ item, quantity, inventoryType: 'normal_qty' });
    }
  }

  for (const op of operations) {
    if (op.snRecord) {
      await op.snRecord.update({ status: 'reserved' }, { transaction });
      if (!op.item.sn_id) {
        await op.item.update({ sn_id: op.snRecord.sn_id }, { transaction });
      }
    }
    await _moveInventoryToPending(op.item.product_id, order.store_id, op.inventoryType, op.quantity, transaction);
  }
}

async function releaseReservedInventoryForOrder(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  for (const item of items) {
    const quantity = Number(item.quantity || 1);
    let inventoryType = 'normal_qty';

    if (item.sn_code) {
      const snWhere = {
        sn_code: String(item.sn_code).trim(),
        product_id: item.product_id,
        store_id: order.store_id,
        status: 'reserved',
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;
      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (snRecord) {
        inventoryType = snRecord.inventory_type || 'normal_qty';
        await snRecord.update({ status: 'in_stock' }, { transaction });
      }
    }

    await _releasePendingInventory(item.product_id, order.store_id, inventoryType, quantity, transaction);
  }
}

async function assertAvailableInventory(item, product, storeId, quantity, actionText, transaction = null) {
  const inv = await Inventory.findOne({
    where: { product_id: item.product_id, store_id: storeId },
    transaction
  });
  const normalStock = inv ? Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  ) : 0;
  const totalStock = inv ? normalStock + Number(inv.display_qty || 0) : 0;
  if (totalStock < quantity) {
    throw archiveError(`商品 ${item.product_name || product.name} 库存不足(可用:${totalStock}, 需要:${quantity})，不能${actionText}`);
  }
  return inv;
}

async function validateAndDeductInventoryForArchive(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  if (!items.length) {
    throw archiveError('订单中没有商品，无法归档');
  }

  const pnCodes = [...new Set(items.map(item => normalizePnCode(item.pn_code)).filter(Boolean))];
  const pnRows = pnCodes.length
    ? await ProductPn.findAll({
      where: {
        [Op.and]: [sequelize.where(
          sequelize.fn('LOWER', sequelize.fn('REPLACE', sequelize.fn('TRIM', sequelize.col('pn_code')), ' ', '')),
          { [Op.in]: pnCodes.map(code => code.toLowerCase()) }
        )],
        is_deleted: 0,
        status: 1
      },
      transaction
    })
    : [];
  const pnMap = new Map(pnRows.map(row => [normalizePnCode(row.pn_code), row]));

  for (const item of items) {
    const pnCode = String(item.pn_code || '').trim();
    const pnKey = normalizePnCode(pnCode);
    if (!pnCode) {
      throw archiveError(`商品 ${item.product_name || item.item_id} 缺少PN码，不能归档`);
    }
    const pnRecord = pnMap.get(pnKey);
    if (!pnRecord) {
      throw archiveError(`PN码 [${pnCode}] 不存在，不能归档`);
    }
    if (item.product_id && String(item.product_id) !== String(pnRecord.product_id)) {
      throw archiveError(`PN码 [${pnCode}] 与订单商品不匹配，不能归档`);
    }
    if (!item.product_id) {
      await item.update({ product_id: pnRecord.product_id }, { transaction });
      item.product_id = pnRecord.product_id;
    }
  }

  const productIds = [...new Set(items.map(i => String(i.product_id || '')).filter(Boolean))];
  const products = productIds.length
    ? await Product.findAll({ where: { product_id: { [Op.in]: productIds }, is_deleted: 0 }, transaction })
    : [];
  const productMap = new Map(products.map(product => [String(product.product_id), product]));
  const operations = [];

  for (const item of items) {
    const product = productMap.get(String(item.product_id || ''));
    if (!product) {
      throw archiveError(`PN码 [${item.pn_code || ''}] 对应的商品不存在，不能归档`);
    }

    const pnCode = String(item.pn_code || '').trim();
    const pnRecord = pnMap.get(normalizePnCode(pnCode));
    if (!pnRecord || String(pnRecord.product_id) !== String(product.product_id)) {
      throw archiveError(`PN码 [${pnCode}] 不存在，不能归档`);
    }

    const quantity = Number(item.quantity || 1);
    const snCode = String(item.sn_code || '').trim();
    if (product.need_sn === 1) {
      if (!snCode) {
        throw archiveError(`商品 ${item.product_name || product.name} 需要SN管理，请先补充SN码后再归档`);
      }

      const snWhere = {
        sn_code: snCode,
        product_id: item.product_id,
        store_id: order.store_id,
        status: { [Op.in]: ['reserved', 'in_stock'] },
        is_deleted: 0
      };

      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord || normalizePnCode(snRecord.pn_code) !== normalizePnCode(pnCode)) {
        throw archiveError(`SN码 [${snCode}] 在当前门店没有可用库存，不能归档`);
      }
      if (await isRentalDemoSn(snRecord, transaction)) {
        throw archiveError(`SN码 [${snCode}] 属于租赁样机仓，不允许销售`);
      }

      operations.push({
        item,
        product,
        quantity,
        snRecord,
        inventoryType: snRecord.inventory_type || 'normal_qty',
        fromPending: snRecord.status === 'reserved'
      });
    } else {
      if (snCode) {
        const optionalSn = await ProductSn.findOne({
          where: {
            sn_code: snCode,
            product_id: item.product_id,
            store_id: order.store_id,
            status: { [Op.in]: ['reserved', 'in_stock'] },
            is_deleted: 0
          },
          transaction
        });
        if (!optionalSn || normalizePnCode(optionalSn.pn_code) !== normalizePnCode(pnCode)) {
          throw archiveError(`SN码 [${snCode}] 不存在或与PN码不匹配，不能归档`);
        }
        if (!item.sn_id) {
          await item.update({ sn_id: optionalSn.sn_id }, { transaction });
        }
      }
      const inv = await Inventory.findOne({
        where: { product_id: item.product_id, store_id: order.store_id },
        transaction
      });
      const pendingStock = inv ? Number(inv.pending_qty || 0) : 0;
      const normalStock = inv ? Math.max(
        Number(inv.normal_qty || 0),
        Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
      ) : 0;
      const totalStock = inv ? normalStock + Number(inv.display_qty || 0) + pendingStock : 0;
      if (totalStock < quantity) {
        throw archiveError(`商品 ${item.product_name || product.name} 库存不足(可用:${totalStock}, 需要:${quantity})，不能归档`);
      }

      operations.push({
        item,
        product,
        quantity,
        inventoryType: 'normal_qty',
        fromPending: pendingStock >= quantity
      });
    }
  }

  for (const op of operations) {
    if (op.snRecord) {
      await op.snRecord.update({ status: 'sold' }, { transaction });
      if (!op.item.sn_id) {
        await op.item.update({ sn_id: op.snRecord.sn_id }, { transaction });
      }
    }

    if (op.fromPending) {
      await _finalizePendingInventory(op.item.product_id, order.store_id, op.quantity, transaction);
    } else {
      await _deductInventory(op.item.product_id, order.store_id, op.inventoryType, op.quantity, transaction);
    }
  }
}

module.exports = {
  list,
  listProductOrders,
  exportOrders,
  create,
  saveSalesDraft,
  updateSalesDraft,
  submitSalesDraft,
  deleteSalesDraft,
  detail,
  update,
  updateOrderItems,
  listSalesReturnRequests,
  requestSalesReturn,
  reviewSalesReturn,
  createSalesReturnInbound,
  stats,
  approve,
  reject,
  auxiliaryStaff,
  paymentMethods,
  listDeposits,
  createDeposit,
  archiveDeposit,
  refundDeposit,
  availableDeposits,
  getProductPns,
  getProductSns,
  recalculateSettlementCost,
  getGrossProfit,
  updateSupplements,
  listSubsidyPhotos,
  replaceSubsidyPhotos,
  downloadSubsidyPhoto,
  downloadSubsidyPhotosArchive,
  downloadAllSubsidyPhotosArchive,
  createSubsidyPhotosDownloadTicket,
  _test: {
    canQueryAllSalesOrders,
    normalizeOrderExtendedFields,
    normalizeAuxiliarySalesList,
    isCancelStatus,
    reserveDepositForOrder,
    redeemReservedDepositsForOrder,
    releaseDepositRedemptionForOrder,
    normalizePnCode,
    validateAndDeductInventoryForArchive,
    reserveInventoryForOrder,
    normalizeSubsidyPhotos,
    hasSubsidyPhotoFilter,
    inferSubsidyPhotoExtension,
    subsidyPhotoFileName,
    subsidyPhotoFolderName,
    userCanViewSubsidyPhotos,
    subsidyPhotoStoreWhere,
    buildSubsidyPhotoQuery,
    buildChinaDateRange,
    buildOrderExportRows,
    ORDER_EXPORT_HEADERS
  }
};

const INVENTORY_COLUMN_MAP = {
  normal_qty: 'normal_qty',
  display_qty: 'display_qty',
  demo_qty: 'demo_qty',
  unsellable_qty: 'unsellable_qty',
  pending_qty: 'pending_qty'
};

async function _deductInventory(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (inv) {
    const qty = Number(quantity) || 0;
    const detailColumns = ['regular_qty', 'subsidy_qty', 'second_qty'];
    const detailTotal = detailColumns.reduce((sum, key) => sum + Number(inv[key] || 0), 0);
    const currentVal = column === 'normal_qty'
      ? Math.max(Number(inv.normal_qty || 0), detailTotal)
      : Number(inv[column] || 0);
    const deductFromColumn = Math.min(currentVal, qty);
    let remaining = qty - deductFromColumn;
    const payload = { [column]: currentVal - deductFromColumn };

    if (column === 'normal_qty') {
      let detailRemaining = deductFromColumn;
      for (const detailColumn of detailColumns) {
        if (detailRemaining <= 0) break;
        const currentDetail = Number(inv[detailColumn] || 0);
        const deduct = Math.min(currentDetail, detailRemaining);
        payload[detailColumn] = currentDetail - deduct;
        detailRemaining -= deduct;
      }

      if (remaining > 0) {
        const displayQty = Number(inv.display_qty || 0);
        const displayDeduct = Math.min(displayQty, remaining);
        payload.display_qty = displayQty - displayDeduct;
      }
    }

    await inv.update(payload, { transaction });
  }
}

async function _moveInventoryToPending(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) {
    throw archiveError(`商品 ${productId} 库存不存在，不能占用`);
  }

  const qty = Number(quantity) || 0;
  const detailColumns = ['regular_qty', 'subsidy_qty', 'second_qty'];
  const detailTotal = detailColumns.reduce((sum, key) => sum + Number(inv[key] || 0), 0);
  const currentVal = column === 'normal_qty'
    ? Math.max(Number(inv.normal_qty || 0), detailTotal)
    : Number(inv[column] || 0);
  const deductFromColumn = Math.min(currentVal, qty);
  let remaining = qty - deductFromColumn;
  const payload = {
    [column]: currentVal - deductFromColumn,
    pending_qty: Number(inv.pending_qty || 0) + qty
  };

  if (column === 'normal_qty') {
    let detailRemaining = deductFromColumn;
    for (const detailColumn of detailColumns) {
      if (detailRemaining <= 0) break;
      const currentDetail = Number(inv[detailColumn] || 0);
      const deduct = Math.min(currentDetail, detailRemaining);
      payload[detailColumn] = currentDetail - deduct;
      detailRemaining -= deduct;
    }

    if (remaining > 0) {
      const displayQty = Number(inv.display_qty || 0);
      const displayDeduct = Math.min(displayQty, remaining);
      payload.display_qty = displayQty - displayDeduct;
    }
  }

  await inv.update(payload, { transaction });
}

async function _finalizePendingInventory(productId, storeId, quantity, transaction = null) {
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) return;
  const qty = Number(quantity) || 0;
  await inv.update({
    pending_qty: Math.max(0, Number(inv.pending_qty || 0) - qty)
  }, { transaction });
}

async function _releasePendingInventory(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) return;
  const qty = Number(quantity) || 0;
  const releaseQty = Math.min(Number(inv.pending_qty || 0), qty);
  await inv.update({
    pending_qty: Math.max(0, Number(inv.pending_qty || 0) - releaseQty),
    [column]: Number(inv[column] || 0) + releaseQty
  }, { transaction });
}

/**
 * 同步已完成订单到日结单
 */
async function syncToDailyStatement(orderId, storeId) {
  try {
    const { DailyStatement, DailyStatementDetail, PaymentMethodStore, SettlementAccount, PaymentMethod } = require('../../models');
    const order = await Order.findByPk(orderId, {
      include: [{ model: OrderPayment }, { model: OrderItem }]
    });
    if (!order) return;

    const dateStr = getChinaDateString();

    // 加载所有支付方式字典
    const paymentMethods = await PaymentMethod.findAll({ where: { status: 1 } });
    const paymentMethodMap = {};
    for (const pm of paymentMethods) {
      paymentMethodMap[pm.code] = pm.name;
    }

    const [statement] = await DailyStatement.findOrCreate({
      where: { store_id: storeId, statement_date: dateStr },
      defaults: {
        statement_id: generateUUID(),
        store_id: storeId,
        statement_date: dateStr,
        total_revenue: 0,
        total_order_count: 0,
        total_settled: 0,
        status: 'pending'
      }
    });

    const nationalSubsidyPayments = (order.OrderPayments || []).filter(isNationalSubsidyPayment);
    const nationalAmount = nationalSubsidyPayments.reduce(
      (sum, payment) => sum + Number(payment.amount || 0),
      0
    );
    const subsidyReceivableAmount = nationalSubsidyPayments
      .filter(isPolicySubsidyReceivable)
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

    for (const payment of order.OrderPayments || []) {
      const settleAccountId = await resolveSettlementAccount(storeId, payment.payment_method);
      const paymentMethodName = paymentMethodMap[payment.payment_method] || payment.payment_method;
      const businessType = isPolicySubsidyReceivable({ method: paymentMethodName })
        ? 'national_subsidy_receivable'
        : 'sales_receipt';
      const statementAmount = isNationalSubsidyCustomerReceipt({ method: paymentMethodName })
        ? calculateNationalSubsidyCustomerReceiptAmount({
          nationalAmount,
          subsidyAmount: subsidyReceivableAmount,
          nationalSubsidyAmount: order.national_subsidy
        })
        : payment.amount;

      const existing = await DailyStatementDetail.findOne({
        where: { statement_id: statement.statement_id, order_id: orderId, payment_code: paymentMethodName }
      });
      if (existing) {
        await existing.update({
          amount: statementAmount,
          settlement_account_id: settleAccountId,
          payment_method: paymentMethodName,
          payment_code: paymentMethodName,
          business_type: businessType,
          customer_name: order.customer_name,
          order_no: order.order_no
        });
      } else {
        await DailyStatementDetail.create({
          detail_id: generateUUID(),
          statement_id: statement.statement_id,
          order_id: orderId,
          order_no: order.order_no,
          customer_name: order.customer_name || '',
          payment_method: paymentMethodName,
          payment_code: paymentMethodName,
          business_type: businessType,
          amount: statementAmount,
          settlement_account_id: settleAccountId,
          settled: 0
        });
      }
    }

    await refreshDailyStatementTotals(statement);
  } catch (err) {
    console.error('[DailySync] Error:', err.message);
  }
}

function getChinaDateString(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function refreshDailyStatementTotals(statement, transaction = null) {
  const { DailyStatementDetail } = require('../../models');
  const details = await DailyStatementDetail.findAll({
    where: { statement_id: statement.statement_id },
    attributes: ['order_id', 'amount'],
    transaction
  });
  const orderIds = [...new Set(details.map(detail => detail.order_id))];
  const totalRevenue = details.reduce((sum, detail) => sum + Number(detail.amount || 0), 0);
  await statement.update({
    total_revenue: money(totalRevenue),
    total_order_count: orderIds.length
  }, { transaction });
}

async function syncDepositToDailyStatement(deposit, transaction) {
  const { DailyStatement, DailyStatementDetail } = require('../../models');
  const dateStr = getChinaDateString();
  const [statement] = await DailyStatement.findOrCreate({
    where: { store_id: deposit.storeId, statement_date: dateStr },
    defaults: {
      statement_id: generateUUID(),
      store_id: deposit.storeId,
      statement_date: dateStr,
      total_revenue: 0,
      total_order_count: 0,
      total_settled: 0,
      status: 'pending'
    },
    transaction
  });
  const settlementAccountId = await resolveSettlementAccount(
    deposit.storeId,
    deposit.paymentMethod,
    transaction
  );

  await DailyStatementDetail.create({
    detail_id: generateUUID(),
    statement_id: statement.statement_id,
    order_id: deposit.depositId,
    order_no: deposit.depositNo,
    customer_name: deposit.customerName || '',
    payment_method: deposit.paymentMethod,
    payment_code: deposit.paymentMethod,
    business_type: 'deposit_receipt',
    amount: deposit.amount,
    settlement_account_id: settlementAccountId,
    settled: 0
  }, { transaction });

  await refreshDailyStatementTotals(statement, transaction);
}

async function resolveSettlementAccount(storeId, paymentMethodName, transaction = null) {
  try {
    const { PaymentMethod, PaymentMethodStore } = require('../../models');
    const defaultPolicyReceivableAccountId = 'ACC_POLICY_SUBSIDY_RECEIVABLE';
    const methodName = String(paymentMethodName || '');
    const isPolicyReceivable = methodName.endsWith('-政策补贴应收');
    const baseMethodName = methodName
      .replace(/-客户实收$/, '')
      .replace(/-政策补贴应收$/, '');
    const pm = await PaymentMethod.findOne({
      where: { name: baseMethodName, status: 1 },
      transaction
    });
    if (!pm) return null;

    if (pm.is_global === 1) {
      return isPolicyReceivable
        ? pm.receivable_settlement_account_id || defaultPolicyReceivableAccountId
        : pm.settlement_account_id || null;
    }

    const storeCfg = await PaymentMethodStore.findOne({
      where: { method_id: pm.method_id, store_id: storeId },
      transaction
    });
    return isPolicyReceivable
      ? storeCfg?.receivable_settlement_account_id || pm.receivable_settlement_account_id || defaultPolicyReceivableAccountId
      : storeCfg?.settlement_account_id || null;
  } catch (err) {
    console.error('[resolveSettlementAccount] Error:', err.message);
    return null;
  }
}
