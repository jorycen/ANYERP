const fs=require('node:fs'),path=require('node:path'),X=require('xlsx');
const dir=path.resolve(__dirname,'../backup/order-corrections/RETURN-TAX-FULL-20261107');
const r=JSON.parse(fs.readFileSync(path.join(dir,'all-return-documents.json'))),pending=r.filter(x=>!x.service&&x.basis?.status!=='confirmed');
const map=x=>({'退货单号':x.returnNo,'退货明细ID':x.returnItemId,'原销售明细ID':x.originalItemId,'商品':x.product,'商品ID':x.productId,'PN':x.pn,'状态':x.service?'服务类不扣采购税':x.basis?.status==='confirmed'?'已确认':'待核实','采购票据':x.basis?.invoiceType||'','原因':x.basis?.reason||'','依据来源':x.basis?.source||'','确认票据（收据/专票13%）':'','依据单号或说明':''});
const wb=X.utils.book_new();for(const [name,rows] of [['待核实',pending],['全部退货明细',r]]){const sheet=X.utils.json_to_sheet(rows.map(map));sheet['!cols']=[{wch:27},{wch:14},{wch:16},{wch:48},{wch:34},{wch:22},{wch:20},{wch:14},{wch:54},{wch:35},{wch:29},{wch:48}];X.utils.book_append_sheet(wb,sheet,name);}
const out=path.resolve(__dirname,'../return-tax-review-20261107.xlsx');X.writeFile(wb,out);console.log(JSON.stringify({file:out,total:r.length,pending:pending.length}));
