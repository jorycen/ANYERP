import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
import assert from 'node:assert/strict';
const dir=path.dirname(fileURLToPath(import.meta.url));
const data=JSON.parse(await fs.readFile(path.join(dir,'difference-data.json'),'utf8'));
const wb=Workbook.create(),summary=wb.worksheets.add('原因汇总'),employee=wb.worksheets.add('员工差异订单'),manager=wb.worksheets.add('门店基数调整');
const fmt='#,##0.00;[Red](#,##0.00);0.00',dateFmt='yyyy-mm-dd hh:mm';
const headers=['差异类型','门店','原销售订单号','原因','10月影响额','原10月计入额','现10月计入额','关联业务单号','人员','原归属月份','现归属月份','建议处理','原单创建时间','原单归档时间','审批或退货入账时间'];
const localDate=value=>value?new Date(new Date(value).getTime()+28800000):null;
function base(sheet,last,col){
 sheet.showGridLines=false;sheet.getRange(`A1:${col}${last}`).format.font={name:'Arial',size:10,color:'#243247'};
 sheet.getRange(`A1:${col}${last}`).format.verticalAlignment='center';
 sheet.getRange(`A1:${col}${last}`).format.rowHeight=24;
 sheet.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:'#183753'};
 sheet.getRange('A2').format.rowHeight=30;
}
function detail(sheet,records,title,note,tableName){
 const end=6+records.length,total=end+2;
 base(sheet,total,'O');sheet.getRange('A2').values=[[title]];sheet.getRange('A4').values=[[note]];
 sheet.getRange('A5').values=[['金额单位：元；只列该条销售、退货或调整记录计入10月的金额，非整单最终毛利。日期为北京时间，空白表示原字段缺失或不适用。']];
 sheet.getRange('A4:O5').format.font={name:'Arial',size:10,italic:true,color:'#667085'};
 const widths=[190,120,240,390,120,120,120,320,110,145,165,400,175,175,190];
 widths.forEach((w,i)=>sheet.getRangeByIndexes(0,i,total,1).format.columnWidthPx=w);
 sheet.getRange('A6:O6').values=[headers];
 const rows=records.map(r=>[r.type,r.store,r.orderNo,r.reason,null,r.before,r.after,r.businessNo,r.employee,r.oldMonth,r.newMonth,r.suggestion,localDate(r.created),localDate(r.archived),localDate(r.approval)]);
 if(rows.length)sheet.getRange(`A7:O${end}`).values=rows;
 sheet.getRange(`E7:E${end}`).formulas=rows.map((_,i)=>[`=ROUND(G${i+7}-F${i+7},2)`]);
 sheet.tables.add(`A6:O${end}`,true,tableName);
 sheet.getRange('A6:O6').format={fill:'#244966',font:{name:'Arial',size:10,color:'#FFFFFF',bold:true},rowHeight:32,wrapText:true,horizontalAlignment:'center',verticalAlignment:'center'};
 sheet.getRange(`A7:O${end}`).format.rowHeight=58;
 sheet.getRange(`A7:D${end}`).format.wrapText=true;sheet.getRange(`J7:L${end}`).format.wrapText=true;
 sheet.getRange(`E7:G${total}`).setNumberFormat(fmt);sheet.getRange(`E7:G${total}`).format.horizontalAlignment='right';
 sheet.getRange(`M7:O${end}`).setNumberFormat(dateFmt);
 sheet.getRange(`A${total}:D${total}`).values=[['合计',null,null,null]];
 for(const c of ['E','F','G'])sheet.getRange(`${c}${total}`).formulas=[[`=SUM(${c}7:${c}${end})`]];
 sheet.getRange(`A${total}:G${total}`).format={fill:'#EAF0F5',font:{bold:true,color:'#183753'},rowHeight:28,borders:{top:{style:'thin',color:'#244966'}}};
 sheet.freezePanes.freezeRows(6);sheet.freezePanes.freezeColumns(3);
 sheet.getRange(`A7:A${end}`).conditionalFormats.add('containsText',{text:'漏计',format:{fill:'#FCE9E7',font:{color:'#9C2F25',bold:true}}});
 return {end,total};
}
const employeeData=[...data.records].sort((a,b)=>a.type.localeCompare(b.type,'zh-CN')||a.store.localeCompare(b.store,'zh-CN')||a.orderNo.localeCompare(b.orderNo));
const er=detail(employee,employeeData,'10月员工毛利差异订单','87条差异记录，83张原销售单；同一原单可能有销售、退货或调整等不同记录。','EmployeeDifferences');
const mr=detail(manager,data.manager,'10月门店提成基数调整订单','仅影响门店基数口径，共28张；原员工统计已归9月，本表差额不加到员工总差额。','ManagerDifferences');
base(summary,31,'D');summary.tabColor='#244966';
summary.getRange('A1:A31').format.columnWidthPx=300;summary.getRange('B1:B31').format.columnWidthPx=105;summary.getRange('C1:C31').format.columnWidthPx=160;summary.getRange('D1:D31').format.columnWidthPx=650;
summary.getRange('A2').values=[['10月毛利差异订单及原因']];
summary.getRange('A4').values=[['范围：2026-10-01至2026-10-31，全门店、全部员工。金额单位：元。']];
summary.getRange('A5').values=[['修改前后采用同一份当前数据重算，费用扣减相同；指定退单日期修正单列，连接此前截图金额。']];
summary.getRange('A4:D5').format.font={name:'Arial',size:10,color:'#667085',italic:true};
summary.getRange('A7:D7').values=[['变化原因','差异记录数','10月毛利影响','具体原因与处理建议']];
const cats=['自营仓转产品端','优惠券历史校正移月','教育套件历史校正移月','归档月份变化','历史退单漏计正向毛利','指定退单移回9月'];
const notes={
 '自营仓转产品端':'销售端移除自营仓原负毛利，改归产品端。属于三端重分类，公司总毛利不因此增加。',
 '优惠券历史校正移月':'50笔此前用于10月补错的扣减按11月审批时间迁出。应区分历史修数与后续正式调整申请。',
 '教育套件历史校正移月':'12笔历史教育或套件校正按11月审批时间迁出。应核实历史修数原归属月份。',
 '归档月份变化':'3张10月创建、11月归档销售单改计11月。符合按归档月份计提规则。',
 '历史退单漏计正向毛利':'6张已退原单归档字段为空，原正向毛利被漏计，退货负毛利仍在。需要追溯归档依据修复。',
 '指定退单移回9月':'RET202609300916536583按用户指定改为9月30日23:40，负毛利不再计入10月。'
};
for(let i=0;i<cats.length;i++){
 const r=8+i;summary.getRange(`A${r}:D${r}`).values=[[cats[i],null,null,notes[cats[i]]]];
 summary.getRange(`B${r}`).formulas=[[`=COUNTIFS('员工差异订单'!$A$7:$A$${er.end},A${r})`]];
 summary.getRange(`C${r}`).formulas=[[`=SUMIFS('员工差异订单'!$E$7:$E$${er.end},'员工差异订单'!$A$7:$A$${er.end},A${r})`]];
}
summary.getRange('D8:D13').format.wrapText=true;summary.getRange('A8:D13').format.rowHeight=46;
summary.getRange('A7:D7').format={fill:'#244966',font:{name:'Arial',bold:true,color:'#FFFFFF'},rowHeight:30,horizontalAlignment:'center'};
summary.getRange('A14:D14').values=[['员工总差额',null,null,'不含下方单列的门店基数调整。']];
summary.getRange('B14').formulas=[['=SUM(B8:B13)']];summary.getRange('C14').formulas=[['=SUM(C8:C13)']];
summary.getRange('A16:D20').values=[['此前截图金额',null,data.baseline,'销售端扣减后毛利'],['清单差额',null,null,'上方87条差异记录合计'],['按清单推算当前金额',null,null,'此前截图金额加清单差额'],['当前规则重算金额',null,data.current,'独立读取员工汇总重算结果'],['对账差额',null,null,'应为0，核对清单是否完整']];
summary.getRange('C17').formulas=[['=C14']];summary.getRange('C18').formulas=[['=SUM(C16:C17)']];summary.getRange('C20').formulas=[['=ROUND(C18-C19,2)']];
summary.getRange('A22:D22').values=[['门店基数调整（单列）',28,null,'28单统一归9月，本项仅影响门店提成基数，不加入员工总差额。']];
summary.getRange('C22').formulas=[[`='门店基数调整'!E${mr.total}`]];summary.getRange('A22:D22').format.rowHeight=38;summary.getRange('D22').format.wrapText=true;
summary.getRange('A24').values=[['需处理：6张退单原销售正毛利漏计']];summary.getRange('A25').values=[['需区分：历史修数与后续正式调整申请']];
summary.getRange('A24:D25').format.font={name:'Arial',size:10,bold:true,color:'#9C2F25'};
summary.getRange('A27').values=[['数据来源']];summary.getRange('D27:D29').values=[[data.source],['核查数据截至：'+new Date(new Date(data.asOf).getTime()+28800000).toISOString().slice(0,19).replace('T',' ')+'（北京时间）。'],['清单为对账说明，不会自动修改订单或入账。']];summary.getRange('D27:D29').format.wrapText=true;summary.getRange('D27').format.rowHeight=54;summary.getRange('D28').format.rowHeight=32;
summary.getRange('C8:C22').setNumberFormat(fmt);summary.getRange('B8:B14').setNumberFormat('#,##0');
for(const r of [14,18,20,22])summary.getRange(`A${r}:D${r}`).format.borders={top:{style:'thin',color:'#AEBFCE'}};
summary.getRange('A14:D14').format.fill='#EAF0F5';summary.getRange('A14:D14').format.font={bold:true};summary.getRange('A18:D20').format.font={bold:true};
wb.recalculate();
const total=Number(employee.getRange(`E${er.total}`).values[0][0]),managerTotal=Number(manager.getRange(`E${mr.total}`).values[0][0]);
assert(Math.abs(total-36390.21)<0.001);assert(Math.abs(managerTotal+19438.15)<0.001);assert.equal(Number(summary.getRange('C20').values[0][0]),0);
console.log((await wb.inspect({kind:'table',range:'原因汇总!A7:D22',include:'values,formulas',tableMaxRows:16,tableMaxCols:4,maxChars:2200})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#NULL!',options:{useRegex:true,maxResults:20},maxChars:600})).ndjson);
for(const [sheetName,range,name]of [['原因汇总','A2:D25','summary-preview'],['员工差异订单','A6:G12','employee-preview'],['门店基数调整','A6:G12','manager-preview']]){
 const blob=await wb.render({sheetName,range,scale:1,format:'png'});await fs.writeFile(path.join(dir,name+'.png'),new Uint8Array(await blob.arrayBuffer()));
}
const out=await SpreadsheetFile.exportXlsx(wb);await out.save(path.join(dir,'10月毛利差异订单清单及原因.xlsx'));
console.log(JSON.stringify({output:path.join(dir,'10月毛利差异订单清单及原因.xlsx'),employeeRows:employeeData.length,employeeDelta:total,managerRows:data.manager.length,managerDelta:managerTotal}));
