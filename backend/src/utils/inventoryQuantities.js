const FIELDS=['normal_qty','display_qty','demo_qty','unsellable_qty','pending_qty','rental_demo_qty'];
function getInventoryQuantitySnapshot(inv,locationType='') {
 const regularQty=Number(inv.regular_qty||0),subsidyQty=Number(inv.subsidy_qty||0),secondQty=Number(inv.second_qty||0);
 const effectiveNormal=Number(inv.normal_qty||0)>0?Number(inv.normal_qty):regularQty+subsidyQty+secondQty;
 const snapshot={normal_qty:effectiveNormal,regular_qty:regularQty,subsidy_qty:subsidyQty,second_qty:secondQty,
  display_qty:Number(inv.display_qty||0),demo_qty:Number(inv.demo_qty||0),unsellable_qty:Number(inv.unsellable_qty||0),pending_qty:Number(inv.pending_qty||0),rental_demo_qty:Number(inv.rental_demo_qty||0)};
 const type=String(locationType||'').trim();
 if(FIELDS.includes(type)&&type!=='normal_qty'){
  snapshot[type]=Math.max(snapshot[type],effectiveNormal);
  for(const field of FIELDS)if(field!==type)snapshot[field]=0;
  snapshot.regular_qty=0;snapshot.subsidy_qty=0;snapshot.second_qty=0;
 }
 return snapshot;
}
module.exports={FIELDS,getInventoryQuantitySnapshot};
