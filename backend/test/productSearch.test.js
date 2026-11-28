const test=require('node:test');
const assert=require('node:assert/strict');
const S=require('../src/utils/productSearch');
const db={escape:value=>`'${String(value).replace(/'/g,"''")}'`};
test('space separated terms are deduplicated and every token has its own required group',()=>{
 assert.deepEqual(S.tokens('  联想　32G  联想 '),['联想','32G']);
 const q=S.expressions(db,'联想 32G','p',['store']);
 assert.match(q.where, /\) AND \(/);
 for(const word of ['联想','32G'])assert.ok(q.where.includes(`%${word}%`));
 assert.ok(q.where.includes("ss.STORE_ID IN ('store')"));
 assert.ok(q.rank.indexOf('ss.SN_CODE')<q.rank.indexOf('pp.PN_CODE'));
 assert.ok(q.rank.indexOf('p.NAME')<q.rank.indexOf('p.CONFIG'));
 assert.ok(q.rank.indexOf('p.CONFIG')<q.rank.indexOf('p.REMARK'));
});
test('wildcards are literal, aliases validated, empty scope cannot expose SN matches',()=>{
 assert.ok(S.expressions(db,'50%_!','p',[]).where.includes('%50!%!_!!%'));
 assert.ok(S.expressions(db,'x','p',[]).where.includes('AND 1=0'));
 assert.throws(()=>S.expressions(db,'x','p;DROP'));
 assert.equal(S.expressions(db,'  ').where,'1=1');
 const row=S.expressions(db,'SN','p',[],'sn');assert.ok(row.where.startsWith('(sn.SN_CODE LIKE'));
});
