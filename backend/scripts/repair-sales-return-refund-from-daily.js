const {
  Order,
  OrderItem,
  SalesReturnRequest,
  SalesReturnRequestItem,
  SalesReturnSettlement,
  DailyStatement,
  DailyStatementDetail,
  SettlementAccountTransaction,
  sequelize
} = require('../src/models');
const { generateUUID } = require('../src/utils');
const {
  getOrderDailyReceiptTotals,
  mergeReturnItemsWithOrderResources,
  _test: { calculateReturnSettlementAmounts }
} = require('../src/modules/sales/salesReturnSettlement');

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

async function accountBalance(accountId, transaction) {
  const [income, expense] = await Promise.all([
    SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'income' }, transaction }),
    SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'expense' }, transaction })
  ]);
  return money(Number(income || 0) - Number(expense || 0));
}

async function buildRepairPlan(orderNo, transaction = null) {
  const order = await Order.findOne({ where: { order_no: orderNo }, transaction });
  if (!order) throw new Error(`订单不存在：${orderNo}`);
  const orderItems = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  const returns = await SalesReturnRequest.findAll({
    where: { order_id: order.order_id, status: 'completed' },
    order: [['create_time', 'ASC']],
    transaction
  });
  if (!returns.length) throw new Error(`订单没有已完成退单：${orderNo}`);
  const dailyReceipts = await getOrderDailyReceiptTotals(order.order_id, transaction);
  if (!dailyReceipts.customerDetails.length) throw new Error(`订单没有日结直接到账记录：${orderNo}`);

  const plans = [];
  for (const returnRequest of returns) {
    const [requestItems, settlement, negativeDetails] = await Promise.all([
      SalesReturnRequestItem.findAll({ where: { return_id: returnRequest.return_id }, transaction }),
      SalesReturnSettlement.findOne({ where: { return_id: returnRequest.return_id }, transaction }),
      DailyStatementDetail.findAll({
        where: {
          order_id: returnRequest.return_id,
          business_type: 'sales_return_customer_receipt'
        },
        attributes: [
          'detail_id', 'statement_id', 'payment_method', 'payment_code', 'business_type',
          'amount', 'settled', 'settled_at', 'settlement_account_id'
        ],
        transaction,
        raw: true
      })
    ]);
    if (!settlement) throw new Error(`退单缺少负向结算：${returnRequest.return_no}`);
    const resolvedItems = mergeReturnItemsWithOrderResources(orderItems, requestItems);
    const amounts = calculateReturnSettlementAmounts({
      order,
      orderItems,
      requestItems: resolvedItems,
      customerReceiptAmount: dailyReceipts.customerReceiptAmount,
      policySubsidyAmount: dailyReceipts.policySubsidyAmount || Number(order.national_subsidy || 0)
    });
    const desiredDetails = [];
    let allocated = 0;
    dailyReceipts.customerDetails.forEach((source, index) => {
      const amount = index === dailyReceipts.customerDetails.length - 1
        ? money(amounts.customerRefundAmount - allocated)
        : money(amounts.customerRefundAmount * Number(source.amount || 0) / Math.max(dailyReceipts.customerReceiptAmount, 0.01));
      allocated = money(allocated + amount);
      const existing = negativeDetails.find(detail => (
        String(detail.payment_code || detail.payment_method || '') === String(source.payment_code || source.payment_method || '')
      ));
      desiredDetails.push({
        source,
        existing,
        desiredAmount: -amount,
        currentAmount: money(existing?.amount),
        currentSettled: money(existing?.settled)
      });
    });
    plans.push({ returnRequest, settlement, amounts, desiredDetails });
  }
  return { order, dailyReceipts, plans };
}

