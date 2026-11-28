function invoiceAmounts(totalValue, rateValue) {
  const total = Number(totalValue), rate = Number(rateValue);
  if (totalValue === null || totalValue === '' || typeof totalValue === 'boolean' || !Number.isFinite(total) || total < 0 || Math.abs(total * 100 - Math.round(total * 100)) > 0.000001) throw Object.assign(new Error('价税合计须为非负金额，最多两位小数'), { status: 400 });
  if (rateValue === null || rateValue === '' || typeof rateValue === 'boolean' || !Number.isFinite(rate) || rate < 0 || rate > 1) throw Object.assign(new Error('税率须在0到1之间'), { status: 400 });
  const totalCents = Math.round(total * 100);
  const withoutCents = Math.round(totalCents / (1 + rate));
  return { totalAmount: totalCents / 100, amountWithoutTax: withoutCents / 100, taxAmount: (totalCents - withoutCents) / 100, taxRate: rate };
}
function invoiceNumbers(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw Object.assign(new Error('请填写1至100个发票号码'), { status: 400 });
  const numbers = values.map(value => typeof value === 'string' ? value.trim() : '');
  if (numbers.some(number => !number || number.length > 64)) throw Object.assign(new Error('请完整填写发票号码，每个最多64字'), { status: 400 });
  if (new Set(numbers.map(number => number.toUpperCase())).size !== numbers.length) throw Object.assign(new Error('发票号码不能重复'), { status: 400 });
  return numbers;
}
module.exports = { invoiceAmounts, invoiceNumbers };
