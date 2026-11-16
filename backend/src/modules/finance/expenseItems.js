const { expandExpenseRows, monthsBetween } = require('./expenseAmortization');
function read(value) {
  if (typeof value === 'string') value = JSON.parse(value || '[]');
  if (!Array.isArray(value)) throw Object.assign(new Error('费用明细格式无效'), {status:400});
  return value;
}
function display(row) {
  const items=read(row.expense_items_json || '[]');
  return items.length ? items : [{expenseTypeId:row.expense_type_id||'',expenseType:row.expense_type||'其他',amount:Number(row.amount),remark:''}];
}
// Allocate integral cents with deterministic largest remainders.
function allocate(cents, budgets) {
  const total=budgets.reduce((s,n)=>s+n,0);
  if (!Number.isSafeInteger(cents)||cents<0||cents>total) throw new Error('费用分类分摊金额无效');
  const exact=budgets.map(n=>total?cents*n/total:0), result=exact.map(Math.floor);
  const order=exact.map((n,i)=>({i,remainder:n-result[i]})).sort((a,b)=>b.remainder-a.remainder||a.i-b.i);
  let left=cents-result.reduce((s,n)=>s+n,0);
  for(const {i} of order)if(left>0){result[i]++;left--;}
  return result;
}
function expand(rows, filters) {
  return rows.flatMap(row=>{
    const items=read(row.expenseItemsJson||'[]');
    if (!items.length) return expandExpenseRows([row],filters);
    const groups=new Map();
    for(const item of items){const cents=Math.round(Number(item.amount)*100);if(!Number.isSafeInteger(cents)||cents<=0)throw new Error('费用明细金额无效');const key=String(item.expenseTypeId||item.expenseType);const old=groups.get(key);if(old)old.cents+=cents;else groups.set(key,{...item,cents});}
    const types=[...groups.values()], remaining=types.map(i=>i.cents);
    if(remaining.reduce((s,n)=>s+n,0)!==Math.round(Number(row.amount)*100))throw new Error(`费用 ${row.expenseId} 明细合计与总金额不一致`);
    const parts=row.amortizationStartMonth||row.amortizationEndMonth ? expandExpenseRows([row],{dateMode:'accounting_month',monthKeys:monthsBetween(row.amortizationStartMonth,row.amortizationEndMonth)}) : [row];
    return parts.flatMap(part=>{
      let details=read(part.attributionDetails||'[]');
      if(!details.length)details=[{target_type:'store',target_id:row.sourceStoreId,amount:part.amount}];
      const perType=types.map(()=>[]);
      for(const detail of details){const split=allocate(Math.round(Number(detail.amount)*100),remaining);split.forEach((n,i)=>{remaining[i]-=n;perType[i].push({...detail,amount:n/100});});}
      const selected=!part.amortizationMonth || (filters.dateMode==='accounting_month' ? filters.monthKeys.includes(part.amortizationMonth) : part.businessDate>=filters.startDate&&part.businessDate<=filters.endDate);
      if(!selected)return [];
      return types.map((type,i)=>({...part,expenseType:type.expenseType||'其他',expenseTypeKey:types.length>1?String(type.expenseTypeId||type.expenseType):null,
        expenseItemsJson:null,amount:perType[i].reduce((s,d)=>s+Math.round(d.amount*100),0)/100,attributionDetails:perType[i]})).filter(p=>p.amount>0);
    });
  });
}
function normalizeInput(ctx, { expenseItems, expenseTypeId, amount }) {
  if (expenseItems !== undefined && (!Array.isArray(expenseItems) || !expenseItems.length || expenseItems.length>100)) ctx.throw(400,'费用明细须为1至100行');
  const requestedItems = Array.isArray(expenseItems) && expenseItems.length
    ? expenseItems
    : (expenseTypeId ? [{ expenseTypeId, amount }] : []);
  if (!requestedItems.length) ctx.throw(400, '请至少添加一条报销类型');
  const normalizedItems = [];
  for (const item of requestedItems) {
    if(!item || typeof item!=='object')ctx.throw(400,'费用明细格式无效');
    const itemTypeId = String(item.expenseTypeId || item.typeId || '').trim();
    const itemAmount = Number(item.amount);
    if (!itemTypeId) ctx.throw(400, '每条费用明细都必须选择报销类型');
    if (!Number.isFinite(itemAmount) || itemAmount <= 0) ctx.throw(400, '每条费用明细金额必须大于0');
    if (Math.abs(itemAmount * 100 - Math.round(itemAmount * 100)) > 0.000001) ctx.throw(400, '费用明细金额最多两位小数');
    normalizedItems.push({ expenseTypeId: itemTypeId, amount: Math.round(itemAmount * 100) / 100, remark: String(item.remark || '').trim() });
  }
  const normalizedAmount = Math.round(normalizedItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  if (!Number.isSafeInteger(Math.round(normalizedAmount * 100)) || normalizedAmount > 9999999999.99) ctx.throw(400, '费用总额超出有效范围');
  return { normalizedItems, normalizedAmount };
}
module.exports={read,display,allocate,expand,normalizeInput};
