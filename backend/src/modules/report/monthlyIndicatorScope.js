const {OVERDUE_MIN_DAYS}=require('../../utils/inventoryAgePolicy');
function matchesAbilityRow(row,scope){
 if(!scope?.abilityType)return true;
 if(scope.abilityType==='source')return (scope.customerSources||[]).includes(row.customerSource);
 if(row.scopeIdentityMissing)return null;
 if(!row.snCode)return false;
 if(scope.abilityType==='overdue')return row.saleAgeDays===null||row.saleAgeDays===undefined?null:Number(row.saleAgeDays)>=OVERDUE_MIN_DAYS;
 if(scope.abilityType==='special'){
  const lines=typeof row.pricingDetails==='string'?JSON.parse(row.pricingDetails):row.pricingDetails||[];
  const item=lines.find(x=>String(x.itemId)===String(row.itemId));
  if(!item||typeof item.isSpecialPrice!=='boolean')return null;
  return item.isSpecialPrice===true;
 }
 return false;
}
module.exports={matchesAbilityRow};
