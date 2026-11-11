const crypto=require('node:crypto');
const maintenance=new Set(['update_time','calculated_at','calculated_by']);
function canonical(value){
 if(value instanceof Date)return value.toISOString();
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(k=>!maintenance.has(k)).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function fingerprint(input,before,order){return crypto.createHash('sha256').update(JSON.stringify(canonical({input,before,order}))).digest('hex');}
module.exports={fingerprint};
