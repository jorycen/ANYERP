// Explicitly authorized single-SN repair; preserves original foundation and stock facts.
const M = require('../src/models');
const F = require('../src/modules/inventory/foundation');
const intake = require('../src/modules/inventory/foundationIntake');
async function run() {
  intake.enable();
  await M.sequelize.transaction(async transaction => {
    const sn = await M.ProductSn.findByPk('3e8bba9d7cf341529110d06670b7df61', {transaction,lock:transaction.LOCK.UPDATE});
    if (sn.sn_code !== 'PF6FFLT5' || sn.product_id !== 'e810d2124aa54be09059f254d42c034c' || sn.status !== 'in_stock' || Number(sn.inbound_price) !== 25750) throw Error('SN已变化，停止');
    const item = await M.InboundItem.findByPk(4898, {transaction});
    const inbound = await M.Inbound.findByPk(item.inbound_id, {transaction});
    const purchaseItem = await M.PurchaseRequestItem.findByPk(item.purchase_request_item_id, {transaction});
    const purchase = await M.PurchaseRequest.findByPk(purchaseItem.request_id, {transaction});
    if (item.product_id !== sn.product_id || item.sn_id !== sn.sn_id || Number(item.unit_price) !== 25750 || !purchase) throw Error('新入库依据不匹配');
    const receipt = {productId:sn.product_id,purchaseId:purchase.request_id,purchaseNo:purchase.request_no,receiptItemId:item.item_id,invoiceType:purchase.invoice_type,unitCost:25750,costMode:'COMPANY_PRICE'};
    const logId = 'repairPF6FFLT5cycle20261117';
    if (!await M.SnLog.findByPk(logId,{transaction})) await M.SnLog.create({log_id:logId,sn_id:sn.sn_id,sn_code:sn.sn_code,product_id:sn.product_id,store_id:sn.store_id,action:'stock_cycle_reentry',remark:JSON.stringify({document:inbound.inbound_no,fromStatus:'returned',repair:true,reason:'补齐退库后新采购入库周期',receiptItemId:4898}),create_user:'用户授权修复',create_time:item.receive_time},{transaction});
    await intake.captureSn(sn,{transaction,foundationReceipt:receipt});
    const ref = await M.InventoryFoundationRef.findByPk('sn_current:'+sn.sn_id,{transaction});
    const basis = await M.InventoryFoundation.findByPk(ref.basis_id,{transaction});
    if(basis.product_id!==sn.product_id || Number(basis.purchase_cost)!==25750 || basis.cost_mode!=='COMPANY_PRICE') throw Error('修复验证失败');
    console.log(JSON.stringify({sn:sn.sn_code,basis:F.view(basis.toJSON()),purchase:purchase.request_no}));
  });
}
run().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>M.sequelize.close());
