const c=(key,label,format='money')=>({key,label,format});
const identity=[c('employeeName','员工 / 负责人','text'),c('storeName','门店','text'),c('role','角色','text')];
const gross=[c('grossProfit','毛利'),c('expensePerformanceDeduction','费用扣减'),c('netGrossProfit','扣减后毛利')];
function columns(role){
 if(['product','operations'].includes(role))return [...identity,c('grossProfit',role==='product'?'产品端毛利':'运营端毛利'),c('commission','提成','pending'),c('remark','备注','text')];
 if(role==='staff')return [...identity,...gross,c('commissionBase','提成基数'),c('salesCommission','销售端提成'),c('remark','备注','text')];
 if(role==='manager')return [...identity,...gross,c('storeGrossProfit','门店销售端毛利'),c('breakEvenLine','盈亏平衡线'),c('personalRate','个人提成比例','percent'),c('salesCommission','个人销售提成'),c('storeCommission','门店提成'),c('performanceEstimate','绩效合计'),c('remark','备注','text')];
 return [...identity,c('sideName','所属端','text'),...gross,c('performanceEstimate','绩效预估'),c('remark','备注','text')];
}
function display(row,column){
 if(row.rule==='staff'&&['storeGrossProfit','breakEvenLine','personalRate','storeCommission'].includes(column.key))return '';
 if(row.rule==='manager'&&column.key==='commissionBase')return '';
 const value=row[column.key];
 if(column.format==='text')return value??'';
 if(column.format==='pending')return '待定';
 if(value==null)return row.sideName!=='销售端'&&['expensePerformanceDeduction','netGrossProfit'].includes(column.key)?'':column.key==='performanceEstimate'&&row.sideName!=='销售端'?'待定':row.status==='unconfigured'?'待配置':'待核算';
 return column.format==='percent'?`${Number(value)*100}%`:value;
}
module.exports={columns,display};
