const PLACEHOLDER_CODES = new Set(['无', 'none', 'null', 'n/a', 'na', '-', '—']);

function cleanPnCode(value) {
  return String(value ?? '').trim();
}

function normalizePnCode(value) {
  return cleanPnCode(value).replace(/\s+/g, '').toLowerCase();
}

function isUsablePnCode(value) {
  const normalized = normalizePnCode(value);
  return Boolean(normalized) && !PLACEHOLDER_CODES.has(normalized);
}

function splitPnCodes(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,;，；、|]+/);
  const result = [];
  const seen = new Set();
  for (const valueItem of values) {
    const code = cleanPnCode(valueItem);
    const key = normalizePnCode(code);
    if (!isUsablePnCode(code) || seen.has(key)) continue;
    seen.add(key);
    result.push(code);
  }
  return result;
}

function uniquePnCodes(values) {
  const list = Array.isArray(values) ? values : [values];
  const result = [];
  const seen = new Set();
  list.flatMap(value => Array.isArray(value) ? value : splitPnCodes(value)).forEach(value => {
    const code = cleanPnCode(value);
    const key = normalizePnCode(code);
    if (!isUsablePnCode(code) || seen.has(key)) return;
    seen.add(key);
    result.push(code);
  });
  return result;
}

/**
 * SN 商品只能绑定一个 PN；非 SN 商品不限制 PN 数量。
 * configuredCodes 是商品主数据已登记的 PN，requestedCode 是本次入库/维护传入的 PN。
 */
function assertSingleSnProductPn({ needSn, productCode = '', configuredCodes = [], requestedCode = '' }) {
  if (Number(needSn) !== 1) return requestedCode || uniquePnCodes(configuredCodes)[0] || '';

  const configured = uniquePnCodes(configuredCodes);
  const requested = cleanPnCode(requestedCode);
  const requestedKey = normalizePnCode(requested);
  const configuredKeys = new Set(configured.map(normalizePnCode));

  if (configured.length > 1) {
    throw Object.assign(
      new Error(`SN商品${productCode ? `【${productCode}】` : ''}只能绑定一个PN，当前已登记多个PN`),
      { status: 400, code: 'SN_PRODUCT_PN_NOT_UNIQUE' }
    );
  }
  if (requestedKey && configuredKeys.size > 0 && !configuredKeys.has(requestedKey)) {
    throw Object.assign(
      new Error(`SN商品${productCode ? `【${productCode}】` : ''}的PN与商品主数据不一致`),
      { status: 400, code: 'SN_PRODUCT_PN_MISMATCH' }
    );
  }
  if (!requestedKey && configured.length === 0) {
    throw Object.assign(
      new Error(`SN商品${productCode ? `【${productCode}】` : ''}必须维护唯一PN`),
      { status: 400, code: 'SN_PRODUCT_PN_REQUIRED' }
    );
  }
  return configured[0] || requested || '';
}

module.exports = {
  cleanPnCode,
  normalizePnCode,
  isUsablePnCode,
  splitPnCodes,
  uniquePnCodes,
  assertSingleSnProductPn
};
