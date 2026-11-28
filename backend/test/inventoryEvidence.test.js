const test=require('node:test'),assert=require('node:assert/strict');
const E=require('../src/modules/report/inventoryEvidence');
const sn={sn_id:'SN1',sn_code:'CODE1',product_id:'P',inbound_price:1130,inbound_time:'2026-10-20T01:00:00Z'};
const base={itemId:1,productId:'P',boundSnId:'SN1',unitPrice:1130,receivedAt:'2026-10-19T01:00:00Z',requestId:'R',requestNo:'PR1',inboundNo:'IN1',storeId:'S1',distributorId:'D',invoiceType:'专票13%'};
test('SN binding restores purchase origin independently of present store, including exact legacy SN code',()=>{
 assert.equal(E.resolveSnEvidence(sn,[base],'D').status,'linked');
 const code={...base,boundSnId:null,snCode:'CODE1'};
 assert.equal(E.resolveSnEvidence(sn,[code],'D').requestNo,'PR1');
 assert.equal(E.resolveSnEvidence(sn,[{...code,directSnId:'OTHER'}],'D').status,'unlinked');
 assert.equal(E.resolveSnEvidence(sn,[{...code,snCode:null,receivedCodes:'["CODE1"]'}],'D').status,'linked');
});
test('identity, price, time, product and buyer conflicts cannot silently become a valid tax basis',()=>{
 assert.equal(E.resolveSnEvidence(sn,[{...base,unitPrice:1}],'D').status,'conflict');
 assert.equal(E.resolveSnEvidence(sn,[{...base,receivedAt:'2026-10-21T01:00:00Z'}],'D').status,'conflict');
 assert.equal(E.resolveSnEvidence(sn,[{...base,productId:'OTHER'}],'D').status,'unlinked');
 assert.equal(E.resolveSnEvidence(sn,[base],'OTHER').status,'owner_pending');
 assert.equal(E.resolveSnEvidence(sn,[base,{...base,itemId:2,requestId:'OTHER'}],'D').status,'conflict');
});
test('historical binding backfills do not replace receipt time and partial receipts use the correct SN binding',()=>{
 assert.equal(E.resolveSnEvidence(sn,[{...base,bindingAt:'2026-11-01T01:00:00Z'}],'D').status,'linked');
 const partial={...base,receivedAt:'2026-11-01T01:00:00Z',bindingAt:'2026-10-19T01:00:00Z'};
 assert.equal(E.resolveSnEvidence(sn,[partial],'D').status,'linked');
 const other={...partial,boundSnId:'OTHER',directSnId:'SN1',bindingAt:'2026-11-02T01:00:00Z'};
 assert.equal(E.resolveSnEvidence(sn,[partial,other],'D').status,'linked');
});
test('complete unambiguous registered invoices supply explicit type/rate but partial or mixed invoices do not',()=>{
 const a={requestId:'R',requestAmount:1130,allocationId:'A',allocationAmount:1130,invoiceType:'增值税专用发票',taxRate:0.13,invoiceNo:'F1'};
 const evidence=E.registeredInvoiceEvidence([a,a]);
 const linked=E.resolveSnEvidence(sn,[{...base,invoiceType:''}],'D',evidence);
 assert.equal(linked.invoiceType,'专票13%');assert.equal(linked.evidenceSource,'registered_invoice');assert.equal(linked.invoiceNos,'F1');
 assert.equal(E.registeredInvoiceEvidence([{...a,allocationAmount:500}]).size,0);
 const mixed=E.registeredInvoiceEvidence([{...a,allocationAmount:600},{...a,allocationId:'B',allocationAmount:530,taxRate:0.09}]);
 assert.equal(E.resolveSnEvidence(sn,[base],'D',mixed).status,'invoice_conflict');
 assert.equal(E.documentBasis('13%含税'),'');assert.equal(E.documentBasis('专票13%',0.09),'');
});
test('non-SN purchase candidates retain scope and never become an invented current-stock tax link',()=>{
 const candidates=E.nonSnCandidates('P','S1','D',[base,{...base,itemId:2},{...base,requestId:'X',storeId:'OTHER'},{...base,requestId:'Y',distributorId:'OTHER'}]);
 assert.equal(candidates.length,1);assert.equal(candidates[0].requestNo,'PR1');
 assert.equal(candidates[0].netEstimate,undefined);
});
