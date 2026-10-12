const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const codes = `PF6DWF7C HA2MH2ET BH028NR1 HA2LYFAQ HA2JF84R HA2EF57A HA2Q0SCB HA2Q01B5 HA2PW7EL 870056914AHLL6890284 MP31370T MP31399W BH02531N BH02539P BH02533P PF656NYZ MP2V9VCE MP2VFE4R MP2VFDTW MP2VF9GX BH02DM3C BH028ZB5 BH02DLXA BH02DMLM BH02DMH4 BH02DMJ6 BH028ZDA BH028ZAL BH02DMFE BH02D0ND BH02CFB3 BH028ZEX BH02DMM3`.split(' ');
async function main() {
  const rows = await sequelize.query(`
    SELECT sn.SN_CODE sn, sn.SN_ID snId, sn.PRODUCT_ID productId, sn.STATUS snStatus,
           sn.IS_DELETED snDeleted, p.MANUFACTURER_CODE pn, p.NAME productName,
           p.CATEGORY category, p.GROSS_PROFIT_COST_MODE costMode,
           p.STATUS productStatus, p.IS_DELETED productDeleted,
           pp.STANDARD_PRICE standardPrice, pp.STATUS priceStatus
      FROM T_PRODUCT_SN sn JOIN T_PRODUCT p ON p.PRODUCT_ID=sn.PRODUCT_ID
      LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID=p.PRODUCT_ID
     WHERE sn.SN_CODE IN (:codes) ORDER BY sn.SN_CODE`,
    { replacements: { codes }, type: QueryTypes.SELECT });
  const orderLines = await sequelize.query(`
    SELECT oi.SN_CODE sn, oi.SN_ID snId, oi.ITEM_ID itemId, oi.PRODUCT_ID productId,
           o.ORDER_ID orderId, o.ORDER_NO orderNo, o.ORDER_STATUS orderStatus,
           o.CREATE_TIME createTime, o.ARCHIVE_TIME archiveTime,
           gp.SNAPSHOT_STATUS snapshotStatus
      FROM T_ORDER_ITEM oi JOIN T_ORDER o ON o.ORDER_ID=oi.ORDER_ID
      LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID=o.ORDER_ID
     WHERE oi.SN_CODE IN (:codes) OR oi.SN_ID IN (:snIds)
     ORDER BY o.ORDER_NO`,
    { replacements: { codes, snIds: rows.map(row => row.snId).filter(Boolean) }, type: QueryTypes.SELECT });
  const matched = new Set(rows.map(row => row.sn));
  console.log(JSON.stringify({ requested: codes.length, matched: matched.size,
    unmatched: codes.filter(code => !matched.has(code)), products: rows,
    orderLines }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
