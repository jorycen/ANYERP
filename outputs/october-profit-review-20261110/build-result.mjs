import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const root=new URL('.',import.meta.url),batchDir=new URL('../../backend/backup/order-corrections/USER-PRODUCT-COST-20261110-6229c06e44/',import.meta.url);
const read=async url=>JSON.parse(await fs.readFile(url,'utf8'));
const [base,result,verified]=await Promise.all([read(new URL('supplement-source.json',root)),read(new URL('result.json',batchDir)),read(new URL('independent-verification.json',batchDir))]);
assert(verified.verified);assert.equal(verified.failed,0);
const written=result.applied.flatMap(x=>x.rows),same=result.alreadyConfirmed;
const get=(arr,id)=>arr.find(r=>r.orderItemId===id);
const all=base.rows.map((b,i)=>{const w=get(written,b.itemId),s=get(same,b.itemId),r=w||s;
 return { ...b, sourceRow:i+7,confirmedCost:r?r.unitCost:null,status:w?'成本已回填':s?'原确认成本一致':'待确认零成本',needsPrice:!!b.priceMissing,
   afterStatus:w?(b.priceMissing?'仍缺原单结算定价':'商品成本已完整'):s?'仍缺原单结算定价':'零成本未明确确认' };
});
const remaining=all.filter(r=>r.confirmedCost==null||r.needsPrice);
assert.equal(written.length,120);assert.equal(same.length,238);assert.equal(remaining.length,302);
const wb=Workbook.create(),summary=wb.worksheets.add('处理结果'),todo=wb.worksheets.add('仍需补充');
summary.getRange('A2').values=[['10月成本回填处理结果']];
summary.getRange('A3').values=[['120条写入成功，238条原确认成本一致，1条未确认零成本暂保留。原销售订单、销售毛利快照未修改。']];
summary.getRange('A4').values=[[`10月待核算业务：369笔降至${verified.report.afterPending}笔；本表商品行与业务笔数并非同一口径。`]];
summary.getRange('A5').values=[['来源：用户回填清单及逐单回读校验，2026-11-10。产品结算和对应退货成本冲回已同步。']];
summary.getRange('A6:J6').values=[['序号','原表行号','门店','原销售单号','商品','PN','SN','已确认采购单价','处理结果','仍缺什么']];
summary.getRange(`A7:J${6+all.length}`).values=all.map((r,i)=>[i+1,r.sourceRow,r.store,r.orderNo,r.product,r.pn,r.sn,r.confirmedCost??'尚未确认',r.status,r.afterStatus]);
todo.getRange('A2').values=[['仍需补充的定价及零成本确认']];
todo.getRange('A3').values=[['301条成本已明确，但缺原单结算定价；另1条需明确确认零成本。请填写黄色列。']];
todo.getRange('A4').values=[['本次已确认的成本不用重填。定价需为原单产品结算定价，不以当前售价或采购成本替代。']];
todo.getRange('A5').values=[['另有2条系统核查事项仍保留在上一版清单“系统核查”页，本次没有用人工数值覆盖。']];
todo.getRange('A6:N6').values=[['序号','原表行号','门店','原销售单号','商品','PN','SN','已确认采购单价','本次还需补充','请填原单结算定价','零成本是否确认','请填依据说明','原销售商品行ID','产品结算明细ID']];
todo.getRange(`A7:N${6+remaining.length}`).values=remaining.map((r,i)=>[i+1,r.sourceRow,r.store,r.orderNo,r.product,r.pn,r.sn,r.confirmedCost??'尚未确认',r.confirmedCost==null?'请明确确认是否为零成本':'原单结算定价','','','',r.itemId,r.settlementItemId]);
for(const [s,last,lastCol,name] of [[summary,6+all.length,'J','CostReviewResults'],[todo,6+remaining.length,'N','RemainingPriceReview']]){
 s.showGridLines=false;s.tabColor='#203864';const used=s.getRange(`A2:${lastCol}${last}`);used.format.font={name:'Arial',size:10,color:'#202B3C'};used.format.verticalAlignment='center';used.format.columnWidth=22;used.format.rowHeight=25;
 s.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:'#203864'};
 s.getRange(`A1:B${last}`).format.columnWidth=9;s.getRange(`C1:C${last}`).format.columnWidth=20;s.getRange(`D1:D${last}`).format.columnWidth=29;s.getRange(`E1:E${last}`).format.columnWidth=48;s.getRange(`F1:G${last}`).format.columnWidth=25;s.getRange(`I1:I${last}`).format.columnWidth=24;
 s.getRange(`E7:E${last}`).format.wrapText=true;s.getRange(`A7:${lastCol}${last}`).format.autofitRows();
 s.getRange(`H7:H${last}`).setNumberFormat('#,##0.00;[Red](#,##0.00);0.00');
 s.tables.add(`A6:${lastCol}${last}`,true,name);s.getRange(`A6:${lastCol}6`).format={fill:'#203864',font:{bold:true,color:'#FFFFFF'},horizontalAlignment:'center',wrapText:true,rowHeight:38};
 s.freezePanes.freezeRows(6);s.freezePanes.freezeColumns(4);
}
summary.getRange(`J1:J${6+all.length}`).format.columnWidth=28;
todo.getRange(`J7:L${6+remaining.length}`).format.fill='#FFF2CC';
todo.getRange(`K7:K${6+remaining.length}`).dataValidation={rule:{type:'list',values:['是','否']}};
todo.getRange(`J7:J${6+remaining.length}`).setNumberFormat('#,##0.00');
todo.getRange(`L1:N${6+remaining.length}`).format.columnWidth=36;
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'处理结果!A6:J10',include:'values',tableMaxRows:5,tableMaxCols:10})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?',options:{useRegex:true,maxResults:5}})).ndjson);
const file=await SpreadsheetFile.exportXlsx(wb);await file.save(fileURLToPath(new URL('10月成本回填结果及仍需补充清单.xlsx',root)));
for(const [sheetName,range,output] of [['处理结果','A1:J11','result.png'],['仍需补充','A1:L11','remaining.png']]){const image=await wb.render({sheetName,range,scale:1.2,format:'png'});await fs.writeFile(new URL(output,root),new Uint8Array(await image.arrayBuffer()));}
console.log(JSON.stringify({written:written.length,alreadyConfirmed:same.length,remainingRows:remaining.length}));
