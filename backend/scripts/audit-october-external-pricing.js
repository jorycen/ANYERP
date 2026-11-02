// Read-only monthly audit. Current supplier settings are clues, not proof of a historical mistake.
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const M = require('../src/models');
const { Op, QueryTypes } = require('sequelize');
const GP = require('../src/modules/sales/grossProfit');
const parse = value => typeof value === 'string' ? JSON.parse(value || '[]') : value || [];
const amount = value => Number(value || 0);
const time = value => value ? new Date(value).getTime() : NaN;
const cents = value => Math.round(amount(value) * 100);
const unique = values => [...new Set(values.filter(Boolean).map(String))];

function assessPricing(line, receipt, sn, supplier, archiveAt) {
  const eligible = GP.isExternalAdjustmentEligibleProduct({ category: line.category, productName: line.productName, accessoryType: line.accessoryType });
  if (!eligible || !line.snCode || line.correctionId || line.source === 'approved_settlement_price_correction') return null;
  const purchase = amount(line.purchasePrice);
  if (!(purchase > 0)) return null;
  const receiptAgrees = receipt && cents(receipt.unit_price) === cents(purchase);
  const snUnchanged = sn && cents(sn.inbound_price) === cents(purchase) && time(sn.inbound_time) <= time(archiveAt);
  const uplift = receiptAgrees && receipt.uplift !== null ? amount(receipt.uplift)
    : snUnchanged && sn.gross_profit_uplift_amount !== null ? amount(sn.gross_profit_uplift_amount) : 0;
  const explicitPurchase = receiptAgrees && (String(receipt.mode_flag) === '0' || receipt.purchase_mode === 'PURCHASE_PRICE');
  const company = line.isCompanyPriced === true || line.source === 'product_standard_price';
  const nonProvider = supplier && Number(supplier.is_service_provider) === 0;
  const supplierPurchaseOnly = supplier?.purchase_cost_mode_allowed === 'PURCHASE_PRICE';
  if (!(uplift > 0)) return null;
  if (company && !(explicitPurchase || (nonProvider && supplierPurchaseOnly))) return null;
  return { company, purchase, uplift, explicitPurchase, receiptAgrees, snUnchanged,
    certainty: company ? explicitPurchase ? '采购来源明确按采购价，与归档冲突' : '疑似：当前供应商限制支持，缺少历史选择依据' : '采购价口径核对外调费' };
}

