const XLSX = require('xlsx');
const { QueryTypes } = require('sequelize');
const { sequelize, ProductPn } = require('../../models');
const { generateUUID } = require('../../utils');

const VENDORS = Object.freeze({ changhong: '佳华', tianjin: '汇一' });

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/[\u00a0\u3000]/g, ' ').trim();
}

function normalizePn(value, vendor) {
  let pn = normalizeText(value).replace(/\s+/g, '').toUpperCase();
  if (vendor === 'tianjin') pn = pn.replace(/-XN$/i, '');
  return pn;
}

function numericStock(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value).replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function findHeader(rows, aliases, maxRows = 20) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, maxRows); rowIndex += 1) {
    const cells = rows[rowIndex].map(normalizeText);
    const found = {};
    Object.entries(aliases).forEach(([key, names]) => {
      found[key] = cells.findIndex(cell => names.some(name => cell === name || cell.includes(name)));
    });
    if (found.pn >= 0 && found.name >= 0) return { rowIndex, found };
  }
  return null;
}

function stockValue(row, columns) {
  let quantity = 0;
  let hasNumber = false;
  const labels = [];
  columns.forEach(column => {
    const value = row[column];
    const number = numericStock(value);
    if (number !== null) {
      hasNumber = true;
      quantity += number;
    } else {
      const text = normalizeText(value);
      if (text && !labels.includes(text)) labels.push(text);
    }
  });
  return { quantity: hasNumber ? quantity : null, text: labels.join('/') };
}

function mergeRecord(target, incoming, sameSheet) {
  if (!target) return { ...incoming };
  if (incoming.quantity !== null) {
    if (target.quantity === null) target.quantity = incoming.quantity;
    else target.quantity = sameSheet ? Math.max(target.quantity, incoming.quantity) : target.quantity + incoming.quantity;
  }
  incoming.text.split('/').filter(Boolean).forEach(label => {
    const labels = target.text.split('/').filter(Boolean);
    if (!labels.includes(label)) target.text = [...labels, label].join('/');
  });
  if (!target.productName && incoming.productName) target.productName = incoming.productName;
  return target;
}

function parseChanghong(workbook) {
  const result = new Map();
  const ignored = [];
  workbook.SheetNames.forEach(sheetName => {
    if (/详细配置/.test(sheetName)) return;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const header = findHeader(rows, {
      pn: ['商品编码', 'MTM', '物料编码', 'PN'],
      name: ['产品明细', '商品名称', '物料描述'],
      sec: ['SEC'], own: ['自有1库'], cd: ['成都K']
    });
    if (!header || header.found.sec < 0 || header.found.own < 0 || header.found.cd < 0) {
      ignored.push(sheetName);
      return;
    }
    const sheetSeen = new Map();
    rows.slice(header.rowIndex + 1).forEach(row => {
      const pn = normalizePn(row[header.found.pn], 'changhong');
      if (!pn || pn.length < 6) return;
      const stock = stockValue(row, [header.found.sec, header.found.own, header.found.cd]);
      const record = { pn, productName: normalizeText(row[header.found.name]), ...stock, sourceSheet: sheetName };
      sheetSeen.set(pn, mergeRecord(sheetSeen.get(pn), record, true));
    });
    sheetSeen.forEach(record => result.set(record.pn, mergeRecord(result.get(record.pn), record, false)));
  });
  if (!result.size) throw new Error('未识别到佳华报价表，请确认文件包含商品编码/MTM、产品明细、SEC、自有1库、成都K');
  return { records: [...result.values()], ignoredSheets: ignored };
}

function parseTianjin(workbook) {
  const sheetName = workbook.SheetNames.find(name => name === '产品') || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  let headerRow = -1;
  let pnColumn = -1;
  let nameColumn = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const cells = rows[i].map(normalizeText);
    const pn = cells.findIndex(cell => ['系统编码', '商品编码', '物料编码', 'PN'].includes(cell));
    const name = cells.findIndex(cell => ['配置', '产品明细', '商品名称', '物料名称'].includes(cell));
    if (pn >= 0 && name >= 0) { headerRow = i; pnColumn = pn; nameColumn = name; break; }
  }
  if (headerRow < 0) throw new Error('未识别到汇一产品表的系统编码和配置列');
  const warehouseHeader = rows[headerRow + 1] || [];
  const warehouseColumns = ['成都SEC', '成都诚义', '重庆诚义', '重庆SEC']
    .map(name => warehouseHeader.map(normalizeText).findIndex(cell => cell === name));
  if (warehouseColumns.some(column => column < 0)) throw new Error('汇一产品表缺少成都SEC、成都诚义、重庆诚义或重庆SEC列');
  const result = new Map();
  rows.slice(headerRow + 2).forEach(row => {
    const rawPn = normalizeText(row[pnColumn]);
    const pn = normalizePn(rawPn, 'tianjin');
    if (!pn || pn.length < 6) return;
    const stock = stockValue(row, warehouseColumns);
    result.set(pn, { pn, rawPn, productName: normalizeText(row[nameColumn]), ...stock, sourceSheet: sheetName });
  });
  if (!result.size) throw new Error('汇一产品表没有可导入的商品记录');
  return { records: [...result.values()], ignoredSheets: workbook.SheetNames.filter(name => name !== sheetName) };
}

