/**
 * 工具函数
 */
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

/**
 * 生成UUID
 */
function generateUUID() {
  return uuidv4().replace(/-/g, '');
}

/**
 * 生成订单编号
 * 规则: ORD + 年月日时分秒 + 4位随机
 */
function generateOrderNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `ORD${date}${random}`;
}

/**
 * 生成采购单编号
 */
function generatePurchaseNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `PO${date}${random}`;
}

/**
 * 生成入库单编号
 */
function generateInboundNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `IN${date}${random}`;
}

/**
 * 生成出库单编号
 */
function generateOutboundNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `OUT${date}${random}`;
}

/**
 * 生成调拨单编号
 */
function generateTransferNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `TRF${date}${random}`;
}

/**
 * 生成采购申请编号
 */
function generateRequestNo() {
  const date = moment().format('YYYYMMDDHHmmss');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `PR${date}${random}`;
}

/**
 * 生成商品编号
 * 规则: P + 年月日 + 5位序号
 */
function generateProductCode() {
  const date = moment().format('YYYYMMDD');
  const seq = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `P${date}${seq}`;
}

/**
 * 生成批次号
 */
function generateBatchNo() {
  const date = moment().format('YYYYMMDD');
  const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `B${date}${random}`;
}

/**
 * 分页处理
 */
function paginate(query, { page = 1, pageSize = 20 }) {
  const limit = Math.min(pageSize, 100);
  const offset = (page - 1) * limit;
  return {
    ...query,
    limit,
    offset
  };
}

/**
 * 格式化分页结果
 */
function formatPaginatedResult(data, { page, pageSize, count }) {
  return {
    list: data,
    pagination: {
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(count / pageSize)
    }
  };
}

/**
 * 过滤空值
 */
function filterEmpty(data) {
  const result = {};
  Object.keys(data).forEach(key => {
    if (data[key] !== '' && data[key] !== null && data[key] !== undefined) {
      result[key] = data[key];
    }
  });
  return result;
}

module.exports = {
  generateUUID,
  generateOrderNo,
  generatePurchaseNo,
  generateInboundNo,
  generateOutboundNo,
  generateTransferNo,
  generateRequestNo,
  generateProductCode,
  generateBatchNo,
  paginate,
  formatPaginatedResult,
  filterEmpty
};
