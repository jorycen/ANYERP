import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
const d=JSON.parse(await fs.readFile(new URL('supplement-source.json',import.meta.url),'utf8'));
const wb=Workbook.create(),s=wb.worksheets.add('需要补充'),sys=wb.worksheets.add('系统核查');
const last=d.rows.length+6;
const headers=['序号','门店','原销售单号','商品名称','PN','SN','数量','需要补充什么','请填实际采购单价','零成本是否确认','请填原单结算定价（如需）','请填采购单号或依据说明','原记录采购单价','原记录结算定价','原销售冻结采购成本参考','已确认档案成本参考','SN核对说明','关联待核算业务单','原销售商品行ID','产品结算明细ID','基础档案ID'];
s.getRange('A2').values=[['10月毛利待核算：需要补充的商品资料']];
s.getRange('A3').values=[[`共${d.rows.length}行商品，${d.rows.filter(r=>r.sn!=='无SN记录').length}行有SN，已列在F列。另${d.system.length}条系统问题见“系统核查”。`]];
s.getRange('A4').values=[['填写黄色区域。实际成本为0时，在“零成本是否确认”填“是”。原记录的0不代表已确认零成本。']];
s.getRange('A5').values=[['来源：后台原销售及产品结算商品行。仅列待补商品；参考成本仅供核对，不自动填入确认栏。']];
s.getRange('A6:U6').values=[headers];
const rows=d.rows.map((r,i)=>[i+1,r.store,r.orderNo,r.product,r.pn,r.sn,r.quantity,r.required,'','','','',r.storedCost,r.storedPrice,
 r.frozenCost==null?'无明确冻结成本':Number(r.frozenCost),r.foundationCost==null?'无已确认档案成本':Number(r.foundationCost),r.snNote,r.events,r.itemId,r.settlementItemId,r.foundationId]);
s.getRange(`A7:U${last}`).values=rows;s.tables.add(`A6:U${last}`,true,'SupplementItems');
s.getRange(`I7:L${last}`).format.fill='#FFF2CC';
s.getRange(`J7:J${last}`).dataValidation={rule:{type:'list',values:['是','否']}};
s.freezePanes.freezeRows(6);s.freezePanes.freezeColumns(3);
sys.getRange('A2').values=[['系统核查事项']];
sys.getRange('A3').values=[['以下事项需要核对系统结算或毛利流水，不要求你先填采购成本。']];
sys.getRange('A5:G5').values=[['门店','业务单号','原销售单号','商品','SN','问题','需要核对什么']];
sys.getRange(`A6:G${5+d.system.length}`).values=d.system.map(r=>[r.store,r.no,r.orderNo,r.products,r.sns,r.reason,r.required]);
sys.tables.add(`A5:G${5+d.system.length}`,true,'SystemReview');
for(const [sheet,range,header] of [[s,`A2:U${last}`,'A6:U6'],[sys,`A2:G${5+d.system.length}`,'A5:G5']]){
 sheet.showGridLines=false;sheet.tabColor='#203864';sheet.getRange(range).format.font={name:'Arial',size:10,color:'#202B3C'};
 sheet.getRange(range).format.verticalAlignment='center';sheet.getRange(range).format.rowHeight=25;sheet.getRange(range).format.columnWidth=20;
 sheet.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:'#203864'};
 sheet.getRange(header).format={fill:'#203864',font:{bold:true,color:'#FFFFFF'},wrapText:true,horizontalAlignment:'center',rowHeight:42};
}
s.getRange(`A1:A${last}`).format.columnWidth=7;s.getRange(`B1:B${last}`).format.columnWidth=20;s.getRange(`C1:C${last}`).format.columnWidth=28;
s.getRange(`D1:D${last}`).format.columnWidth=48;s.getRange(`E1:F${last}`).format.columnWidth=26;s.getRange(`G1:G${last}`).format.columnWidth=8;
s.getRange(`H1:H${last}`).format.columnWidth=42;s.getRange(`I1:K${last}`).format.columnWidth=23;s.getRange(`L1:L${last}`).format.columnWidth=42;
s.getRange(`M1:P${last}`).format.columnWidth=24;s.getRange(`Q1:R${last}`).format.columnWidth=54;s.getRange(`S1:U${last}`).format.columnWidth=36;
s.getRange(`D7:D${last}`).format.wrapText=true;s.getRange(`H7:H${last}`).format.wrapText=true;s.getRange(`Q7:R${last}`).format.wrapText=true;
s.getRange(`A7:U${last}`).format.autofitRows();
for(const col of ['C','E','F','S','T','U'])s.getRange(`${col}7:${col}${last}`).setNumberFormat('@');
for(const col of ['I','K','M','N','O','P'])s.getRange(`${col}7:${col}${last}`).setNumberFormat('#,##0.00;[Red](#,##0.00);0.00');
sys.getRange(`B1:C${5+d.system.length}`).format.columnWidth=30;sys.getRange(`D1:G${5+d.system.length}`).format.columnWidth=48;
sys.getRange(`D6:G${5+d.system.length}`).format.wrapText=true;sys.getRange(`A6:G${5+d.system.length}`).format.autofitRows();
wb.recalculate();
assert.equal(s.getRange(`A7:A${last}`).values.length,d.rows.length);
assert.equal(s.getRange(`F7:F${last}`).values.filter(r=>r[0]!=='无SN记录').length,d.rows.filter(r=>r.sn!=='无SN记录').length);
assert.equal(new Set(d.rows.map(r=>r.key)).size,d.rows.length);
console.log((await wb.inspect({kind:'table',range:'需要补充!A6:L10',include:'values',tableMaxRows:5,tableMaxCols:12})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?',options:{useRegex:true,maxResults:5}})).ndjson);
const out=await SpreadsheetFile.exportXlsx(wb);await out.save(fileURLToPath(new URL('10月毛利待补资料清单（含SN）.xlsx',import.meta.url)));
for(const [sheetName,range,name] of [['需要补充','A1:H12','supplement.png'],['系统核查',`A1:G${5+d.system.length}`,'system-review.png']]){
 const image=await wb.render({sheetName,range,scale:1.3,format:'png'});await fs.writeFile(new URL(name,import.meta.url),new Uint8Array(await image.arrayBuffer()));
}
console.log(JSON.stringify({saved:true,rows:d.rows.length,withSN:d.rows.filter(r=>r.sn!=='无SN记录').length,system:d.system.length}));
