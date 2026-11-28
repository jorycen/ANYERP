const c=(key,label,format='money')=>({key,label,format});
const identity=[c('employeeName','员工 / 负责人','text'),c('storeName','门店','text'),c('role','角色','text')];
const gross=[c('grossProfit','毛利'),c('expensePerformanceDeduction','费用扣减'),c('netGrossProfit','扣减后毛利')];
function columns(role){
 if(['product','operations'].includes(role))return [...identity,c('sourceLabel','来源','text'),c('orderNo','订单号','text'),c('businessDate','业务日期','text'),c('grossProfit',role==='product'?'产品端毛利':'运营端毛利'),c('commission','提成','pending'),c('remark','备注','text')];
 if(role==='staff')return [...identity,...gross,c('commissionBase','提成基数'),c('salesCommission','销售端提成'),c('remark','备注','text')];
 if(role==='manager')return [...identity,...['performanceEstimate','salesCommission','storeCommission'].map((key,i)=>({...c(key,['绩效合计','个人销售提成','门店提成'][i]),bold:true})),...gross,c('commissionStoreNames','门店提成归属门店','text'),c('storeGrossProfit','门店提成归属毛利'),
   c('lowGrossProfit','15%阶段个人毛利'),c('lowDeduction','15%阶段费用扣减'),c('lowNetGrossProfit','15%阶段扣减后毛利'),c('lowCommission','15%阶段提成'),
   c('highGrossProfit','25%阶段个人毛利'),c('highDeduction','25%阶段费用扣减'),c('highNetGrossProfit','25%阶段扣减后毛利'),c('highCommission','25%阶段提成'),
   c('remark','备注','text')];
 return [...identity,c('sideName','所属端','text'),...gross,c('performanceEstimate','绩效预估'),c('remark','备注','text')];
}
function display(row,column){
 if(row.historicalStoreOwner&&['storeGrossProfit','storeCommission'].includes(column.key))return row[column.key]??'待核算';
 if(row.rule==='staff'&&['storeGrossProfit','breakEvenLine','personalRate','storeCommission','lowGrossProfit','highGrossProfit','lowDeduction','highDeduction','lowNetGrossProfit','highNetGrossProfit','lowCommission','highCommission'].includes(column.key))return '';
 if(row.rule==='manager'&&column.key==='commissionBase')return '';
 const value=row[column.key];
 if(column.format==='text')return value??'';
 if(column.format==='pending')return '待定';
 if(value==null)return row.sideName!=='销售端'&&['expensePerformanceDeduction','netGrossProfit'].includes(column.key)?'':column.key==='performanceEstimate'&&row.sideName!=='销售端'?'待定':row.status==='unconfigured'?'待配置':'待核算';
 return column.format==='percent'?`${Number(value)*100}%`:value;
}
module.exports={columns,display};
