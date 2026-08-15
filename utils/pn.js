/**
 * PN 统一规范：应用内部只使用 pnCode。
 *
 * 外部接口/历史数据的字段差异只允许在这里收口，业务代码不得再自行兼容
 * pn、pn_code、PN 或 PN_CODE。
 */
function normalizePnCode(value) {
  return String(value === undefined || value === null ? '' : value).trim().toUpperCase();
}

function readExternalPnCode(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return normalizePnCode(value);

  return normalizePnCode(
    value.pnCode !== undefined ? value.pnCode :
      value.pn_code !== undefined ? value.pn_code :
        value.PN_CODE !== undefined ? value.PN_CODE :
          value.pn !== undefined ? value.pn :
            value.PN !== undefined ? value.PN :
              value.manufacturer_code !== undefined ? value.manufacturer_code :
                value.manufacturerCode
  );
}

function withPnCode(item, value) {
  return Object.assign({}, item || {}, {
    pnCode: normalizePnCode(value === undefined ? readExternalPnCode(item) : value)
  });
}

module.exports = {
  normalizePnCode,
  readExternalPnCode,
  withPnCode
};
