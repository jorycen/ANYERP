function selectedPaths(value){
 let list=value||[];
 if(typeof list==='string'){try{list=JSON.parse(list);}catch{throw Object.assign(Error('重点分类参数格式不正确'),{status:400});}}
 if(!Array.isArray(list)||list.length>50||list.some(p=>typeof p!=='string'||!p.trim()||p.length>512))throw Object.assign(Error('重点分类最多选择50项'),{status:400});
 const paths=[...new Set(list.map(path=>path.split('/').map(p=>p.trim()).filter(Boolean).join('/')))];
 if(paths.some(path=>!path))throw Object.assign(Error('重点分类路径不能为空'),{status:400});
 return paths;
}
function configuredFocusCategories(categories) {
 return require('./dashboardDataSource').buildFinanceCategoryIndex(categories).nodes
  .filter(node => node.isFocusCategory && node.status === 1 && node.path);
}
function aggregateFocusCategories(rows,paths,canViewProfit=true){
 return paths.map(path=>{
  const matching=rows.filter(row=>{const value=String(row.categoryPath||row.category_path||row.category||'').split('/').map(v=>v.trim()).filter(Boolean).join('/');return value===path||value.startsWith(path+'/');});
  return {categoryPath:path,name:path.split('/').at(-1),productName:path.split('/').at(-1),quantity:Number(matching.reduce((sum,row)=>sum+Number(row.quantity||0),0).toFixed(2)),
   grossProfit:canViewProfit ? Math.round(matching.reduce((sum,row)=>sum+Math.round(Number(row.grossProfit||0)*100),0))/100 : null,
   salesAmount:Math.round(matching.reduce((sum,row)=>sum+Math.round(Number(row.salesAmount||0)*100),0))/100,
   unit:/^(笔记本|台机|台式机|手机|平板)(\/|$)/.test(path)?'台':'件'};
 });
}
module.exports={selectedPaths,aggregateFocusCategories,configuredFocusCategories};
