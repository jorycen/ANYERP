// Read-only follow-up: distinguish manual coverage from unresolved freight evidence.
const fs=require('fs'),path=require('path'),XLSX=require('xlsx'),M=require('../src/models');
const parse=v=>typeof v==='string'?JSON.parse(v):v||[];
const resolved=new Map([
 ['ORD202610040750284125','手工21.45元等于来源21.45元，未发现还需补扣'],
 ['ORD202610070720550447','手工38.30元等于来源38.30元，未发现还需补扣'],
 ['ORD202610191211111101','自动22元＋补差7.20元＝来源29.20元，已补足'],
 ['ORD202610251044178441','手工20.10元等于来源20.10元，未发现还需补扣']
]);
const notes={
 ORD202610010732373335:'主机原自动19.75元与手工48.30元可能重复；来源为48.30元。另2元为配件运费，不能一并删除。',
 ORD202610070305216928:'原自动28元来自另一采购来源，另手工33.30元与本次来源33.30元相同，需核实是否两次独立运费。',
 ORD202610100639273750:'自动20元与手工23元来自不同来源，本次来源23元；需核对是否重复扣减原20元。',
 ORD202610130736182904:'自动5.50元、手工48元，本次来源48.30元；存在旧来源重复及手工金额0.30元差异线索。',
 ORD202610160954428326:'自动27.20元、手工27元，本次来源32元；需核实往返或重复费用，不直接按差额补扣。',
 ORD202610241238195546:'主机来源采购运费14元未自动带入；手工22元标记配送至客户，可能为独立费用。自动3.60元属于其他商品，需核对凭证。'
};
async function run(){
 const dir=path.resolve(__dirname,'../backup/october-external-pricing-audit');
 const audit=JSON.parse(fs.readFileSync(path.join(dir,'audit.json'),'utf8'));
 const pending=[],covered=[],confirmed=[];
 for(const finding of audit.freight.filter(row=>row.状态!=='returned')){
  const order=await M.Order.findOne({where:{order_no:finding.订单},raw:true});
  const gp=await M.OrderGrossProfit.findOne({where:{order_id:order.order_id},raw:true});
  const manual=parse(gp.supplement_details).filter(row=>row.source!=='freight_cost'&&/运费|物流|闪送/.test(`${row.itemName||''} ${row.content||''}`));
  const row={订单号:finding.订单,门店:finding.门店,SN:finding.SN,整单自动运费:Number(gp.freight_cost_amount),
   手工运费:manual.reduce((sum,x)=>sum+Number(x.amount||0),0),待核对来源运费:finding.来源运费,当前基础毛利:Number(gp.gross_profit_amount),
   核查结论:notes[finding.订单]||resolved.get(finding.订单)||'用户已确认实际总运费36元，已纠正；不按共享来源360元重新补扣'};
  if(finding.订单==='ORD202610190158486358')confirmed.push(row);
  else if(resolved.has(finding.订单))covered.push(row);
  else pending.push(row);
 }
 const returned=await M.Order.findOne({where:{order_no:'ORD202610181111109413'},attributes:['order_no','order_status'],raw:true});
 const result={scanScope:audit.summary,unresolved:pending,manualCovered:covered,confirmedCorrected:confirmed,
  returnedSharedOrder:returned,notes:'只读核查；6笔为待核对线索，不是已确认错误。7笔退货单缺快照另列，不直接按正常销售修数。'};
 fs.writeFileSync(path.join(dir,'remaining-review-20261102.json'),JSON.stringify(result,null,2));
 const wb=XLSX.utils.book_new();
 for(const [name,rows]of [['尚待核对6单',pending],['补录已覆盖4单',covered],['已确认修正',confirmed],['退货缺快照另列',audit.review]]){
  const sheet=XLSX.utils.json_to_sheet(rows);sheet['!cols']=Object.keys(rows[0]||{}).map(k=>({wch:k==='核查结论'?95:k.includes('订单')?29:20}));XLSX.utils.book_append_sheet(wb,sheet,name);
 }
 XLSX.writeFile(wb,path.join(dir,'10月尚未调整及已覆盖运费复核-20261102.xlsx'));
 console.log(JSON.stringify({pending:pending.length,covered:covered.length,confirmed:confirmed.length,returnedSharedOrder:returned}));
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