function parseSupplierWorkbook(buffer, vendor) {
  if (!VENDORS[vendor]) throw new Error('服务商只能选择佳华或汇一');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellText: false, cellDates: false });
  return vendor === 'changhong' ? parseChanghong(workbook) : parseTianjin(workbook);
}

let tableReadyPromise = null;

async function ensureTable() {
  if (tableReadyPromise) return tableReadyPromise;
  tableReadyPromise = sequelize.query(`CREATE TABLE IF NOT EXISTS T_SUPPLIER_INVENTORY_CURRENT (
    inventory_id VARCHAR(32) PRIMARY KEY,
    distributor_id VARCHAR(32) NOT NULL,
    vendor_code VARCHAR(20) NOT NULL,
    normalized_pn VARCHAR(64) NOT NULL,
    raw_pn VARCHAR(64) NULL,
    product_name VARCHAR(512) NULL,
    quantity DECIMAL(14,2) NULL,
    quantity_text VARCHAR(128) NULL,
    source_file_name VARCHAR(255) NULL,
    source_sheet VARCHAR(128) NULL,
    uploaded_by VARCHAR(64) NULL,
    uploaded_at DATETIME NOT NULL,
    UNIQUE KEY UK_SUPPLIER_INVENTORY_CURRENT (distributor_id, vendor_code, normalized_pn),
    KEY IDX_SUPPLIER_INVENTORY_PN (distributor_id, normalized_pn)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => {
    tableReadyPromise = null;
    throw error;
  });
  return tableReadyPromise;
}

async function replaceSupplierInventory({ distributorId, vendor, fileName, uploadedBy, records }) {
  await ensureTable();
  return sequelize.transaction(async transaction => {
    await sequelize.query('DELETE FROM T_SUPPLIER_INVENTORY_CURRENT WHERE distributor_id = ? AND vendor_code = ?', {
      replacements: [distributorId, vendor], transaction
    });
    for (const record of records) {
      await sequelize.query(`INSERT INTO T_SUPPLIER_INVENTORY_CURRENT
        (inventory_id, distributor_id, vendor_code, normalized_pn, raw_pn, product_name, quantity, quantity_text, source_file_name, source_sheet, uploaded_by, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, {
        replacements: [generateUUID(), distributorId, vendor, record.pn, record.rawPn || record.pn,
          record.productName || '', record.quantity, record.text || '', fileName || '', record.sourceSheet || '', String(uploadedBy || '')],
        transaction
      });
    }
    return records.length;
  });
}

function displayStock(row) {
  if (row.quantity !== null && row.quantity !== undefined) {
    const value = Number(row.quantity);
    if (value > 0 || !row.quantity_text) return Number.isInteger(value) ? String(value) : String(value);
  }
  return row.quantity_text || '0';
}

async function inventoryByProduct(productIds, distributorId) {
  const result = new Map(productIds.map(id => [String(id), { changhong: '-', tianjin: '-' }]));
  if (!productIds.length || !distributorId) return result;
  await ensureTable();
  const pnRows = await ProductPn.findAll({
    where: { product_id: productIds, status: 1, is_deleted: 0 },
    attributes: ['product_id', 'pn_code'], raw: true
  });
  const productByPn = new Map();
  pnRows.forEach(row => {
    const pn = normalizePn(row.pn_code, 'changhong');
    if (pn) productByPn.set(pn, String(row.product_id));
  });
  if (!productByPn.size) return result;
  const rows = await sequelize.query(`SELECT vendor_code, normalized_pn, quantity, quantity_text, uploaded_at
    FROM T_SUPPLIER_INVENTORY_CURRENT WHERE distributor_id = ? AND normalized_pn IN (?)`, {
    replacements: [distributorId, [...productByPn.keys()]], type: QueryTypes.SELECT
  });
  rows.forEach(row => {
    const productId = productByPn.get(row.normalized_pn);
    if (!productId || !result.has(productId)) return;
    result.get(productId)[row.vendor_code] = displayStock(row);
    result.get(productId)[`${row.vendor_code}UpdatedAt`] = row.uploaded_at;
  });
  return result;
}

module.exports = { VENDORS, normalizePn, parseSupplierWorkbook, replaceSupplierInventory, inventoryByProduct };
