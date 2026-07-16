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

module.exports = {
  cleanPnCode,
  normalizePnCode,
  isUsablePnCode,
  splitPnCodes
};
