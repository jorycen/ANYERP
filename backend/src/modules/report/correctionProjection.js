const plain=row=>row?.toJSON?row.toJSON():{...row};
const parse=value=>typeof value==='string'?JSON.parse(value):value||{};
const virtual=data=>({...data,toJSON(){return {...data}}});
// The effective view is made from approved immutable differences, not by writing
// the archived snapshot again. Latest 'after' includes earlier approved changes.
function project(state,history){
 let result=state;
 for(const row of history){
  const saved=parse(row.correction_data);
  if(saved.postingVersion!=='APPROVED_DIFFERENCE_V2')continue;
  const after=saved.result?.after;if(!after?.snapshot)throw Error('已批准调整缺少生效快照，请核实');
  result={...result,snapshot:virtual({...plain(result.snapshot),...after.snapshot}),
   settlement:after.settlement?virtual({...plain(result.settlement),...after.settlement}):result.settlement,
   items:after.items?after.items.map(virtual):result.items};
 }
 return result;
}
module.exports={project};
