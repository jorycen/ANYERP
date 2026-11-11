const {test}=require('node:test'),a=require('node:assert/strict');
const {fingerprint}=require('../src/modules/report/correctionFingerprint');
test('object key order and maintenance timestamps do not invalidate an unchanged preview',()=>{
 const input={itemId:'1',unitPrice:619},before={snapshot:{gross_profit_amount:'249.13',update_time:'old',calculated_at:'old',calculated_by:'sync',product_pricing_details:[{itemId:1,unitPricing:620}]}},order={order_id:'O',archive_time:new Date('2026-11-04T06:23:57Z'),update_time:'old'};
 const same={snapshot:{product_pricing_details:[{unitPricing:620,itemId:1}],calculated_by:'another',gross_profit_amount:'249.13',calculated_at:'new',update_time:'new'}};
 a.equal(fingerprint(input,before,order),fingerprint({unitPrice:619,itemId:'1'},same,{update_time:'new',archive_time:order.archive_time,order_id:'O'}));
 a.notEqual(fingerprint(input,before,order),fingerprint({...input,unitPrice:618},same,order));
 a.notEqual(fingerprint(input,before,order),fingerprint(input,{snapshot:{...before.snapshot,gross_profit_amount:'250.13'}},order));
 a.notEqual(fingerprint(input,before,order),fingerprint(input,before,{...order,archive_time:new Date('2026-11-05T06:23:57Z')}));
 a.notEqual(fingerprint(input,before,order),fingerprint(input,{snapshot:{...before.snapshot,product_pricing_details:[{itemId:1,unitPricing:620,purchaseTaxBasis:{basisRevision:2}}]}},order));
});