async function audit() {
  const results = await M.sequelize.transaction({ readOnly: true }, async transaction => {
    const q = (sql, replacements = {}) => M.sequelize.query(sql, { type: QueryTypes.SELECT, replacements, transaction });
    const orders = await q(`SELECT o.ORDER_ID order_id,o.ORDER_NO order_no,o.STORE_ID store_id,o.ORDER_STATUS status,
      o.ARCHIVE_TIME archive_time,o.INVOICE_STATUS invoice_status,g.SNAPSHOT_STATUS snapshot_status,
      g.RECEIVABLE_AMOUNT receivable_amount,g.PRODUCT_PRICING_AMOUNT product_pricing_amount,
      g.PAYMENT_FEE_DETAILS payment_fee_details,g.PRODUCT_PRICING_DETAILS product_pricing_details,
      g.SUPPLEMENT_DETAILS supplement_details,g.INVOICE_AMOUNT invoice_amount,g.GROSS_PROFIT_AMOUNT gross_profit_amount
      FROM T_ORDER o LEFT JOIN T_ORDER_GROSS_PROFIT g ON g.ORDER_ID=o.ORDER_ID
      WHERE o.CREATE_TIME>='2026-10-01 00:00:00' AND o.CREATE_TIME<'2026-11-01 00:00:00'
        AND o.IS_DELETED=0 AND o.ORDER_STATUS IN (:statuses) ORDER BY o.ORDER_NO`,
    { statuses: ['已归档', 'archived', 'completed', 'returned'] });
    const ids = orders.map(row => row.order_id);
    const items = await M.OrderItem.findAll({ where: { order_id: { [Op.in]: ids } },
      attributes: ['item_id', 'order_id', 'product_id', 'product_name', 'sn_id', 'sn_code', 'quantity', 'freight_cost'], raw: true, transaction });
    const productIds = unique(items.filter(row => row.sn_code && row.sn_code !== '0').map(row => row.product_id));
    const sns = await M.ProductSn.findAll({ where: { product_id: { [Op.in]: productIds } },
      attributes: ['sn_id', 'sn_code', 'product_id', 'supplier_id', 'inbound_price', 'inbound_time', 'gross_profit_uplift_amount'], raw: true, transaction });
    const suppliers = await M.Supplier.findAll({ attributes: ['supplier_id', 'name', 'is_service_provider', 'purchase_cost_mode_allowed'], raw: true, transaction });
    const stores = await M.Store.findAll({ attributes: ['store_id', 'name'], raw: true, transaction });
    const receipts = await q(`SELECT ii.ITEM_ID receipt_id,ii.PRODUCT_ID product_id,
      COALESCE(ins.SN_ID,ii.SN_ID) sn_id,COALESCE(ins.SN_CODE,ii.SN_CODE) sn_code,
      ii.UNIT_PRICE unit_price,ii.GROSS_PROFIT_USE_STANDARD_PRICE mode_flag,ii.GROSS_PROFIT_UPLIFT_AMOUNT uplift,
      pri.GROSS_PROFIT_COST_MODE purchase_mode,pr.SUPPLIER_ID supplier_id,
      i.SOURCE_TYPE source_type,i.PURCHASE_REQUEST_ID source_id,i.SOURCE_NO source_no,
      COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME) received_at
      FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID
      LEFT JOIN T_INBOUND_ITEM_SN ins ON ins.INBOUND_ITEM_ID=ii.ITEM_ID
      LEFT JOIN T_PURCHASE_REQUEST_ITEM pri ON pri.ITEM_ID=ii.PURCHASE_REQUEST_ITEM_ID
      LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
      WHERE ii.PRODUCT_ID IN (:productIds) AND i.STATUS='completed'
        AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<'2026-11-01 00:00:00'`, { productIds });
    const freight = await q(`SELECT fi.ITEM_ID item_id,fi.PRODUCT_ID product_id,fi.SN_ID sn_id,fi.SN_CODE sn_code,
      fi.QUANTITY quantity,fi.UNIT_AMOUNT unit_amount,fi.ALLOCATED_AMOUNT allocated_amount,fi.CREATE_TIME item_time,
      f.FREIGHT_ID freight_id,f.SOURCE_TYPE source_type,f.SOURCE_ID source_id,f.SOURCE_NO source_no,
      f.STORE_ID store_id,f.TO_STORE_ID to_store_id,f.PLATFORM_NAME platform_name,f.CREATE_TIME create_time,f.UPDATE_TIME update_time
      FROM T_FREIGHT_RECORD_ITEM fi JOIN T_FREIGHT_RECORD f ON f.FREIGHT_ID=fi.FREIGHT_ID
      WHERE fi.PRODUCT_ID IN (:productIds) AND f.STATUS='active'
        AND f.CREATE_TIME<'2026-11-01 00:00:00' ORDER BY fi.CREATE_TIME DESC,fi.ITEM_ID DESC`, { productIds });
    const snById = new Map(sns.map(row => [row.sn_id, row]));
    const snByCode = new Map(sns.map(row => [row.product_id + ':' + row.sn_code, row]));
    const supplierById = new Map(suppliers.map(row => [row.supplier_id, row]));
    const storeById = new Map(stores.map(row => [row.store_id, row.name]));
    const itemsByOrder = new Map();
    for (const item of items) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push(item);
    }
    const details = [], feeFindings = [], freightFindings = [], review = [], impacts = [];
    let validSnapshots = 0;
    for (const order of orders) {
      const base = { 订单: order.order_no, 门店: storeById.get(order.store_id) || order.store_id, 状态: order.status };
      if (order.snapshot_status !== 'final' || !order.archive_time) { review.push({ ...base, 原因: '缺少最终快照或归档时间' }); continue; }
      validSnapshots++;
      const lines = parse(order.product_pricing_details), supplements = parse(order.supplement_details);
      const storedFreight = supplements.filter(row => row.source === 'freight_cost');
      const itemMap = new Map((itemsByOrder.get(order.order_id) || []).map(row => [String(row.item_id), row]));
      const proposed = lines.map(row => ({ ...row }));
      const nextFreight = storedFreight.map(row => ({ ...row }));
      const assumptions = [], candidates = [];
      const manualFreight = supplements.some(row => row.source !== 'freight_cost' && /运费|物流|闪送/.test(`${row.itemName || ''} ${row.content || ''}`) && amount(row.amount) > 0);
      for (const line of lines) {
        const item = itemMap.get(String(line.itemId));
        if (!item || !line.snCode || line.snCode === '0') continue;
        const sn = snById.get(item.sn_id) || snByCode.get(item.product_id + ':' + line.snCode);
        const origins = receipts.filter(row => row.product_id === item.product_id && time(row.received_at) <= time(order.archive_time)
          && ((item.sn_id && row.sn_id === item.sn_id) || (!row.sn_id && row.sn_code === line.snCode) || (!item.sn_id && row.sn_code === line.snCode)));
        const purchaseReceipts = origins.filter(row => String(row.source_type).toLowerCase() === 'purchase')
          .sort((a,b) => time(b.received_at) - time(a.received_at));
        const receipt = purchaseReceipts.find(row => cents(row.unit_price) === cents(line.purchasePrice)) || purchaseReceipts[0];
        const supplier = supplierById.get(line.supplierId || receipt?.supplier_id || sn?.supplier_id);
        const assessment = assessPricing(line, receipt, sn, supplier, order.archive_time);
        if (assessment) {
          const proposedLine = proposed.find(row => String(row.itemId) === String(line.itemId));
          Object.assign(proposedLine, { unitPricing: assessment.purchase, pricingAmount: GP.roundMoney(assessment.purchase * line.quantity),
            isCompanyPriced: false, source: 'purchase_price', grossProfitUpliftAmount: assessment.uplift, externalAdjustmentEligible: true });
          const finding = { ...base, SN: line.snCode, 商品: line.productName, 供应商: supplier?.name || line.supplierName,
            原计价: amount(line.unitPricing), 归档采购价: assessment.purchase, 原入库采购单: receipt?.source_no || '',
            采购单计价方式: receipt?.purchase_mode || '', 入库计价快照: receipt?.mode_flag ?? '',
            外调额度: assessment.uplift, 是否公司定价: assessment.company, 判断: assessment.certainty };
          candidates.push(finding);
          if (assessment.company) { details.push(finding); assumptions.push(assessment.certainty); }
        }
        const applicable = freight.filter(row => row.product_id === item.product_id).filter(row => {
          const value = { ...row, freightRecord: row };
          return GP.matchesFreightOrigin(item, value, origins) && GP.isFreightRecordApplicableToOrder({
            orderStoreId: order.store_id, orderArchiveAt: order.archive_time, sourceType: row.source_type,
            storeId: row.store_id, toStoreId: row.to_store_id, sourceCreatedAt: row.create_time, sourceUpdatedAt: row.update_time });
        });
        const exact = applicable.filter(row => (item.sn_id && row.sn_id === item.sn_id) || (row.sn_code && row.sn_code === line.snCode));
        const selected = (exact.length ? exact : applicable)[0];
        const stored = storedFreight.filter(row => String(row.itemId) === String(line.itemId)).reduce((sum,row) => sum + amount(row.amount),0);
        const expected = selected ? GP.roundMoney(amount(selected.unit_amount || amount(selected.allocated_amount) / Math.max(1, amount(selected.quantity))) * amount(line.quantity)) : 0;
        if (expected > stored + 0.005) {
          freightFindings.push({ ...base, SN: line.snCode, 商品: line.productName, 原自动运费: stored, 来源运费: expected,
            差额: GP.roundMoney(expected - stored), 来源单号: selected.source_no, 平台: selected.platform_name,
            判断: manualFreight ? '已有手工运费补录，需核对重复' : '来源及归档时间匹配，自动运费少计' });
          if (!manualFreight) {
            for (let i=nextFreight.length-1;i>=0;i--) if (String(nextFreight[i].itemId)===String(line.itemId)) nextFreight.splice(i,1);
            nextFreight.push({ source: 'freight_cost', itemId: line.itemId, amount: expected, freightId: selected.freight_id });
          }
        }
      }
      const calculate = (pricing, freightRows) => GP.calculateGrossProfitValues({ receivableAmount: order.receivable_amount,
        productPricingDetails: pricing, paymentDetails: parse(order.payment_fee_details),
        supplementDetails: supplements.filter(row => row.source !== 'freight_cost'), freightCostDetails: freightRows,
        invoiceAmount: order.invoice_amount, invoiceStatus: order.invoice_status });
      const before = calculate(lines, storedFreight), after = calculate(proposed, nextFreight);
      for (const finding of candidates) {
        finding.拟纠正后需扣外调费 = after.externalAdjustmentFee;
        finding.原外调费 = before.externalAdjustmentFee;
        finding.外调费疑似漏计 = after.externalAdjustmentFee > before.externalAdjustmentFee + 0.005;
        if (finding.外调费疑似漏计) feeFindings.push(finding);
      }
      if (candidates.length || nextFreight.length !== storedFreight.length || cents(after.freightCostAmount)!==cents(before.freightCostAmount)) {
        impacts.push({ ...base, 疑似计价商品数: candidates.filter(row => row.是否公司定价).length,
          外调费疑似漏计: after.externalAdjustmentFee > before.externalAdjustmentFee + 0.005,
          原毛利: amount(order.gross_profit_amount), 假设修正后毛利: after.grossProfitAmount,
          假设差额: GP.roundMoney(after.grossProfitAmount - amount(order.gross_profit_amount)),
          原快照与当前公式可复核: cents(before.grossProfitAmount)===cents(order.gross_profit_amount),
          定价需确认: assumptions.length > 0, 原外调费: before.externalAdjustmentFee, 假设修正后外调费: after.externalAdjustmentFee,
          原运费: before.freightCostAmount, 来源运费核对后: after.freightCostAmount });
      }
    }
    const active = rows => rows.filter(row => row.状态 !== 'returned');
    const countOrders = rows => unique(rows.map(row => row.订单)).length;
    const summary = { month: '2026-10', dateBasis: '订单创建日期，北京时间；不包含已作废和未归档订单',
      orders: orders.length, archivedOrders: orders.filter(row => row.status !== 'returned').length,
      returnedOrders: orders.filter(row => row.status === 'returned').length, validSnapshots,
      suspectedPricingOrders: countOrders(active(details)), suspectedPricingLines: active(details).length,
      explicitModeConflictOrders: countOrders(active(details).filter(row => row.判断.startsWith('采购来源明确'))),
      potentialMissingExternalFeeOrders: countOrders(active(impacts).filter(row => row.外调费疑似漏计)),
      freightOmissionOrders: countOrders(active(freightFindings).filter(row => !row.判断.startsWith('已有'))),
      freightManualReviewOrders: countOrders(active(freightFindings).filter(row => row.判断.startsWith('已有'))),
      affectedUniqueOrders: countOrders(active(impacts).filter(row => row.疑似计价商品数 || row.外调费疑似漏计 || cents(row.原运费)!==cents(row.来源运费核对后))),
      missingSnapshotReviewOrders: review.length, archivedMissingSnapshotOrders: active(review).length, generatedAt: new Date().toISOString(),
      warning: '当前供应商限制不证明历史选择错误；金额仅假设预览。未重写订单，退货单不合并影响。' };
    return { summary, pricing: details, externalFee: feeFindings, freight: freightFindings, impact: impacts, review };
  });
  const dir = path.resolve(__dirname, '../backup/october-external-pricing-audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir,'audit.json'), JSON.stringify(results,null,2));
  const wb = XLSX.utils.book_new();
  for (const [name,rows] of [['汇总',Object.entries(results.summary).map(([key,value])=>({指标:key,结果:String(value)}))],
    ['疑似计价',results.pricing],['外调费核对',results.externalFee],['运费核对',results.freight],['订单影响假设',results.impact],['待核对',results.review]]) {
    const ws = XLSX.utils.json_to_sheet(rows); ws['!cols'] = Object.keys(rows[0]||{}).map(()=>({wch:24}));
    XLSX.utils.book_append_sheet(wb,ws,name);
  }
  const output = path.join(dir,'2026年10月外调计价与运费核查.xlsx'); XLSX.writeFile(wb,output);
  return { ...results.summary, output,
    knownOrders: results.impact.filter(row => ['ORD202610190619315159','ORD202610171232599799'].includes(row.订单)),
    sample: results.pricing.filter(row => row.状态 !== 'returned').slice(0,5) };
}
if (require.main===module) audit().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
module.exports={assessPricing};
