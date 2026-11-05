const LEGACY_VERSION = 'PURCHASE_VAT_V1_20261104';
const VERSION = 'PURCHASE_VAT_V2_20261105';
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function normalizeInvoiceType(value) {
  if (value === '收据' || value === '未税（收据或普票）') return '收据';
  if (['专票13%', '增专票（13%）', '增值税专用发票13%', '13%含税'].includes(value)) return '专票13%';
  return null;
}
function isService(line) {
  const name = String(line.productName || '');
  return /^ANY-CARE-/i.test(String(line.pnCode||'')) || ['Care服务','服务'].includes(line.category) || /清灰|装系统|系统安装|系统重装|CARE/i.test(name) || /^联想\s*服务\s/.test(name) || /^检测[－-]专业检测$/.test(name)
    || /^(服务|延保)[－-]/.test(name) || /^电脑检测维修$/.test(name);
}
function taxError(message, pendingItems = []) {
  return Object.assign(new Error(message), { status: 409, code: 'ORDER_PURCHASE_TAX_PENDING', pendingItems });
}
function calculateVat(lines, invoiceAmount, invoiceStatus) {
  if (String(invoiceStatus).trim() === '不开票' || Number(invoiceAmount) === 0) return { taxableAmount: 0, amount: 0 };
  const bases = lines.map(x => x.purchaseTaxBasis);
  const pending = lines.filter(x => !x.purchaseTaxBasis || ![VERSION,LEGACY_VERSION].includes(x.purchaseTaxBasis.version) || x.purchaseTaxBasis.status !== 'confirmed');
  if (pending.length) {
    const items=pending.map(x=>({itemId:x.itemId,productName:x.productName||'',pnCode:x.pnCode||'',reason:x.purchaseTaxBasis?.reason||'采购票税依据缺失'}));
    const names=items.map(x=>(x.productName||x.pnCode||'商品')+(x.pnCode?'（'+x.pnCode+'）':''));
    throw taxError('采购票税依据待核实：'+names.slice(0,3).join('、')+(items.length>3?'等'+items.length+'项':''),items);
  }
  if (new Set(bases.map(x => x.version)).size > 1) throw taxError('税费规则版本不一致');
  if (bases.some(x => !Number.isFinite(Number(x.purchaseAmount)) || Number(x.purchaseAmount) < 0 ||
    (x.service ? Number(x.purchaseAmount) !== 0 : !['收据', '专票13%'].includes(x.invoiceType)))) {
    throw taxError('采购票税金额或凭证类型无效');
  }
  const modes = new Set(bases.filter(x => !x.service).map(x => x.invoiceType));
  if (modes.size > 1 && bases.some(x => x.version === LEGACY_VERSION)) throw taxError('采购票税类型不一致，须核实历史数据');
  const receipt = modes.size === 1 && modes.has('收据');
  const cost = receipt ? 0 : money(bases.reduce((s, x, index) => {
    if (x.service || x.invoiceType === '收据') return s;
    const line = lines[index];
    if (x.version === VERSION && (line.isCompanyPriced === true || line.costModeSnapshot === 'COMPANY_PRICE' ||
      (line.isCompanyPriced === undefined && ['product_standard_price', 'sn_special_price', 'approved_settlement_price_correction', 'historical_pn_cost_override'].includes(line.source)))) {
      if (line.unitPricing === null || line.unitPricing === undefined || !Number.isFinite(Number(line.unitPricing)) || Number(line.unitPricing) < 0 || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) throw taxError('公司定价税费依据不完整');
      return s + money(Number(line.unitPricing) * Number(line.quantity));
    }
    return s + Number(x.purchaseAmount);
  }, 0));
  const taxableAmount = money(Math.max(0, Number(invoiceAmount) - cost));
  return { taxableAmount, amount: money(taxableAmount * 0.13) };
}
async function resolveDocumentTaxBasis(order, lines, transaction, originIndex = null, visited = new Set()) {
  const M = require('../../models');
  const { QueryTypes } = require('sequelize');
  const cutoff = new Date(new Date(order.archive_time || new Date()).getTime() + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
  const result = [];
  for (const line of lines) {
    if (line.pricingOrigin?.sourceType === 'sales_return' && !isService(line)) {
      if (line.purchasePrice === null || line.purchasePrice === undefined || !Number.isFinite(Number(line.purchasePrice))) {
        result.push({...line,purchaseTaxBasis:{version:VERSION,status:'pending',service:false,reason:'退货商品实际采购成本尚未确认'}}); continue;
      }
      const key = line.pricingOrigin.sourceNo + ':' + line.productId;
      if (visited.has(key)) { result.push({...line,purchaseTaxBasis:{version:VERSION,status:'pending',reason:'退货来源循环，需核实原单'}}); continue; }
      const nextVisited = new Set(visited); nextVisited.add(key);
      let traceReason='退货原单缺少可核对的销售明细';
      const returned = await M.SalesReturnRequest.findOne({where:{return_no:line.pricingOrigin.sourceNo,status:'completed'},raw:true,transaction});
      const matches = returned ? await M.SalesReturnRequestItem.findAll({where:{return_id:returned.return_id,product_id:line.productId},raw:true,transaction}) : [];
      const originalItem = matches.length === 1 && matches[0].order_item_id ? await M.OrderItem.findByPk(matches[0].order_item_id,{raw:true,transaction}) : null;
      const originalOrder = originalItem && returned && originalItem.order_id === returned.order_id && originalItem.product_id === line.productId
        ? await M.Order.findByPk(returned.order_id,{raw:true,transaction}) : null;
      const snapshot = originalOrder ? await M.OrderGrossProfit.findOne({where:{order_id:originalOrder.order_id},raw:true,transaction}) : null;
      const originalLines = typeof snapshot?.product_pricing_details === 'string' ? JSON.parse(snapshot.product_pricing_details) : snapshot?.product_pricing_details || [];
      const originals = originalLines.filter(x=>String(x.itemId)===String(originalItem?.item_id)&&x.productId===line.productId);
      if(matches.length>1 || originals.length>1)traceReason='退货商品身份不唯一，须核实原销售明细';
      if (originalOrder && originals.length === 1) {
        const original = {...originals[0],quantity:line.quantity};
        // October category assumptions cannot become November purchase facts.
        if (original.purchaseTaxBasis?.source === 'user_october_category_confirmation') delete original.purchaseTaxBasis;
        const foundation = (await require('../inventory/foundation').salesBasis(originalOrder,[original],transaction))[0]?.inventoryFoundation;
        if(foundation?.status==='conflict') {
          result.push({...line,purchaseTaxBasis:{version:VERSION,status:'pending',service:false,reason:'退货原单基础档案冲突：'+foundation.reason}}); continue;
        }
        if (foundation?.source?.taxScope) delete original.purchaseTaxBasis;
        if (foundation?.status === 'confirmed' && !foundation.source?.taxScope && foundation.invoiceType) {
          result.push({...line,purchaseTaxBasis:{version:VERSION,status:'confirmed',service:false,invoiceType:foundation.invoiceType,
            purchaseAmount:money(Number(line.purchasePrice)*Number(line.quantity)),source:'sales_return_original_foundation',basisId:foundation.basisId,
            originalOrderId:originalOrder.order_id,originalItemId:original.itemId,returnNo:line.pricingOrigin.sourceNo}});
          continue;
        }
        const traced = (await resolveDocumentTaxBasis(originalOrder,[original],transaction,null,nextVisited))[0].purchaseTaxBasis;
        traceReason=traced.reason || '退货原采购票税尚未确认';
        if (traced.status === 'confirmed') {
          result.push({...line,purchaseTaxBasis:{...traced,purchaseAmount:money(Number(line.purchasePrice)*Number(line.quantity)),
            source:'sales_return_original_purchase',originalOrderId:originalOrder.order_id,originalItemId:original.itemId,returnNo:line.pricingOrigin.sourceNo}});
          continue;
        }
      }
      result.push({...line,purchaseTaxBasis:{version:VERSION,status:'pending',service:false,reason:traceReason}});
      continue;
    }
    if (line.purchaseTaxBasis?.version === VERSION && line.purchaseTaxBasis.status === 'confirmed') { result.push(line); continue; }
    if (line.purchaseTaxBasis?.version === LEGACY_VERSION && line.purchaseTaxBasis.status === 'confirmed') {
      result.push({ ...line, purchaseTaxBasis: { ...line.purchaseTaxBasis, version: VERSION } }); continue;
    }
    let basis = { version: VERSION, status: 'pending', service: false, reason: '缺少可追溯采购来源' };
    if (isService(line)) basis = { version: VERSION, status: 'confirmed', service: true, purchaseAmount: 0, invoiceType: null, source: 'service_zero_purchase' };
    else {
      const receiptId = line.pricingOrigin?.receiptItemId;
      let rows = [];
      if (originIndex) rows = originIndex.get(line.snCode ? 'sn:' + line.snCode : receiptId ? 'receipt:' + receiptId : 'product:' + line.productId) || [];
      else if (line.snCode) rows = await M.sequelize.query(`SELECT DISTINCT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost
        FROM T_INBOUND_ITEM ii LEFT JOIN T_INBOUND_ITEM_SN rel ON ii.ITEM_ID=rel.INBOUND_ITEM_ID
        JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE (rel.SN_CODE=:sn OR ii.SN_CODE=:sn OR JSON_CONTAINS(IF(JSON_VALID(ii.RECEIVED_SN_CODES),ii.RECEIVED_SN_CODES,'[]'),JSON_QUOTE(:sn)))
          AND ii.PRODUCT_ID=:product AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { sn: line.snCode, product: line.productId, cutoff }, type: QueryTypes.SELECT, transaction });
      else if (receiptId) rows = await M.sequelize.query(`SELECT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost
        FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE ii.ITEM_ID=:receiptId AND ii.PRODUCT_ID=:product AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { receiptId, product: line.productId, cutoff }, type: QueryTypes.SELECT, transaction });
      else if (!line.snCode) rows = await M.sequelize.query(`SELECT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost, i.STORE_ID AS storeId, pr.SUPPLIER_ID AS supplierId
        FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE ii.PRODUCT_ID=:product AND i.STORE_ID=:store AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { product: line.productId, store: order.store_id, cutoff }, type: QueryTypes.SELECT, transaction });
      // Exact receipts/SNs prove tax provenance even when freight changes cost.
      // Without an exact receipt, return tracing requires all original-store /
      // supplier candidates to agree; never select an arbitrary recent purchase.
      const candidates = rows.filter(x => line.snCode || receiptId || (x.storeId === order.store_id && (!line.supplierId || x.supplierId === line.supplierId))).filter(x => x.productId === undefined || x.productId === line.productId).filter(x => !x.receiptTime || new Date(x.receiptTime) <= new Date(order.archive_time || Date.now())).filter(x => x.unitCost !== null && x.unitCost !== undefined && line.purchasePrice !== null && line.purchasePrice !== undefined &&
        (receiptId || line.snCode || visited.size > 0 || money(x.unitCost) === money(line.purchasePrice)));
      const unique = new Map(candidates.map(x => [x.purchaseId + ':' + x.unitCost + ':' + x.invoiceType, x]));
      if (unique.size === 1) {
        const row = [...unique.values()][0];
        basis = { version: VERSION, status: normalizeInvoiceType(row.invoiceType) ? 'confirmed' : 'pending', service: false,
          purchaseAmount: money(Number(row.unitCost) * Number(line.quantity)), invoiceType: normalizeInvoiceType(row.invoiceType), originalInvoiceType: row.invoiceType,
          purchaseId: row.purchaseId, purchaseNo: row.purchaseNo, receiptItemId: row.receiptItemId, reason: '以对应采购申请票据选择为准' };
      } else if (unique.size > 1) {
        const types = new Set([...unique.values()].map(x => normalizeInvoiceType(x.invoiceType)));
        if (types.size === 1 && !types.has(null)) basis = {
          version: VERSION, status: 'confirmed', service: false, invoiceType: [...types][0],
          purchaseAmount: money(Number(line.purchasePrice) * Number(line.quantity)),
          source: 'all_matching_purchase_candidates_agree',
          candidatePurchaseIds: [...new Set([...unique.values()].map(x => x.purchaseId))],
          reason: visited.size > 0 ? '退货原销售门店及供应商的全部候选采购票税一致，不指定具体批次' : '冻结成本匹配的所有候选采购票据口径一致，不指定具体批次'
        }; else basis.reason = '采购候选票据口径不唯一或不明确';
      }
    }
    if(!originIndex && visited.size===0 && basis.status==='pending' && basis.reason==='缺少可追溯采购来源') {
      basis=await require('../inventory/foundation').inventoryTaxConsensus(order,line,transaction)||basis;
    }
    result.push({ ...line, purchaseTaxBasis: basis });
  }
  return result;
}
// Historical migration audit may inspect old documents, but production readers
// all resolve editable facts through the same inventory foundation.
async function attachPurchaseTaxBasis(order, lines, transaction, originIndex = null) {
  if(originIndex)return resolveDocumentTaxBasis(order,lines,transaction,originIndex);
  return require('../inventory/foundation').applySalesTaxBasis(order,lines,transaction);
}
module.exports = { VERSION, LEGACY_VERSION, normalizeInvoiceType, isService, calculateVat, attachPurchaseTaxBasis, resolveDocumentTaxBasis };
