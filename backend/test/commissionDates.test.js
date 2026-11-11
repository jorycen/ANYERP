const {test}=require('node:test'),a=require('node:assert/strict');
const dates=require('../src/modules/report/commissionDates');
const {RealtimeSqlDashboardDataSource}=require('../src/modules/report/dashboardDataSource');
const {buildRanges,buildEmployeePerformance}=require('../src/modules/report/dashboardService');
test('archival date is authoritative; missing archive is unknown, not creation fallback',()=>{
 a.equal(dates.saleTime({order_id:'NEW',create_time:'2026-10-30',archive_time:'2026-11-02'}),'2026-11-02');
 a.equal(dates.saleTime({order_id:'NEW',create_time:'2026-10-30'}),undefined);
 a.equal(dates.saleTime({order_id:'BACKDATED-NEW',create_time:'2026-09-20',archive_time:'2026-10-03'}),'2026-10-03');
});
test('opening exception is a fixed 28-order list; UTC timestamps use China month boundaries',()=>{
 a.equal(dates.opening.orders.length,28);
 for(const order of dates.opening.orders){
  const r={order_id:order.orderId,create_time:new Date(order.createdAt),archive_time:new Date(order.archivedAt)};
  a.equal(dates.saleTime(r),r.create_time);
  a.equal(dates.saleTime({...r,archive_time:'2026-10-31T16:00:00Z'}),'2026-10-31T16:00:00Z');
  a.ok(dates.saleSql().includes(order.orderId));
  a.equal(dates.saleTime({...r,archive_time:new Date('2026-10-31T16:00:00Z')}).toISOString(),'2026-10-31T16:00:00.000Z');
 }
 a.throws(()=>dates.saleSql('o;DROP TABLE t'));
 a.equal(dates.adjustmentTime({create_time:'2026-10-01',update_time:'2026-12-01',admin_review_time:'2026-11-02'}),'2026-11-02');
 a.equal(dates.adjustmentTime({create_time:'2026-10-01'}),null);
});
test('employee source uses archive dates, independent approval events and ledger return dates',async()=>{
 const seen=[],source=new RealtimeSqlDashboardDataSource();source.query=async(sql,p)=>{seen.push({sql,p});return []};
 const filters={storeIds:['S'],archiveScope:'archived'},range=buildRanges({startDate:'2026-11-01',endDate:'2026-11-30'}).current;
 await source.getEmployeeOrderRows(filters,range);await source.getApprovedAdjustments(filters,range);
 const sale=seen.find(x=>x.sql.includes('AS base_gross_profit')&&x.sql.includes('FROM T_ORDER o'));
 a.match(sale.sql,/ELSE o.ARCHIVE_TIME END/);
 const ret=seen.find(x=>x.sql.includes('FROM T_SALES_RETURN_GROSS_PROFIT'));
 a.match(ret.sql,/rgp.CREATE_TIME >= :startAt/);a.doesNotMatch(ret.sql,/ELSE o.ARCHIVE_TIME END/);
 const approvals=seen.filter(x=>x.sql.includes('FROM T_PERFORMANCE_PROFIT_ADJUSTMENT'));
 a.equal(approvals.length,2);
 for(const q of approvals){a.match(q.sql,/pa.ADMIN_REVIEW_TIME >= :startAt/);a.doesNotMatch(q.sql,/o.ORDER_STATUS IN/);a.doesNotMatch(q.sql,/ADJUSTMENT_NO (?:NOT )?LIKE/)}
});
test('independent adjustments preserve saved participant proportions without phantom base profit or order counts',()=>{
 const order={order_id:'return-adjustment:A',source_order_id:'OLD',order_no:'ADJ',create_staff_id:1,create_user:'主销',
  auxiliary_sales_list:JSON.stringify([{staffId:2,name:'辅助',profitAmount:100}]),entry_type:'return_adjustment',base_gross_profit:0,allocation_gross_profit:1000,sales_amount:0};
 const r=buildEmployeePerformance([order],[{orderId:order.order_id,signedAmount:-200}],null,true,{allDetails:true});
 a.equal(r.ranking.reduce((s,x)=>s+x.grossProfit,0),-200);a.ok(r.ranking.every(x=>x.baseGrossProfit===0&&x.participatedOrderCount===0));
 a.equal(r.ranking.find(x=>String(x.staffId)==='2').grossProfit,-20);
});
test('new price correction reallocates sides once without adding company profit',()=>{
 const P=require('../src/modules/report/companyProfitDetails');
 const [event]=P.buildEvents({managementAdjustments:[{eventKey:'A',storeId:'S',amount:200,productAmount:-200,businessDate:'2026-11-02'}]});
 a.equal(event.salesGrossProfit,200);a.equal(event.productGrossProfit,-200);a.equal(event.companyGrossProfit,0);
});
