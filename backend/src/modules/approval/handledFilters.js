const { Op, literal } = require('sequelize');
const keys = { pn: ['pn', 'pn_code', 'pnCode', 'manufacturer_code', 'manufacturerCode'], sn: ['sn', 'sn_code', 'snCode', 'direct_inbound_sn_code', 'directInboundSnCode'] };
function dateRange(query) {
  const range = {};
  for (const [key, op] of [['startDate', Op.gte], ['endDate', Op.lt]]) {
    if (!query[key]) continue;
    const value = String(query[key]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('日期格式应为有效的 YYYY-MM-DD');
    const date = new Date(`${value}T00:00:00+08:00`);
    if (key === 'endDate') date.setUTCDate(date.getUTCDate()+1);
    range[op] = date;
  }
  if (query.startDate && query.endDate && query.startDate > query.endDate) throw new Error('开始日期不能晚于结束日期');
  return Reflect.ownKeys(range).length ? range : null;
}
function productFilter(M, registry, kind, value) {
  const db = M.sequelize;
  const q = name => '`' + name.replace(/`/g,'``') + '`';
  const table = model => db.getQueryInterface().queryGenerator.quoteTable(model.getTableName());
  const col = (model, alias, field) => `${q(alias)}.${q(model.rawAttributes[field].field || field)}`;
  const input = String(value || '').trim();
  if (!input) return null;
  if (input.length > 128) throw new Error('PN、SN筛选最多128个字符');
  const contains = column => `LOCATE(${db.escape(input)}, ${column}) > 0`;
  const json = column => {
    const pattern = '%' + input.replace(/[\\%_]/g, c => '\\'+c) + '%';
    const paths = keys[kind].map(k => db.escape('$**.'+k)).join(',');
    return `JSON_SEARCH(JSON_EXTRACT(IF(JSON_VALID(${column}), ${column}, '{}'), ${paths}), 'one', ${db.escape(pattern)}) IS NOT NULL`;
  };
  const matches = (model, alias) => {
    const conditions = keys[kind].filter(k=>model.rawAttributes[k]).map(k=>contains(col(model,alias,k)));
    for (const field of ['payload_json','items_json','sn_codes_json','specs_json']) if (model.rawAttributes[field]) conditions.push(json(col(model,alias,field)));
    if (kind==='sn' && M.ProductSn) for (const field of ['sn_id','source_sn_id']) {
      if (model.rawAttributes[field]) conditions.push(`${col(model,alias,field)} COLLATE utf8mb4_unicode_ci IN (SELECT ${col(M.ProductSn,'s','sn_id')} COLLATE utf8mb4_unicode_ci FROM ${table(M.ProductSn)} s WHERE ${contains(col(M.ProductSn,'s','sn_code'))})`);
    }
    if (kind==='pn' && model.rawAttributes.product_id && model!==M.Product) conditions.push(`${col(model,alias,'product_id')} COLLATE utf8mb4_unicode_ci IN (SELECT ${col(M.Product,'p','product_id')} COLLATE utf8mb4_unicode_ci FROM ${table(M.Product)} p WHERE ${contains(col(M.Product,'p','manufacturer_code'))})`);
    return conditions;
  };
  const instance = M.ApprovalFlowInstance;
  const alternatives = [json(col(instance,'ApprovalFlowInstance','payload_json'))];
  const children = { PurchaseRequest: [['PurchaseRequestItem','request_id']], Order: [['OrderItem','order_id']], ReturnStock: [['ReturnStockItem','return_id']], Transfer: [['TransferItem','transfer_id']], Settlement: [['SettlementItem','settlement_id']], SalesReturnRequest: [['OrderItem','order_id']], InventoryBatchApplication: [['InventoryBatchApplicationItem','application_id']] };
  for (const [type, descriptor] of Object.entries({...registry, purchase:{model:'PurchaseRequest',id:'request_id'}, product:{model:'ProductApplication',id:'application_id'}, return:{model:'ReturnStock',id:'return_id'}, sales_negative_gross_profit:{model:'Order',id:'order_id'}, payable_settlement:{model:'Settlement',id:'settlement_id'}})) {
    const model=M[descriptor.model]; if(!model) continue;
    const conditions=matches(model,'b');
    for(const [name,foreign] of children[descriptor.model]||[]) {
      const child=M[name]; if(!child || !model.rawAttributes[foreign])continue;
      const terms=matches(child,'c'); if(!terms.length)continue;
      conditions.push(`${col(model,'b',foreign)} COLLATE utf8mb4_unicode_ci IN (SELECT ${col(child,'c',foreign)} COLLATE utf8mb4_unicode_ci FROM ${table(child)} c WHERE (${terms.join(' OR ')}))`);
    }
    if(!conditions.length)continue;
    alternatives.push(`(${col(instance,'ApprovalFlowInstance','business_type')}=${db.escape(type)} AND ${col(instance,'ApprovalFlowInstance','business_id')} COLLATE utf8mb4_unicode_ci IN (SELECT ${col(model,'b',descriptor.id)} COLLATE utf8mb4_unicode_ci FROM ${table(model)} b WHERE (${conditions.join(' OR ')})))`);
  }
  return literal('('+alternatives.join(' OR ')+')');
}
module.exports={dateRange,productFilter};
