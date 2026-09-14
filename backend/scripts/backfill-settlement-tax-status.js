const {
  Settlement,
  SettlementItem,
  Payable,
  PurchaseRequest,
  Expense,
  sequelize
} = require('../src/models');
const { getPayableTaxStatus, combineTaxStatuses } = require('../src/modules/finance/payableController');

const execute = process.argv.includes('--execute');

async function loadExpectedStatuses() {
  const settlements = await Settlement.findAll({
    where: { is_deleted: 0 },
    include: [{ model: SettlementItem, as: 'items' }],
    order: [['create_time', 'ASC']]
  });
  const payableIds = [...new Set(settlements.flatMap(row => (row.items || []).map(item => item.payable_id).filter(Boolean)))];
  const payables = payableIds.length ? await Payable.findAll({
    where: { payable_id: payableIds },
    attributes: ['payable_id', 'request_id', 'source_type', 'source_id']
  }) : [];
  const payableMap = new Map(payables.map(row => [String(row.payable_id), row]));
  const requestIds = [...new Set(payables.map(row => row.request_id).filter(Boolean))];
  const expenseIds = [...new Set(payables
    .filter(row => ['expense', 'reimbursement'].includes(row.source_type))
    .map(row => row.source_id).filter(Boolean))];
  const [requests, expenses] = await Promise.all([
    requestIds.length ? PurchaseRequest.findAll({ where: { request_id: requestIds }, attributes: ['request_id', 'invoice_type'] }) : [],
    expenseIds.length ? Expense.findAll({ where: { expense_id: expenseIds }, attributes: ['expense_id', 'invoice_type'] }) : []
  ]);
  const requestMap = new Map(requests.map(row => [String(row.request_id), row.invoice_type]));
  const expenseMap = new Map(expenses.map(row => [String(row.expense_id), row.invoice_type]));

  return settlements.map(settlement => {
    const statuses = (settlement.items || []).map(item => {
      const payable = payableMap.get(String(item.payable_id));
      if (!payable) return 'UNKNOWN';
      const invoiceType = ['expense', 'reimbursement'].includes(payable.source_type)
        ? expenseMap.get(String(payable.source_id))
        : requestMap.get(String(payable.request_id));
      return getPayableTaxStatus(invoiceType);
    });
    const expected = combineTaxStatuses(statuses);
    return {
      settlement,
      before: String(settlement.tax_status || 'UNKNOWN').toUpperCase(),
      expected,
      sourceCount: statuses.length
    };
  }).filter(item => item.sourceCount > 0 && item.before !== item.expected);
}

async function main() {
  const changes = await loadExpectedStatuses();
  const report = changes.map(item => ({
    settlement_no: item.settlement.settlement_no,
    before: item.before,
    after: item.expected,
    source_count: item.sourceCount
  }));
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', count: report.length, settlements: report }, null, 2));
  if (!execute || !changes.length) return;

  await sequelize.transaction(async transaction => {
    for (const item of changes) {
      const locked = await Settlement.findByPk(item.settlement.settlement_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!locked || locked.is_deleted) continue;
      await locked.update({ tax_status: item.expected }, { transaction });
    }
  });
  console.log(`Updated ${changes.length} settlement tax snapshots.`);
}

main()
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
