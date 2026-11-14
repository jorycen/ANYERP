const fs=require('fs'),cp=require('child_process');
const sections={
'DECISIONS.md':'## 2026-11-12 六笔历史退单按真实日期恢复（方案1，用户确认）\n\n- 决策：六笔原销售缺失归档时间按唯一原始 archived 审计日志恢复至2026年10月，正毛利合计1,965.97元；六笔实际退货完成入账均在10月，负毛利仍在10月。\n- 原因：以真实归档、退货入账事实核算，避免原销售正毛利遗漏；核实后未采用将退货人为移至11月的方案。\n- 最终选择：单事务备份、锁定、恢复归档时间并审计，保持原单状态、金额、毛利快照及退货流水不变。财务报表退货日期统一读取冻结退货毛利流水的入账时间。\n- 状态：六单数据已提交并回读；相关126项测试通过。代码发布至GitHub后仍需CloudBase控制台发布后端。\n\n',
'BUSINESS_RULES.md':'## 2026-11-12 退货按完成入账月份独立冲减\n\n- 原销售按已确认销售归属日期计入正毛利，后续退货不修改原销售毛利或原归档日期。\n- 退货完成时生成独立冻结毛利流水，以该流水CREATE_TIME作为退货入账日期；退货申请创建日期、结算单创建日期不替代完成入账日期。员工、店长及财务报表共用该事件日期。\n- 例如10月销售、11月完成退货：10月正毛利保留，11月产生负毛利；重复完成不重复记账。已确认的固定历史期间例外保持。\n- 本次六单经原始归档日志和退货流水核实，正负毛利均属于10月，不人为移动负毛利至11月。\n\n',
'CHANGELOG.md':'## 2026-11-12 恢复六单原始归档与统一退货统计日期\n\n- 恢复六笔历史全退订单缺失的原始归档时间，10月补回正毛利1,965.97元；原10月负毛利保留，未修改任何毛利金额。备份及审计批次SIX-RETURNED-ARCHIVES-20261112。\n- 财务报表退货事件改为读取冻结毛利流水的完成入账时间，与员工报表及店长提成时间轴一致。\n- 验证：相关126项回归测试通过，覆盖跨月及部分退货、冻结金额与重复完成。\n\n'};
for(const [file,section]of Object.entries(sections)){
 const current=fs.readFileSync(file,'utf8');if(!current.startsWith(section))fs.writeFileSync(file,section+current);
 const head=cp.execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'});
 const content=(section+head).replace(/\r\n/g,'\n');
 const hash=cp.execFileSync('git',['hash-object','-w','--stdin'],{input:content,encoding:'utf8'}).trim();cp.execFileSync('git',['update-index','--cacheinfo','100644',hash,file]);
}
