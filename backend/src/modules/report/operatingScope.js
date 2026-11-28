const { Op } = require('sequelize');

const INTERNAL_TRANSFER_SOURCE = '艾诺互调';

function isInternalTransferSource(value) {
  const source = String(value || '').trim();
  return source === INTERNAL_TRANSFER_SOURCE || source.startsWith(`${INTERNAL_TRANSFER_SOURCE} /`);
}

function appendOperatingSourceCondition(where = {}) {
  const condition = {
    [Op.or]: [
      { customer_source: null },
      { customer_source: { [Op.notLike]: `${INTERNAL_TRANSFER_SOURCE}%` } }
    ]
  };
  where[Op.and] = [...(where[Op.and] || []), condition];
  return where;
}

function operatingSourceSql(orderAlias = 'o') {
  return `COALESCE(TRIM(${orderAlias}.CUSTOMER_SOURCE), '') NOT LIKE :internalTransferSource`;
}

module.exports = {
  INTERNAL_TRANSFER_SOURCE,
  isInternalTransferSource,
  appendOperatingSourceCondition,
  operatingSourceSql
};
