// Existing purchase-receipt return flow requires the original purchase document.
// Sales returns, transfers and batch inventory are stock provenance, not supplier return vouchers.
function supplierReturnEligibility(inbound={}){
 if(inbound.status!=='completed')return {can_request_return:false,supplier_return_reason:'只有已完成的采购入库单才能在此申请退供应商'};
 if(String(inbound.source_type||'').toLowerCase()!=='purchase')return {can_request_return:false,supplier_return_reason:'该单不是采购入库单，不能作为退供应商的采购凭证；请先追溯原采购来源和当前库存位置'};
 if(!inbound.purchase_request_id)return {can_request_return:false,supplier_return_reason:'该入库单未关联原采购申请，需先核实供应商及采购来源'};
 return {can_request_return:true,supplier_return_reason:''};
}
module.exports={supplierReturnEligibility};
