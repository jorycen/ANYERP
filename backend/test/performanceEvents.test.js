const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const M = require('../src/models');
const { returnEvents, savedItemProfit } = require('../src/modules/report/performanceEvents');
const { getEmployeePerformanceReport } = require('../src/modules/report/controller');
const { RealtimeSqlDashboardDataSource } = require('../src/modules/report/dashboardDataSource');
const { buildEmployeePerformance } = require('../src/modules/report/dashboardService');
const { createSalesReturnGrossProfitLedger } = require('../src/modules/sales/grossProfit');

test('生成退单流水沿用旧版本毛利快照，亏损反冲正确且重复完成不重复记账', async t => {
  const saved = [];
  t.mock.method(M.SalesReturnGrossProfitLedger, 'findAll', async () => saved);
  t.mock.method(M.SalesReturnGrossProfitLedger, 'create', async row => { saved.push(row); return row; });
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'O', order_no: 'SO1', total_amount: 1000, store_id: 'S', create_staff_id: 1, create_user: 'A' }));
  t.mock.method(M.SalesReturnRequestItem, 'findAll', async () => [{ unit_price: 1000, quantity: 1 }]);
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => ({ formula_version: 'historical', gross_profit_amount: -100 }));
  t.mock.method(M.ProductPrice, 'findAll', async () => { throw Error('must not reprice'); });
  t.mock.method(M.OrderItem, 'findAll', async () => { throw Error('existing snapshot must be reused'); });
  const input = { returnRequest: { return_id: 'R', return_no: 'RET1', order_id: 'O' } };
  await createSalesReturnGrossProfitLedger(input);
  await createSalesReturnGrossProfitLedger(input);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].gross_profit_amount, 100);
  assert.equal(saved[0].returned_sales_amount, -1000);
});

test('退单保留冻结人员金额、原单关联和完成时间，原亏损订单冲回正毛利', () => {
  const rows = [
    { return_id: 'R', return_no: 'RET1', order_id: 'O', order_no: 'SO1', create_time: '2026-11-01', staff_id: 1, employee_name: 'A', returned_sales_amount: -50, gross_profit_amount: 6.67 },
    { return_id: 'R', return_no: 'RET1', order_id: 'O', order_no: 'SO1', create_time: '2026-11-01', staff_id: 2, employee_name: 'B', returned_sales_amount: -50, gross_profit_amount: 3.33 }
  ];
  const [event] = returnEvents(rows);
  assert.equal(event.grossProfit, 10);
  assert.equal(event.totalAmount, -100);
  assert.equal(event.sourceOrderNo, 'SO1');
  assert.equal(event.orderTime, '2026-11-01');
  assert.deepEqual(event.participantAllocations.map(p => p.grossProfit), [6.67, 3.33]);
  assert.equal(savedItemProfit({ sale_price: 9999, sales_gross_profit: 0 }).grossProfit, 0);
});

test('看板按退单日期独立查询，不向原单重复并入流水；保留已退单原销售', async () => {
  const source = new RealtimeSqlDashboardDataSource();
  const calls = [];
  source.query = async (sql, replacements) => { calls.push({ sql, replacements }); return []; };
  const filters = { storeIds: ['S'], employeeId: 1, productLine: '笔记本' };
  const range = { startAt: '2026-11-01', endAt: '2026-11-30' };
  await source.getEmployeeOrderRows(filters, range);
  assert.ok(calls[0].replacements.archivedStatuses.includes('returned'));
  assert.doesNotMatch(calls[0].sql, /SUM\(r\.RETURNED_SALES_AMOUNT\)/);
  assert.match(calls[0].sql, /oi\.SALES_GROSS_PROFIT/);
  assert.match(calls[1].sql, /rgp\.CREATE_TIME >=/);
  assert.doesNotMatch(calls[1].sql, /o\.CREATE_TIME >=|o\.ORDER_STATUS IN/);
  assert.match(calls[1].sql, /STORE_ID IN|CATEGORY/);
  calls.length = 0;
  await source.getApprovedAdjustments(filters, range);
  assert.doesNotMatch(calls[0].sql, /T_SALES_RETURN_GROSS_PROFIT/);
  assert.match(calls[0].sql, /pa\.CREATE_TIME >=/);
  const result = buildEmployeePerformance([
    { order_id: 'O', order_no: 'SO1', create_staff_id: 1, create_user: 'A', sales_amount: 100, base_gross_profit: 10 },
    { order_id: 'return:R', order_no: 'RET1', source_order_no: 'SO1', entry_type: 'return', create_staff_id: 1, create_user: 'A', sales_amount: -100, base_gross_profit: -10 }
  ], [], '', true);
  assert.equal(result.ranking[0].grossProfit, 0);
  assert.equal(result.ranking[0].participatedOrderCount, 1);
  assert.equal(result.details.length, 2);
});

