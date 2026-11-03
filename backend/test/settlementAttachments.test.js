const test=require('node:test'),assert=require('node:assert/strict');
const {attachmentFiles,collectSettlementAttachments}=require('../src/modules/finance/settlementAttachments');
test('application files accept legacy strings, JSON arrays and cloud file objects without unsafe URLs',()=>{
 const files=attachmentFiles('["https://example.com/a.png", {"url":"cloud://bucket/proof.pdf","name":"申请凭证"},"javascript:alert(1)"]');
 assert.equal(files.length,2);assert.equal(files[1].name,'申请凭证');
 assert.equal(attachmentFiles('https://example.com/a.png,https://example.com/b.pdf\n/uploads/c.jpg').length,3);
 assert.deepEqual(attachmentFiles('//evil.example/path'),[]);assert.deepEqual(attachmentFiles('{invalid'),[]);
});
test('payment dialog contract contains settlement and original expense evidence with source numbers and deduplication',()=>{
 const files=collectSettlementAttachments({settlement_no:'SET1',other_payment_image:'https://example.com/account.png',items:[
  {expense:{expense_no:'EX1',attachment_urls:'["cloud://bucket/receipt.pdf","https://example.com/account.png"]'}},
  {expense:{expense_no:'EX2',attachment_urls:['/uploads/invoice.jpg']}}
 ]});
 assert.equal(files.length,3);assert.equal(files[1].sourceNo,'EX1');assert.equal(files[2].sourceNo,'EX2');
 assert.deepEqual(collectSettlementAttachments({}),[]);
});
