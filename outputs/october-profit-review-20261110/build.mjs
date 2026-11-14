import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
const d=JSON.parse(await fs.readFile(new URL('source.json',import.meta.url),'utf8'));
const wb=Workbook.create(),summary=wb.worksheets.add('门店汇总'),detail=wb.worksheets.add('待核算清单');
const n=d.rows.length,last=6+n;
for(const s of [summary,detail]){s.showGridLines=false;s.tabColor='#203864';}
summary.getRange('A2').values=[['2026年10月毛利待核算清单']];
summary.getRange('A3').values=[[`共${d.total}笔业务记录，涉及${d.orders}张原销售订单、${d.summary.length}家门店。`]];
summary.getRange('A4').values=[['统计范围：10月1日至31日，当前有效门店。销售与退货分别计笔，同一原单可能对应多笔记录。']];
summary.getRange('A5').values=[[`来源：ANY-ERP三端经营毛利报表（${d.version}）。提取时间：${new Date(d.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}。`]];
summary.getRange('A7:D7').values=[['门店','待核算笔数','产品端待核算','销售端待核算']];
summary.getRange('A8:A'+(7+d.summary.length)).values=d.summary.map(x=>[x.store]);
const ranges={store:`'待核算清单'!$B$7:$B$${last}`,product:`'待核算清单'!$I$7:$I$${last}`,sales:`'待核算清单'!$H$7:$H$${last}`};
for(let i=0;i<d.summary.length;i++){const r=8+i;summary.getRange(`B${r}:D${r}`).formulas=[[
 `=COUNTIFS(${ranges.store},A${r})`, `=COUNTIFS(${ranges.store},A${r},${ranges.product},"待核算")`, `=COUNTIFS(${ranges.store},A${r},${ranges.sales},"待核算")`
]];}
const total=8+d.summary.length;
summary.getRange(`A${total}`).values=[['合计']];summary.getRange(`B${total}:D${total}`).formulas=[[`=SUM(B8:B${total-1})`,`=SUM(C8:C${total-1})`,`=SUM(D8:D${total-1})`]];
summary.getRange(`A${total+2}`).values=[['产品端未完整不等于员工销售毛利缺失。未知金额保留“待核算”，不按0处理。']];
detail.getRange('A2').values=[['2026年10月待核算业务明细']];
detail.getRange('A3').values=[['金额单位：元。使用表头筛选门店、待核算端或产品结算状态。']];
detail.getRange('A4').values=[['历史订单保持原值，本清单仅供核对。日期沿用已上传版本的报表归属口径。']];
const headers=['序号','门店','业务日期','业务类型','业务单号','原销售单号','待核算端','销售端毛利','产品端毛利','运营端毛利','原销售产品结算状态','商品','财务成本缺失商品','待核算原因','成本核算说明','建议核对事项','事件标识','原销售单ID'];
detail.getRange('A6:R6').values=[headers];
const states={posted:'已入账',cost_pending:'成本待补'};
const excelDate=s=>Math.floor((Date.parse(s+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000);
const rows=d.rows.map((r,i)=>[i+1,r.store,excelDate(r.date),r.type,r.entryNo,r.orderNo,r.parts,r.sales??'待核算',r.product??'待核算',r.operations??'待核算',states[r.settlementStatus]||r.settlementStatus,r.products,r.missingCostProducts,r.reason,r.detailReason,r.suggestion,r.eventKey,r.orderId||'']);
detail.getRange(`A7:R${last}`).values=rows;
detail.tables.add(`A6:R${last}`,true,'PendingProfitDetails');
detail.freezePanes.freezeRows(6);detail.freezePanes.freezeColumns(2);
for(const [s,range] of [[summary,`A2:D${total+2}`],[detail,`A2:R${last}`]]){
 s.getRange(range).format.font={name:'Arial',size:10,color:'#202B3C'};
 s.getRange(range).format.verticalAlignment='center';
 s.getRange(range).format.rowHeight=23;
 s.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:'#203864'};
}
summary.getRange('A7:D7').format={fill:'#203864',font:{bold:true,color:'#FFFFFF'},horizontalAlignment:'center',rowHeight:29};
summary.getRange(`A${total}:D${total}`).format={fill:'#E8EEF6',font:{bold:true},rowHeight:27};
summary.getRange('A1:A25').format.columnWidth=26;summary.getRange('B1:D25').format.columnWidth=19;
summary.getRange(`B8:D${total}`).setNumberFormat('#,##0');
detail.getRange(`A6:R${last}`).format.columnWidth=17;
detail.getRange('A1:A'+last).format.columnWidth=7;
detail.getRange('B1:B'+last).format.columnWidth=21;
detail.getRange('C1:C'+last).format.columnWidth=13;
detail.getRange('D1:D'+last).format.columnWidth=13;
detail.getRange('E1:F'+last).format.columnWidth=28;
detail.getRange('K1:K'+last).format.columnWidth=24;
detail.getRange('L1:M'+last).format.columnWidth=54;
detail.getRange('N1:P'+last).format.columnWidth=58;
detail.getRange('Q1:R'+last).format.columnWidth=38;
detail.getRange(`C7:C${last}`).setNumberFormat('yyyy-mm-dd');
detail.getRange(`H7:J${last}`).setNumberFormat('#,##0.00;[Red](#,##0.00);0.00');
detail.getRange(`E7:G${last}`).setNumberFormat('@');
detail.getRange(`L7:P${last}`).format.wrapText=true;
detail.getRange(`A7:R${last}`).format.autofitRows();
detail.getRange('A6:R6').format={fill:'#203864',font:{bold:true,color:'#FFFFFF'},wrapText:true,horizontalAlignment:'center',rowHeight:38};
detail.getRange(`H7:J${last}`).conditionalFormats.add('containsText',{text:'待核算',format:{fill:'#FFF2CC',font:{color:'#9C5700'}}});
wb.recalculate();
const values=summary.getRange(`B${total}:D${total}`).values[0];
assert.deepEqual(values,[d.total,d.rows.filter(r=>r.product==null).length,d.rows.filter(r=>r.sales==null).length]);
assert.equal(rows.length,369);assert.equal(new Set(d.rows.map(r=>r.eventKey)).size,rows.length);
console.log((await wb.inspect({kind:'table',range:`门店汇总!A7:D${total}`,include:'values',tableMaxRows:20,tableMaxCols:4})).ndjson);
const errors=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:10}});console.log(errors.ndjson);
const file=new URL('10月毛利待核算清单.xlsx',import.meta.url).pathname;
const out=await SpreadsheetFile.exportXlsx(wb);await out.save(decodeURIComponent(file).replace(/^\/([A-Za-z]:)/,'$1'));
for(const [name,range,preview] of [['门店汇总',`A1:D${total}`,'summary.png'],['待核算清单','A1:J11','detail.png']]){
 const image=await wb.render({sheetName:name,range,scale:1.5,format:'png'});await fs.writeFile(new URL(preview,import.meta.url),new Uint8Array(await image.arrayBuffer()));
}
console.log(JSON.stringify({saved:true,rows:d.total,orders:d.orders}));
