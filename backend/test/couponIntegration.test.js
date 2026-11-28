const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models');
const {getOrderDailyReceiptTotals,createSalesReturnSettlement}=require('../src/modules/sales/salesReturnSettlement');
const {ensureCouponColumns}=require('../src/utils/couponMigration');
const {expandSettlementPayments,calculateCoupon}=require('../src/modules/sales/couponPricing');
const rule={kind:'douyin',faceAmount:300,purchaseAmount:99,platformRate:3,mallRate:50,mallAccountId:'mall',platformAccountId:'platform'};
test('duplicate coupon payment rows are combined instead of overwriting daily settlement',()=>{
 const a={payment_method:'D99',amount:300,coupon_snapshot:calculateCoupon(rule,300)};
 const rows=expandSettlementPayments([a,a,{payment_method:'cash',amount:700}]);
 assert.equal(rows.length,3);assert.equal(rows.find(x=>x.coupon_account_id==='mall').amount,201);
 assert.equal(rows.find(x=>x.coupon_account_id==='platform').amount,192.06);
});
test('cash refund source excludes coupon platform net and mall contributions including pure coupon orders',async t=>{
 t.mock.method(M.OrderPayment,'findAll',async()=>[{payment_method:'D99',amount:300,coupon_snapshot:calculateCoupon(rule,300)}]);
 t.mock.method(M.DailyStatementDetail,'findAll',async()=>[
  {business_type:'coupon_receivable',amount:96.03},{business_type:'coupon_receivable',amount:100.5}]);
 const total=await getOrderDailyReceiptTotals('O');
 assert.equal(total.hasCoupon,true);assert.equal(total.customerReceiptAmount,0);assert.equal(total.customerDetails.length,0);
});
test('coupon refund fallback without daily rows uses only other real receipts',async t=>{
 t.mock.method(M.OrderPayment,'findAll',async()=>[{payment_method:'D99',amount:300,coupon_snapshot:calculateCoupon(rule,300)},{payment_method:'cash',amount:700}]);
 t.mock.method(M.DailyStatementDetail,'findAll',async()=>[]);
 const total=await getOrderDailyReceiptTotals('O');assert.equal(total.customerReceiptAmount,700);
});
test('coupon migration is idempotent and fails closed on DDL rejection',async()=>{
 const columns=new Set();let alters=0;
 const db={query:async(sql,opts)=>{
  if(sql.startsWith('ALTER')){columns.add(sql.split(' ')[2]);alters++;return [];}
  return [columns.has(opts.replacements.table)?[{}]:[]];
 }};
 await ensureCouponColumns(db);await ensureCouponColumns(db);assert.equal(alters,2);
 await assert.rejects(ensureCouponColumns({query:async sql=>{if(sql.startsWith('ALTER'))throw Error('DDL denied');return [[]];}}),/DDL denied/);
});
test('return settlement treats pure coupon refund as offset and reverses only frozen receivables',async t=>{
 const added=[];let created;
 t.mock.method(M.SalesReturnSettlement,'findOne',async()=>null);
 t.mock.method(M.SalesReturnSettlement,'findAll',async()=>[]);
 t.mock.method(M.SalesReturnSettlement,'create',async row=>{created=row;return row;});
 t.mock.method(M.OrderItem,'findAll',async()=>[{item_id:'I',sale_price:300,quantity:1}]);
 t.mock.method(M.OrderPayment,'findAll',async()=>[{payment_method:'D99',amount:300,coupon_snapshot:calculateCoupon(rule,300)}]);
 t.mock.method(M.DailyStatementDetail,'findAll',async()=>[]);
 t.mock.method(M.DailyStatementDetail,'findOne',async()=>null);
 t.mock.method(M.DailyStatementDetail,'create',async row=>{added.push(row);return row;});
 t.mock.method(M.DailyStatement,'findOrCreate',async()=>[{statement_id:'S',update:async()=>{}}]);
 t.mock.method(M.SalesReturnSettlementItem,'create',async()=>({}));
 t.mock.method(M.SalesReturnRedInvoice,'findOrCreate',async()=>[{}]);
 t.mock.method(require('../src/modules/customerOps/service'),'reverseReturn',async()=>{});
 await createSalesReturnSettlement({order:{order_id:'O',order_no:'ORD',store_id:'ST',actual_payment:300,total_amount:300,invoice_status:'不开票'},returnRequest:{return_id:'R',return_no:'RT'},requestItems:[{order_item_id:'I',unit_price:300,quantity:1}],user:{},transaction:{LOCK:{UPDATE:'UPDATE'}}});
 assert.equal(created.customer_refund_amount,0);assert.equal(created.settlement_status,'offset');
 assert.equal(added.length,2);assert.ok(added.every(x=>x.business_type==='coupon_receivable_reversal'));
 assert.equal(added.reduce((s,x)=>s+Math.round(x.amount*100),0),-19653);
});
test('return preview uses original order prices and authoritative receipts, rejecting tampered quantities',async t=>{
 const C=require('../src/modules/sales/controller');
 t.mock.method(M.Order,'findByPk',async()=>({order_id:'O',store_id:'ST',order_status:'已归档',total_amount:1000,actual_payment:1000}));
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'ST',distributor_id:'D'}));
 t.mock.method(M.OrderItem,'findAll',async()=>[{item_id:'I',sale_price:1000,quantity:1}]);
 t.mock.method(M.OrderPayment,'findAll',async()=>[{payment_method:'D99',amount:300,coupon_snapshot:calculateCoupon(rule,300)},{payment_method:'cash',amount:700}]);
 t.mock.method(M.DailyStatementDetail,'findAll',async()=>[]);
 const ctx={state:{user:{roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']}},request:{body:{orderId:'O',items:[{itemId:'I',quantity:1,unit_price:99999}]}},throw(s,m){throw Object.assign(Error(m),{status:s})}};
 await C.previewCouponReturn(ctx);assert.equal(ctx.body.data.customerAmount,700);assert.equal(ctx.body.data.grossAmount,1000);
 ctx.request.body.items[0].quantity=2;await assert.rejects(C.previewCouponReturn(ctx),{status:400});
});
test('coupon configuration updates persist normalized rules and leave an audit record',async t=>{
 const C=require('../src/modules/dict/controller');let saved,audit;
 t.mock.method(M.PaymentMethod,'findByPk',async()=>({name:'D99',coupon_rule:null,default_tax_rate:0,update:async v=>{saved=v}}));
 t.mock.method(M.PaymentMethod,'findAll',async()=>[]);
 t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_type:'FUND'},{account_type:'FUND'}]);
 t.mock.method(M.BusinessActionLog,'create',async v=>{audit=v;return v;});
 t.mock.method(M.sequelize,'transaction',async()=>({commit:async()=>{},rollback:async()=>{}}));
 const ctx={params:{id:'P'},state:{user:{roles:['boss'],accessibleDistributorIds:['*']}},request:{body:{couponRule:rule}},throw(s,m){throw Object.assign(Error(m),{status:s})}};
 await C.updatePaymentMethod(ctx);assert.equal(saved.coupon_rule.mallRate,50);assert.equal(audit.business_type,'coupon_scheme');
 assert.equal(ctx.body.code,0);
});
