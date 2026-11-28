function ids(value) {
 const result=[...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(v=>String(v).trim()).filter(Boolean))];
 if(!result.length||result.length>100)throw Object.assign(new Error('请选择1至100张单据'),{status:400});
 return result;
}
function totals(rows,key){
 if(rows.some(row=>row[key]===null||row[key]===undefined||!Number.isFinite(Number(row[key]))))throw Object.assign(new Error('单据金额缺失，请核实后统计'),{status:400});
 return {selectedCount:rows.length,totalAmount:Math.round(rows.reduce((sum,row)=>sum+Math.round(Number(row[key])*100),0))/100};
}
async function submit(ctx,handler,key){
 const selected=ids(ctx.request.body.ids),results=[];
 for(const id of selected){
  const child={state:{...ctx.state},params:{id},request:{body:{settlementId:id}},throw:ctx.throw.bind(ctx)};
  try{await handler(child);if(child.body?.code!==0)throw new Error(child.body?.message||'提交失败');results.push({id,success:true,message:child.body.message});}
  catch(error){results.push({id,success:false,message:error.message||'提交失败'});}
 }
 ctx.body={code:0,data:{results,successCount:results.filter(row=>row.success).length,failedCount:results.filter(row=>!row.success).length}};
}
module.exports={ids,totals,submit};