test('员工报表同月、跨月、部分退货汇总与分页保持一致，查询不重取产品成本', async t => {
  const saleDate = new Date('2026-10-01T12:00:00');
  let returnDate = new Date('2026-11-01T12:00:00');
  let returnProfit = -100;
  let returnSales = -1000;
  let reversalAdjustment = 0;
  const snapshot = { order_id: 'O', gross_profit_amount: 100, product_pricing_amount: 900, product_pricing_details: '[]' };
  const order = { order_id: 'O', order_no: 'SO1', create_time: saleDate, order_status: 'returned', create_user: 'A', create_staff_id: 1, store_id: 'S', total_amount: 1000, actual_payment: 1000, Store: { name: 'S' }, OrderItems: [], grossProfitSnapshot: snapshot };
  const inRange = (date, range) => !range || date >= range[Op.gte] && date <= range[Op.lte];
  const dataSource = require('../src/modules/report/dashboardDataSource').RealtimeSqlDashboardDataSource;
  const inside = (date, range) => date >= new Date(`${range.startDate}T00:00:00+08:00`) && date <= new Date(`${range.endDate}T23:59:59.999+08:00`);
  t.mock.method(dataSource.prototype, 'getEmployeeOrderRows', async (_, range) => [
    ...(inside(saleDate, range) ? [{ ...order, sales_amount: 1000, base_gross_profit: 100 }] : []),
    ...(inside(returnDate, range) ? [{ ...order, order_id: 'return:R', entry_type: 'return', create_time: returnDate, sales_amount: returnSales, base_gross_profit: returnProfit }] : []),
    ...(reversalAdjustment && inside(returnDate, range) ? [{ ...order, order_id: 'return-adjustment:ADJ', entry_type: 'return_adjustment', create_time: returnDate, sales_amount: 0, base_gross_profit: 0 }] : [])
  ]);
  t.mock.method(dataSource.prototype, 'getApprovedAdjustments', async (_, range) => reversalAdjustment && inside(returnDate, range)
    ? [{ orderId: 'return-adjustment:ADJ', signedAmount: reversalAdjustment }] : []);
  t.mock.method(M.Store, 'findAll', async () => [{ store_id: 'S' }]);
  t.mock.method(M.Order, 'findAll', async options => {
    const matched = inRange(saleDate, options.where.create_time);
    if (options.group) return matched ? [{ orderCount: 1, totalAmount: 1000, actualPayment: 1000 }] : [];
    if (options.include) return matched && options.where.order_id[Op.in].includes('O') ? [{ ...order, toJSON: () => order }] : [];
    if (options.attributes[0] === 'order_id') return matched ? [{ order_id: 'O', create_time: saleDate }] : [];
    return [{ name: 'A' }];
  });
  t.mock.method(M.OrderGrossProfit, 'findAll', async options => inRange(saleDate, options.include[0].where.create_time) ? [snapshot] : []);
  t.mock.method(M.OrderItem, 'findAll', async () => []);
  t.mock.method(M.ExpensePerformanceAllocation, 'findAll', async () => []);
  t.mock.method(M.PerformanceProfitAdjustment, 'findAll', async options => options.attributes ? [{ amount: 0 }] :
    reversalAdjustment && inRange(returnDate, options.where.create_time) ? [{ toJSON: () => ({
      adjustment_id: 'ADJ', adjustment_no: 'EDUR-TEST', order_id: 'O', order_no: 'SO1',
      create_time: returnDate, signed_amount: reversalAdjustment, employee_name: 'A', Order: order
    }) }] : []);
  t.mock.method(M.ProductPrice, 'findAll', async () => { throw Error('must not reprice'); });
  t.mock.method(M.SalesReturnGrossProfitLedger, 'findAll', async options => {
    assert.equal(options.include[0].where.create_time, undefined);
    assert.equal(options.include[0].where.order_status, undefined);
    return inRange(returnDate, options.where.create_time) ? [{ toJSON: () => ({ return_id: 'R', return_no: 'RET1', order_id: 'O', order_no: 'SO1', staff_id: 1, employee_name: 'A', create_time: returnDate, returned_sales_amount: returnSales, gross_profit_amount: returnProfit }) }] : [];
  });
  const run = async (month, page = 1, pageSize = 20) => {
    const ctx = { query: { startDate: `2026-${month}-01`, endDate: `2026-${month}-30`, page, pageSize }, state: { user: { roles: ['boss'] } } };
    await getEmployeePerformanceReport(ctx);
    return ctx.body;
  };
  assert.equal((await run('10')).summary.grossProfit, 100);
  const november = await run('11');
  assert.equal(november.summary.grossProfit, -100);
  assert.equal(november.list[0].entryType, 'return');
  assert.equal(november.summary.orderCount, 0);
  returnDate = new Date('2026-10-02T12:00:00');
  const sameMonth = await run('10', 1, 1);
  assert.equal(sameMonth.summary.grossProfit, 0);
  assert.equal(sameMonth.pagination.total, 2);
  assert.equal(sameMonth.list[0].entryType, 'return');
  assert.equal((await run('10', 2, 1)).list[0].entryType, 'sale');
  returnProfit = -40; returnSales = -400;
  assert.equal((await run('10')).summary.grossProfit, 60);
  const exportCtx = { query: { startDate: '2026-10-01', endDate: '2026-10-30', pageSize: 1 }, state: { user: { roles: ['boss'] } }, set() {} };
  await getEmployeePerformanceReport(exportCtx, true);
  const XLSX = require('xlsx');
  const book = XLSX.read(exportCtx.body, { type: 'buffer' });
  const exported = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
  assert.equal(exported.length, 2);
  assert.equal(exported.find(row => row['业务类型'] === '退单冲回')['原销售单号'], 'SO1');
  returnDate = new Date('2026-11-01T12:00:00');
  reversalAdjustment = -20;
  assert.equal((await run('10')).summary.grossProfit, 100);
  const withRewardReturn = await run('11');
  assert.equal(withRewardReturn.summary.grossProfit, -60);
  assert.equal(withRewardReturn.summary.approvedAdjustment, -20);
  assert.equal(withRewardReturn.list.length, 2);
});
