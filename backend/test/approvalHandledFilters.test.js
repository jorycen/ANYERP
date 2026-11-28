const test=require('node:test'),assert=require('node:assert/strict');
const {Sequelize,Op}=require('sequelize');
const {dateRange,productFilter}=require('../src/modules/approval/handledFilters');
test('dates use Shanghai inclusive days with exclusive next-day boundary',()=>{
 const range=dateRange({startDate:'2026-10-01',endDate:'2026-10-31'});
 assert.equal(range[Op.gte].toISOString(),'2026-09-30T16:00:00.000Z');
 assert.equal(range[Op.lt].toISOString(),'2026-10-31T16:00:00.000Z');
 assert.throws(()=>dateRange({startDate:'2026-02-30'}));
 assert.throws(()=>dateRange({startDate:'2026-11-02',endDate:'2026-11-01'}));
 assert.equal(dateRange({}),null);
});
test('product lookup correlates business identity and searches only named JSON fields',()=>{
 const sequelize=new Sequelize('test','user','pass',{dialect:'mysql',logging:false});
 const model=(table,fields)=>({getTableName:()=>table,rawAttributes:Object.fromEntries(fields.map(f=>[f,{field:f.toUpperCase()}]))});
 const M={sequelize,ApprovalFlowInstance:model('I',['payload_json','business_type','business_id']),Product:model('P',['product_id','manufacturer_code']),PurchaseRequest:model('R',['request_id']),PurchaseRequestItem:model('RI',['request_id','product_id','pn_code','direct_inbound_sn_code'])};
 const registry={purchase_request:{model:'PurchaseRequest',id:'request_id'}};
 const pn=productFilter(M,registry,'pn',"67D2%' OR 1=1 --").val;
 assert.match(pn,/LOCATE/);assert.match(pn,/JSON_VALID/);assert.match(pn,/\$\*\*\.pn_code/);
 assert.match(pn,/`ApprovalFlowInstance`.`BUSINESS_ID` COLLATE utf8mb4_unicode_ci IN/);
 assert.match(pn,/SELECT `c`.`REQUEST_ID` COLLATE utf8mb4_unicode_ci FROM `RI`/);
 assert.equal(productFilter(M,registry,'sn',''),null);
 assert.throws(()=>productFilter(M,registry,'sn','x'.repeat(129)));
});
