const opening = require('./commissionOpeningExceptions.json');
const periodExceptions = require('./commissionPeriodExceptions.json');
const exceptions = new Map(opening.orders.map(row => [String(row.orderId), row]));
const salesPeriods=new Map(periodExceptions.sales.map(row=>[String(row.orderId),row.postingTime]));
const adjustmentPeriods=new Map(periodExceptions.adjustments.map(row=>[String(row.adjustmentId),row.postingTime]));
const day = value => value instanceof Date || /(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value||''))
  ? new Date(new Date(value).getTime()+28800000).toISOString().slice(0,10) : String(value||'').slice(0,10);
function saleTime(order) {
  const id=String(order.order_id??order.orderId),created=order.create_time??order.createdAt,archived=order.archive_time??order.archivedAt;
  if(salesPeriods.has(id))return new Date(salesPeriods.get(id));
  return exceptions.has(id)&&day(created).startsWith('2026-09')&&day(archived).startsWith('2026-10') ? created : archived;
}
function identifier(alias){if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))throw Error('Invalid SQL alias');return alias;}
function fixedPeriodsSql(field,periods,fallback){
 if(!periods.size)return fallback;
 const cases=[...periods].map(([id,time])=>{
  if(!/^[a-f0-9]{32}$/.test(id)||!Number.isFinite(new Date(time).getTime()))throw Error('Invalid fixed period record');
  const local=new Date(new Date(time).getTime()+28800000).toISOString().slice(0,19).replace('T',' ');
  return `WHEN '${id}' THEN CAST('${local}' AS DATETIME)`;
 }).join(' ');
 return `(CASE ${field} ${cases} ELSE ${fallback} END)`;
}
function saleSql(alias='o') {
  identifier(alias);
  const ids=[...exceptions.keys()].map(id=>{if(!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid opening order ID');return `'${id}'`}).join(',')||"'__NONE__'";
  const original=`(CASE WHEN ${alias}.ORDER_ID IN (${ids}) AND ${alias}.CREATE_TIME >= '2026-09-01' AND ${alias}.CREATE_TIME < '2026-10-01' AND ${alias}.ARCHIVE_TIME >= '2026-10-01' AND ${alias}.ARCHIVE_TIME < '2026-11-01' THEN ${alias}.CREATE_TIME ELSE ${alias}.ARCHIVE_TIME END)`;
  return fixedPeriodsSql(`${alias}.ORDER_ID`,salesPeriods,original);
}
const adjustmentSql=(alias='pa')=>fixedPeriodsSql(`${identifier(alias)}.ADJUSTMENT_ID`,adjustmentPeriods,`${alias}.ADMIN_REVIEW_TIME`);
const adjustmentTime=row=>{
 const id=String(row.adjustment_id??row.ADJUSTMENT_ID);
 return adjustmentPeriods.has(id)?new Date(adjustmentPeriods.get(id)):row.admin_review_time??row.ADMIN_REVIEW_TIME??null;
};
module.exports={saleTime,saleSql,adjustmentSql,adjustmentTime,opening,periodExceptions};