async function applyRepair(orderNo) {
  return sequelize.transaction(async transaction => {
    const plan = await buildRepairPlan(orderNo, transaction);
    const touchedStatements = new Set();
    for (const item of plan.plans) {
      const { returnRequest, settlement, amounts, desiredDetails } = item;
      const snapshot = parseJson(settlement.snapshot_json, {});
      await returnRequest.update({ refund_amount: amounts.customerRefundAmount }, { transaction });
      await settlement.update({
        customer_received_amount: -amounts.customerRefundAmount,
        policy_subsidy_receivable_amount: -amounts.policyAmount,
        education_subsidy_amount: -amounts.educationAmount,
        customer_refund_amount: amounts.customerRefundAmount,
        snapshot_json: JSON.stringify({
          ...snapshot,
          policyAmount: amounts.policyAmount,
          educationAmount: amounts.educationAmount,
          customerRefundAmount: amounts.customerRefundAmount,
          dailyCustomerReceiptAmount: plan.dailyReceipts.customerReceiptAmount,
          amountSource: 'daily_statement_actual_receipt',
          repairedAt: new Date().toISOString(),
          repairReason: '退单现金退款改按原日结实际直接到账金额'
        }),
        update_time: new Date()
      }, { transaction });

      for (const detailPlan of desiredDetails) {
        const { source, existing, desiredAmount, currentAmount, currentSettled } = detailPlan;
        if (!existing) throw new Error(`退单 ${returnRequest.return_no} 缺少${source.payment_method}负向日结明细`);
        const correction = money(desiredAmount - currentAmount);
        if (Math.abs(correction) < 0.01) continue;
        const wasSettled = Math.abs(currentSettled) > 0;
        await DailyStatementDetail.update({
          amount: desiredAmount,
          ...(wasSettled ? { settled: desiredAmount } : {})
        }, { where: { detail_id: existing.detail_id }, transaction });
        touchedStatements.add(existing.statement_id);

        if (wasSettled && existing.settlement_account_id) {
          const reference = `RETURN_RECEIPT_FIX_${returnRequest.return_id}_${existing.detail_id}`.slice(0, 128);
          const duplicate = await SettlementAccountTransaction.findOne({
            where: { related_ref: reference },
            transaction,
            lock: transaction.LOCK.UPDATE
          });
          if (!duplicate) {
            const signedAccountChange = correction;
            const balanceBefore = await accountBalance(existing.settlement_account_id, transaction);
            await SettlementAccountTransaction.create({
              transaction_id: generateUUID(),
              account_id: existing.settlement_account_id,
              type: signedAccountChange >= 0 ? 'income' : 'expense',
              amount: Math.abs(signedAccountChange),
              balance_after: money(balanceBefore + signedAccountChange),
              description: `退单按日结实际到账纠正：${returnRequest.return_no}`,
              related_ref: reference,
              create_user: 'repair-script',
              create_time: new Date()
            }, { transaction });
          }
        }
      }
    }

    for (const statementId of touchedStatements) {
      const details = await DailyStatementDetail.findAll({
        where: { statement_id: statementId },
        attributes: ['amount', 'settled'],
        transaction,
        raw: true
      });
      const totalRevenue = money(details.reduce((sum, detail) => sum + Number(detail.amount || 0), 0));
      const totalSettled = money(details.reduce((sum, detail) => sum + Number(detail.settled || 0), 0));
      const status = Math.abs(totalRevenue - totalSettled) < 0.01
        ? 'settled'
        : (Math.abs(totalSettled) > 0 ? 'partial' : 'pending');
      await DailyStatement.update({ total_revenue: totalRevenue, total_settled: totalSettled, status }, {
        where: { statement_id: statementId },
        transaction
      });
    }
    return buildRepairPlan(orderNo, transaction);
  });
}

function summarize(plan) {
  return {
    orderNo: plan.order.order_no,
    orderId: plan.order.order_id,
    dailyCustomerReceiptAmount: plan.dailyReceipts.customerReceiptAmount,
    dailyPolicySubsidyAmount: plan.dailyReceipts.policySubsidyAmount,
    returns: plan.plans.map(item => ({
      returnNo: item.returnRequest.return_no,
      currentRequestRefundAmount: money(item.returnRequest.refund_amount),
      currentSettlementRefundAmount: money(item.settlement.customer_refund_amount),
      targetCustomerRefundAmount: item.amounts.customerRefundAmount,
      targetPolicySubsidyAmount: item.amounts.policyAmount,
      dailyDetails: item.desiredDetails.map(detail => ({
        paymentMethod: detail.source.payment_method,
        currentAmount: detail.currentAmount,
        currentSettled: detail.currentSettled,
        targetAmount: detail.desiredAmount
      }))
    }))
  };
}

async function main() {
  const orderArg = process.argv.find(arg => arg.startsWith('--order-no='));
  const orderNo = orderArg ? orderArg.slice('--order-no='.length).trim() : '';
  const apply = process.argv.includes('--apply');
  if (!orderNo) throw new Error('请使用 --order-no=销售订单号 指定待修复订单');
  const plan = apply ? await applyRepair(orderNo) : await buildRepairPlan(orderNo);
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', ...summarize(plan) }, null, 2));
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}

module.exports = { buildRepairPlan, applyRepair, summarize };
