const X=require('xlsx'),crypto=require('node:crypto');
const M=require('../../models'),C=require('./commissionConfig'),H=require('./storeManagerHistory'),Review=require('./employeeProfitReview');
const {recordBusinessAction}=require('../../utils/businessActionLog');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const editable=new Set(['确认值','生效开始','生效结束','依据说明']);
function date(value){
 const text=value instanceof Date?value.toISOString().slice(0,19).replace('T',' '):String(value||'').trim();
 if(!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(text))fail('任期请填写YYYY-MM-DD或YYYY-MM-DD HH:mm:ss（北京时间）');
 const normalized=text.length===10?text+'T00:00:00':text.replace(' ','T'),parsed=new Date(normalized+'+08:00');
 if(!Number.isFinite(parsed.getTime())||new Date(parsed.getTime()+28800000).toISOString().slice(0,19)!==normalized)fail('任期日期或时间无效');
 return parsed.toISOString();
}
function parse(buffer){
 if(!buffer?.length||buffer.length>10*1024*1024)fail('请上传不超过10MB的核算清单xlsx');
 let wb;try{wb=X.read(buffer,{type:'buffer',cellDates:true,sheetRows:1002});}catch{fail('无法读取Excel，请使用下载的xlsx模板');}
 if(!wb.Sheets['待核算清单']||!wb.Sheets['系统校验'])fail('请使用新版下载的清单，保留系统校验页');
 for(const name of ['待核算清单','系统校验'])for(const cell of Object.values(wb.Sheets[name]))if(cell&&typeof cell==='object'&&cell.f)fail('上传清单不能包含公式');
 const rows=X.utils.sheet_to_json(wb.Sheets['待核算清单'],{defval:''}),meta=X.utils.sheet_to_json(wb.Sheets['系统校验'],{defval:''});
 if(rows.length>500||meta.length>500)fail('单次最多500行，请缩小筛选范围');
 if(!meta.length||meta.some(m=>String(m.版本)!=='3'))fail('清单版本不支持，请重新下载');
 if(meta.some(m=>m.校验签名!==Review.templateSignature(m)))fail('系统校验信息被修改，请重新下载');
 const queries=[...new Set(meta.map(m=>m.查询))];if(queries.length!==1)fail('系统校验页的查询范围不一致');
 let query;try{query=JSON.parse(queries[0]);}catch{fail('查询范围格式错误');}
 const allowed=['startDate','endDate','storeId','employeeId','reportRole','reviewRowKey'];
 if(Object.keys(query).some(k=>!allowed.includes(k)))fail('清单查询参数无效');
 return {rows,meta,query};
}
async function plan(user,buffer){
 if(!C.canConfigure(user))fail('仅提成配置管理员可以上传核算资料',403);
 const input=parse(buffer),report=await require('./employeeProfitSummary').load(user,input.query);
 const current=Review.compact(await Review.buildRows(user,input.query,report));
 const stores=await C.scope(user),scope=new Set(stores.map(s=>String(s.store_id))),actions=[],rows=[],seen=new Set(),configs=new Map();
 for(let index=0;index<input.rows.length;index++){
  const row=input.rows[index],value=String(row.确认值??'').trim(),evidence=String(row.依据说明||'').trim();
  if(!value&&!evidence){rows.push({row:index+2,status:'skipped',message:'未填写，保留原值'});continue;}
  try{
   if(value.length>200||evidence.length>4000)fail('确认值最多200字，依据说明最多4000字');
   const meta=input.meta.filter(m=>String(m.序号)===String(row.序号));if(meta.length!==1)fail('序号或校验信息被修改');
   const group=current.find(g=>g.id===meta[0].问题组);
   if(!group||group.fingerprint!==meta[0].指纹)fail('资料已变化或问题已处理，请重新下载');
   const original=JSON.parse(meta[0].原始栏位);
   for(const key of Object.keys(original))if(!editable.has(key)&&String(row[key]??'')!==String(original[key]??''))fail(`系统字段“${key}”被修改`);
   if(!scope.has(String(group.target.storeId)))fail('原门店不在授权范围',403);
   const action={...group.target,groupId:group.id,fingerprint:group.fingerprint,evidence,issue:group.row.问题};
   if(['storeLine','staffBase'].includes(action.type)){
    if(!/^\d{1,10}(\.\d{1,2})?$/.test(value))fail('金额须为非负数，最多两位小数；空白不等于0');
    const entityType=action.type==='storeLine'?'store':'staff',entityId=entityType==='store'?action.storeId:action.staffId;
    if(!configs.has(action.month))configs.set(action.month,await C.options(user,action.month));
    const options=configs.get(action.month),item=(entityType==='store'?options.stores:options.employees).find(x=>String(entityType==='store'?x.storeId:x.staffId)===String(entityId));
    if(!item)fail('配置对象不在当前可维护范围');
    Object.assign(action,{entityType,entityId,amount:Number(value),revision:item.revision||0,before:entityType==='store'?item.breakEvenLine:item.commissionBase});
   }else if(action.type==='managerHistory'){
    if(!value||!evidence)fail('请填写店长及任职依据');
    const people=await M.Staff.findAll({where:/^\d+$/.test(value)?{staff_id:value}:{name:value},raw:true});
    const store=stores.find(s=>String(s.store_id)===String(action.storeId));
    const valid=people.filter(p=>String(p.distributor_id)===String(store.distributor_id));if(valid.length!==1)fail('店长不存在或同名，请填写唯一员工编号');
    Object.assign(action,{staffId:String(valid[0].staff_id),staffName:valid[0].name,from:date(row.生效开始),to:date(row.生效结束)});
    if(action.to<=action.from)fail('任期结束须晚于开始');
    const existing=await H.Assignment.findAll({where:{store_id:action.storeId},raw:true});
    if(existing.some(r=>new Date(r.effective_from)<new Date(action.to)&&(!r.effective_to||new Date(r.effective_to)>new Date(action.from))))fail('任期与已有记录重叠');
    if(actions.some(a=>a.type==='managerHistory'&&a.storeId===action.storeId&&a.from<action.to&&a.to>action.from))fail('文件内任期相互重叠');
   }else Object.assign(action,{type:'manual',value,message:'仅记录确认意见，待人工核实，不自动修改单据'});
   const key=digest(action);if(seen.has(key))fail('重复填写同一内容');seen.add(key);actions.push(action);
   rows.push({row:index+2,status:'ready',message:action.type==='manual'?action.message:'可提交',employee:group.row.员工,store:group.row.门店,month:action.month,before:action.before??'',after:(action.staffName||action.amount)??value,from:action.from?new Date(new Date(action.from).getTime()+28800000).toISOString().slice(0,19).replace('T',' '):'',to:action.to?new Date(new Date(action.to).getTime()+28800000).toISOString().slice(0,19).replace('T',' '):'',evidence});
  }catch(error){if(error.status===403)throw error;rows.push({row:index+2,status:'error',message:error.message});}
 }
 return {query:input.query,rows,actions,valid:rows.every(r=>r.status!=='error')&&actions.length>0};
}
function signature(payload){return crypto.createHmac('sha256',require('../../config').jwt.secret).update(payload).digest('hex');}
async function preview(ctx){
 const file=ctx.file||ctx.request.file,result=await plan(ctx.state.user,file?.buffer);
 const payload=Buffer.from(JSON.stringify({actor:String(ctx.state.user.staffId),hash:digest(result),expires:Date.now()+20*60*1000})).toString('base64url');
 ctx.body={code:0,data:{rows:result.rows,valid:result.valid,token:result.valid?payload+'.'+signature(payload):null}};
}
async function apply(ctx){
 const user=ctx.state.user;if(!C.canConfigure(user))fail('无权提交',403);
 const token=String(ctx.request.body?.token||''),[payload,sig]=token.split('.');
 if(!payload||!sig||sig!==signature(payload))fail('预览凭据无效，请重新预览');
 const saved=JSON.parse(Buffer.from(payload,'base64url').toString());if(saved.actor!==String(user.staffId)||saved.expires<Date.now())fail('预览已失效，请重新预览');
 const businessId=digest([saved.actor,saved.hash]).slice(0,64);
 const lock=await M.BusinessActionLog.findOne({where:{business_type:'profit_review_import',business_id:businessId,action:'apply'},raw:true});
 if(lock){ctx.body={code:0,message:'该批次已提交，无需重复操作'};return;}
 const file=ctx.file||ctx.request.file,result=await plan(user,file?.buffer);
 if(!result.valid||digest(result)!==saved.hash)fail('预览后资料或填写内容发生变化，请重新预览',409);
 await M.sequelize.transaction(async transaction=>{
  // Serialize repeated confirmation and revalidate all target revisions inside writes.
  await M.Staff.findByPk(user.staffId,{transaction,lock:transaction.LOCK.UPDATE});
  if(await M.BusinessActionLog.findOne({where:{business_type:'profit_review_import',business_id:businessId,action:'apply'},transaction}))return;
  const inputs=[];
  for(const [index,action]of result.actions.entries()){
   if(action.type==='managerHistory')await H.confirm({storeId:action.storeId,staffId:action.staffId,from:action.from,to:action.to,evidence:action.evidence,user,transaction});
   else if(['storeLine','staffBase'].includes(action.type))await C.save({state:{user},request:{body:{month:action.month,entityType:action.entityType,entityId:action.entityId,amount:action.amount,revision:action.revision}}},transaction);
   const inputId=businessId.slice(0,32)+':'+index;inputs.push(inputId);
   await recordBusinessAction({businessType:'profit_review_input',businessId:inputId,action:'confirm',user,detail:action,transaction});
  }
  await recordBusinessAction({businessType:'profit_review_import',businessId,action:'apply',user,detail:{inputs,query:result.query},transaction});
 });
 ctx.body={code:0,message:'核算资料已提交；人工核实项已记录，未自动修改历史单据',data:{rows:result.rows}};
}
module.exports={parse,plan,preview,apply,date};
