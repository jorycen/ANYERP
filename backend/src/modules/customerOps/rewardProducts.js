const S = require('./security');
function options(item) {
  if (Array.isArray(item.product_options) && item.product_options.length) return item.product_options;
  return item.product_id ? [{product_id:item.product_id,units_per_reward:item.units_per_reward || 1}] : [];
}
function validate(input) {
  if (Object.prototype.hasOwnProperty.call(input,'product_options') && (!Array.isArray(input.product_options)||!input.product_options.length)) S.fail(400,'请至少关联一个ERP商品');
  const rows=options(input);
  if (!rows.length || rows.length>50) S.fail(400,'请关联1至50个ERP商品');
  const ids=new Set();
  return rows.map(row=>{
    const product_id=String(row.product_id||'');
    if (!product_id || product_id.length>32 || ids.has(product_id)) S.fail(400,'关联商品为空或重复');
    ids.add(product_id);
    if (!Number.isInteger(row.units_per_reward)||row.units_per_reward<1||row.units_per_reward>1000) S.fail(400,'每份出库数量应为1至1000的整数');
    return {product_id,units_per_reward:row.units_per_reward};
  });
}
function select(snapshot, productId) {
  const rows=options(snapshot);
  if (productId !== undefined && typeof productId!=='string') S.fail(400,'一次只能选择一个核销商品');
  if (rows.length>1 && !productId) S.fail(400,'请选择本次实际交付的一个商品');
  const selected=rows.find(row=>row.product_id===(productId || rows[0]?.product_id));
  if (!selected) S.fail(400,'核销商品不在凭证关联范围内');
  return {...snapshot,product_id:selected.product_id,units_per_reward:selected.units_per_reward};
}
module.exports={options,validate,select};
