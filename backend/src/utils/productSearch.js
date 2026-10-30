// Shared product search contract: AND between tokens, OR between ranked fields.
function tokens(value) { return [...new Set(String(value || '').trim().split(/\s+/).filter(Boolean))]; }
function expressions(db, keyword, alias = 'Product', storeIds = null, snAlias = null) {
  if (![alias,...(snAlias?[snAlias]:[])].every(value=>/^[A-Za-z][A-Za-z0-9_]*$/.test(value))) throw new Error('Invalid product alias');
  const product = `${alias}.PRODUCT_ID`;
  const scope = storeIds === null || storeIds.includes('*') ? '' : storeIds.length
    ? ` AND ss.STORE_ID IN (${storeIds.map(id => db.escape(String(id))).join(',')})` : ' AND 1=0';
  const ranks = tokens(keyword).map(token => {
    const pattern = db.escape(`%${token.replace(/[!%_]/g, '!$&')}%`);
    const like = field => `${field} LIKE ${pattern} ESCAPE '!'`;
    return [
      snAlias ? like(snAlias+'.SN_CODE') : `EXISTS (SELECT 1 FROM T_PRODUCT_SN ss WHERE ss.PRODUCT_ID=${product} AND ss.IS_DELETED=0${scope} AND ${like('ss.SN_CODE')})`,
      `(${like(`${alias}.MANUFACTURER_CODE`)} OR EXISTS (SELECT 1 FROM T_PRODUCT_PN pp WHERE pp.PRODUCT_ID=${product} AND pp.IS_DELETED=0 AND pp.STATUS=1 AND ${like('pp.PN_CODE')}) OR EXISTS (SELECT 1 FROM T_PRODUCT_SN ss WHERE ss.PRODUCT_ID=${product} AND ss.IS_DELETED=0${scope} AND ${like('ss.PN_CODE')}))`,
      like(`${alias}.NAME`), like(`${alias}.CONFIG`), like(`${alias}.REMARK`)
    ];
  });
  return {
    where: ranks.length ? ranks.map(fields => `(${fields.join(' OR ')})`).join(' AND ') : '1=1',
    rank: ranks.length ? `LEAST(${ranks.map(fields => `(CASE ${fields.map((field,index) => `WHEN ${field} THEN ${index}`).join(' ')} ELSE 5 END)`).join(',')}${ranks.length === 1 ? ',5' : ''})` : '5'
  };
}
function stock(db, alias = 'Product', storeIds = []) {
  const scope = storeIds.includes('*') ? '' : storeIds.length ? ` AND si.STORE_ID IN (${storeIds.map(id=>db.escape(String(id))).join(',')})` : ' AND 1=0';
  const serialScope = scope.replaceAll('si.STORE_ID', 'ss.STORE_ID');
  const serial = `(SELECT COUNT(*) FROM T_PRODUCT_SN ss INNER JOIN T_LOCATION sl ON sl.LOCATION_ID=ss.LOCATION_ID AND sl.TYPE='normal_qty' AND sl.STATUS=1 WHERE ss.PRODUCT_ID=${alias}.PRODUCT_ID AND ss.IS_DELETED=0 AND ss.STATUS='in_stock' AND ss.INVENTORY_TYPE='normal_qty'${serialScope})`;
  const ordinary = `(SELECT COALESCE(SUM(GREATEST(COALESCE(si.NORMAL_QTY,0),COALESCE(si.REGULAR_QTY,0)+COALESCE(si.SUBSIDY_QTY,0)+COALESCE(si.SECOND_QTY,0))),0) FROM T_INVENTORY si WHERE si.PRODUCT_ID=${alias}.PRODUCT_ID${scope})`;
  return `(CASE WHEN ${alias}.NEED_SN=1 THEN ${serial} ELSE ${ordinary} END)`;
}
module.exports = { tokens, expressions, stock };
