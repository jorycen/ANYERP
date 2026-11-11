const opening = require('./commissionOpeningExceptions.json');
const exceptions = new Map(opening.orders.map(row => [String(row.orderId), row]));
const day = value => value instanceof Date || /(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value||''))
  ? new Date(new Date(value).getTime()+28800000).toISOString().slice(0,10) : String(value||'').slice(0,10);
function saleTime(order) {
  const id=String(order.order_id??order.orderId),created=order.create_time??order.createdAt,archived=order.archive_time??order.archivedAt;
  return exceptions.has(id)&&day(created).startsWith('2026-09')&&day(archived).startsWith('2026-10') ? created : archived;
}
function saleSql(alias='o') {
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))throw Error('Invalid SQL alias');
  const ids=[...exceptions.keys()].map(id=>{if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid opening order ID');return `'${id}'`}).join(',')||"'__NONE__'";
  return `(CASE WHEN ${alias}.ORDER_ID IN (${ids}) AND ${alias}.CREATE_TIME >= '2026-09-01' AND ${alias}.CREATE_TIME < '2026-10-01' AND ${alias}.ARCHIVE_TIME >= '2026-10-01' AND ${alias}.ARCHIVE_TIME < '2026-11-01' THEN ${alias}.CREATE_TIME ELSE ${alias}.ARCHIVE_TIME END)`;
}
const adjustmentSql=(alias='pa')=>`${alias}.ADMIN_REVIEW_TIME`;
const adjustmentTime=row=>row.admin_review_time??row.ADMIN_REVIEW_TIME??null;
module.exports={saleTime,saleSql,adjustmentSql,adjustmentTime,opening};
