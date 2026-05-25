const { Sequelize } = require('./src/models');
const { DailyStatement, DailyStatementDetail, Order, OrderPayment } = require('./src/models');

(async () => {
  try {
    const stmts = await DailyStatement.findAll({ limit: 3, order: [['statement_date', 'DESC']] });
    console.log('DailyStatements:', stmts.length);
    stmts.forEach(s => console.log('  ', s.statement_date, s.store_id, 'total:', s.total_revenue, 'status:', s.status));

    const details = await DailyStatementDetail.findAll({ limit: 5, order: [['detail_id', 'DESC']] });
    console.log('DailyStatementDetails:', details.length);
    details.forEach(d => console.log('  ', d.order_no, d.payment_method, d.amount, 'settled:', d.settled));

    const orders = await Order.findAll({ where: { order_status: 'completed' }, limit: 3, order: [['create_time', 'DESC']], include: [{ model: OrderPayment }] });
    console.log('Orders with payments:', orders.length);
    
    process.exit(0);
  } catch(e) { console.error(e); process.exit(1); }
})();
