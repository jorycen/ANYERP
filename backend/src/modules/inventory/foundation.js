const crypto = require('node:crypto');
const { Op } = require('sequelize');
const M = require('../../models');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const id = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const money = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Math.round(Number(value) * 100) / 100;
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
function snKey(snId, cycles = [], at = new Date()) {
  const valid = cycles.filter(x => String(x.sn_id) === String(snId) && new Date(x.create_time) <= new Date(at))
    .sort((a,b) => new Date(b.create_time)-new Date(a.create_time) || String(b.log_id).localeCompare(String(a.log_id)));
  return `sn:${snId}:${valid[0]?.log_id || 'original'}`;
}
function view(row) {
  if (!row) return { basisId: null, status: 'pending', invoiceType: null, invoiceTypeLabel: '待确认', purchaseCost: null, costMode: null, companyPrice: null, reason: '基础档案尚未建立或关联' };
  return { basisId: row.basis_id, identityKey: row.identity_key, productId: row.product_id,
    status: row.status, invoiceType: row.status === 'confirmed' ? row.invoice_type : null,
    invoiceTypeLabel: row.status !== 'confirmed' ? '待确认' : row.invoice_type === '专票13%' ? '含税' : row.invoice_type === '收据' ? '未税' : '待确认',
    purchaseCost: money(row.purchase_cost), costEstimated:!!json(row.source_data||{}).costEstimated, costMode: row.cost_mode || null,
    companyPrice: money(row.company_price), revision: Number(row.revision), reason: row.reason || '',
    source: json(row.source_data || {}), snCode: row.sn_code || '', batchNo: row.batch_no || '' };
}
function mergeCandidates(candidates) {
  const fields = ['invoice_type','purchase_cost','cost_mode','company_price'];
  const result = {}, conflicts = [];
  for (const key of fields) {
    const values = [...new Set(candidates.map(x => x[key]).filter(x => x !== null && x !== undefined && x !== '')
      .map(x => ['purchase_cost','company_price'].includes(key) ? money(x) : x))];
    if (values.length > 1) conflicts.push(key);
    result[key] = values.length === 1 ? values[0] : null;
  }
  return { ...result, status: conflicts.length ? 'conflict' : result.invoice_type ? 'confirmed' : 'pending',
    reason: conflicts.length ? `基础资料冲突：${conflicts.join('、')}` : result.invoice_type ? '' : '含税属性尚未确认' };
}
async function load(referenceKeys, transaction) {
  if (!referenceKeys.length) return new Map();
  const links = await M.InventoryFoundationRef.findAll({ where: { reference_key: { [Op.in]: [...new Set(referenceKeys)] } }, raw: true, transaction });
  if (!links.length) return new Map();
  const rows = await M.InventoryFoundation.findAll({ where: { basis_id: { [Op.in]: [...new Set(links.map(x => x.basis_id))] } }, raw: true, transaction });
  const byId = new Map(rows.map(x => [x.basis_id,x]));
  return new Map(links.map(x => [x.reference_key, view(byId.get(x.basis_id))]));
}
async function salesBasis(order, lines, transaction) {
  const refs = lines.map(x => `order_item:${x.itemId}`);
  const saved = await load(refs, transaction);
  // Only exact references are allowed. No nearest receipt, same-product or
  // supplier-default inference may silently link an imported historical sale.
  return lines.map(line => {const basis=saved.get(`order_item:${line.itemId}`);return { ...line, inventoryFoundation: matchesLine(basis,line)?basis:view(null) };});
}
function matchesLine(basis,line){
  if(!basis)return false;
  if(line.productId&&basis.productId!==line.productId)return false;
  const snId=line.snId||line.pricingOrigin?.snId;
  if(snId)return String(basis.identityKey||'').startsWith('sn:'+snId+':');
  if(line.snCode)return basis.snCode===line.snCode;
  return !line.productId||!basis.snCode;
}
async function applySalesTaxBasis(order, lines, transaction) {
  const attached = await salesBasis(order, lines, transaction);
  return attached.map(line => {
    const b = line.inventoryFoundation;
    const service = require('../sales/purchaseVat').isService(line);
    const purchaseAmount = service ? 0 : b.purchaseCost === null ? null : Math.round(b.purchaseCost * Number(line.quantity) * 100) / 100;
    return { ...line, purchaseTaxBasis: { version: require('../sales/purchaseVat').VERSION,
      status: b.status === 'confirmed' && purchaseAmount !== null ? 'confirmed' : 'pending',
      service, purchaseAmount, invoiceType: b.invoiceType, basisId: b.basisId, basisRevision: b.revision,
      source: 'inventory_foundation', reason: b.reason || (purchaseAmount === null ? '采购成本尚未确认' : '') } };
  });
}
async function applySalesPricing(order, lines, transaction) {
  return (await salesBasis(order,lines,transaction)).map(line=>{
    const b=line.inventoryFoundation;
    if(!b.basisId)return line;
    const mode=b.costMode,price=mode==='COMPANY_PRICE'?(line.isSpecialPrice===true&&money(line.specialPrice)!==null?money(line.specialPrice):b.companyPrice):mode==='PURCHASE_PRICE'?b.purchaseCost:null;
    return {...line,purchasePrice:b.purchaseCost,purchasePriceKnown:b.purchaseCost!==null,
      ...(mode?{isCompanyPriced:mode==='COMPANY_PRICE',costModeSnapshot:mode}:{}),
      ...(price!==null?{unitPricing:price,pricingAmount:Math.round(price*Number(line.quantity)*100)/100,
        source:'inventory_foundation',grossProfitUpliftAmount:mode==='COMPANY_PRICE'?0:line.grossProfitUpliftAmount}:{}),
      ...(price===null?{source:'missing_foundation_price'}:{})};
  });
}
async function ensureSalesReferences(order,lines,transaction){
  if(!transaction)return M.sequelize.transaction(tx=>ensureSalesReferences(order,lines,tx));
  const present=await load(lines.map(l=>'order_item:'+l.itemId),transaction);
  const missing=lines.filter(l=>!matchesLine(present.get('order_item:'+l.itemId),l));
  if(!missing.length)return;
  const documented=await require('../sales/purchaseVat').resolveDocumentTaxBasis(order,missing,transaction);
  const items=await M.OrderItem.findAll({where:{item_id:{[Op.in]:missing.map(l=>l.itemId)}},raw:true,transaction});
  for(const line of documented){
    const item=items.find(x=>String(x.item_id)===String(line.itemId));if(!item||item.product_id!==line.productId)fail('商品基础身份不一致');
    const previous=await M.InventoryFoundationRef.findByPk('order_item:'+item.item_id,{transaction,lock:transaction.LOCK.UPDATE});
    if(previous){
      if(!['draft','未归档','pending_approval','pending_store_approval','pending_distributor_approval'].includes(order.order_status))fail('历史商品基础关联变化，需先核实原单');
      await previous.destroy({transaction});
    }
    const current=item.sn_id?await M.InventoryFoundationRef.findByPk('sn_current:'+item.sn_id,{transaction,lock:transaction.LOCK.UPDATE}):null;
    let row=current?await M.InventoryFoundation.findByPk(current.basis_id,{transaction,lock:transaction.LOCK.UPDATE}):null;
    if(row&&row.product_id!==item.product_id)fail('SN关联商品基础档案不一致');
    if(row){const scope=json(row.source_data||{}).taxScope,month=new Date(new Date(order.create_time).getTime()+8*3600000).toISOString().slice(0,7);
      if(scope&&scope!==month)await clearScopedTax(row,transaction);}
    if(row&&row.status==='pending'&&!row.invoice_type&&['system','migration'].includes(row.updated_by)&&line.purchaseTaxBasis?.status==='confirmed'){
      await row.update({invoice_type:line.purchaseTaxBasis.invoiceType,status:'confirmed',revision:Number(row.revision)+1,
        source_data:{...json(row.source_data||{}),purchaseBasis:line.purchaseTaxBasis},update_time:new Date()}, {transaction});
    }
    if(!row){
      const cycles=item.sn_id?await M.SnLog.findAll({where:{sn_id:item.sn_id,action:'stock_cycle_reentry'},raw:true,transaction}):[];
      const key=item.sn_id?snKey(item.sn_id,cycles):'import_sale:'+item.item_id;
      const b=line.purchaseTaxBasis||{};
      row=await M.InventoryFoundation.findByPk(id(key),{transaction,lock:transaction.LOCK.UPDATE});
      if(!row)row=await M.InventoryFoundation.create({basis_id:id(key),identity_key:key,product_id:item.product_id,
        product_name:line.productName,entity_type:item.sn_id?'sn_cycle':'import_sale',sn_code:line.snCode||'',
        invoice_type:b.status==='confirmed'?b.invoiceType:null,status:b.status==='confirmed'?'confirmed':'pending',
        purchase_cost:line.purchasePriceKnown===false?null:money(line.purchasePrice),
        cost_mode:line.isCompanyPriced?'COMPANY_PRICE':'PURCHASE_PRICE',company_price:line.isCompanyPriced?money(line.unitPricing):null,
        source_data:{source:'order_intake',purchaseBasis:b},revision:1,updated_by:'system'}, {transaction});
      if(item.sn_id)await bind('sn_current:'+item.sn_id,row.basis_id,order.store_id,transaction);
    }
    await bind('order_item:'+item.item_id,row.basis_id,order.store_id,transaction);
  }
}
async function clearScopedTax(row,transaction){
  const source=json(row.source_data||{});if(!source.taxScope)return;
  await row.update({invoice_type:null,status:'pending',reason:'十月临时分类依据不能推广到当前库存或其他月份',
    source_data:{...source,taxScope:null,supersededScopedTax:{scope:source.taxScope,invoiceType:row.invoice_type}},
    revision:Number(row.revision)+1,updated_by:'system',update_time:new Date()},{transaction});
}
async function bind(referenceKey, basisId, storeId, transaction) {
  const existing = await M.InventoryFoundationRef.findByPk(referenceKey, { transaction, lock: transaction.LOCK.UPDATE });
  if (existing && existing.basis_id !== basisId) fail('记录已有不同基础档案关联，不能自动覆盖');
  if (!existing) await M.InventoryFoundationRef.create({ reference_key: referenceKey, basis_id: basisId, store_id: storeId }, { transaction });
}
async function update(basisId, body, user, transaction) {
  const row = await M.InventoryFoundation.findByPk(basisId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) fail('基础档案不存在',404);
  if(json(row.source_data||{}).identityConflict)fail('商品身份存在冲突，请先核实原始关联，不能仅修改金额或票种');
  if (Number(body.revision) !== Number(row.revision)) fail('基础资料已变化，请刷新后重试');
  if (!String(body.reason || '').trim()) fail('请填写修改依据',400);
  if (![null,'收据','专票13%'].includes(body.invoiceType)) fail('含税属性无效',400);
  for (const key of ['purchaseCost','companyPrice']) if (body[key] !== null &&
    (!['number','string'].includes(typeof body[key]) || !/^\d{1,12}(\.\d{1,2})?$/.test(String(body[key])) || money(body[key]) === null)) fail('金额须为非负数、最多两位小数，或明确留空',400);
  if (body.purchaseCost === 0 && body.confirmZero !== true) fail('零采购成本须明确确认',400);
  if (![null,'COMPANY_PRICE','PURCHASE_PRICE'].includes(body.costMode)) fail('计价方式无效',400);
  if(body.costMode==='COMPANY_PRICE'&&body.companyPrice!==null&&body.purchaseCost!==null&&Number(body.companyPrice)<Number(body.purchaseCost)&&body.confirmBelowCost!==true)fail('公司定价低于采购成本，请明确确认',400);
  const before = row.toJSON();
  await row.update({ invoice_type: body.invoiceType, purchase_cost: body.purchaseCost, cost_mode: body.costMode,
    company_price: body.companyPrice, status: body.invoiceType ? 'confirmed' : 'pending', reason: body.reason,
    source_data:{...json(row.source_data||{}),taxScope:null,costEstimated:false},
    revision: Number(row.revision)+1, updated_by: user.name, update_time: new Date() }, { transaction });
  await recordBusinessAction({ businessType:'inventory_foundation',businessId:basisId,action:'update_foundation',user,
    comment:body.reason,detail:{before,after:row.toJSON(),note:'归档金额不自动重写，需通过原有纠错流程预览审批'},transaction });
  return view(row.toJSON());
}
module.exports = { id, money, snKey, view, mergeCandidates, matchesLine, load, salesBasis, applySalesTaxBasis, applySalesPricing, ensureSalesReferences, clearScopedTax, bind, update };
