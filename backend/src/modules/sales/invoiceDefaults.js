// Form defaults only: never rewrites submitted invoice choices or historical orders.
function corporateInvoiceDefaults(body = {}) {
  const payments = Array.isArray(body.payments) ? body.payments : [];
  const isGuobu = body.subsidyStatus === '国补' || Number(body.nationalSubsidy) > 0
    || payments.some(row => String(row.type || row.method || '').includes('国补') && Number(row.amount) > 0);
  const corporate = payments.filter(row => String(row.type || row.method || '').trim() === '对公转账');
  if (isGuobu || !corporate.length) return { applies: false };
  const amount = corporate.reduce((total, row) => {
    const value = Number(row.amount);
    return total + (Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0);
  }, 0);
  return { applies: true, invoiceStatus: '开专票', invoiceAmount: (amount / 100).toFixed(2) };
}

async function invoiceDefaults(ctx) {
  ctx.body = { code: 0, data: corporateInvoiceDefaults(ctx.request.body) };
}
module.exports = { corporateInvoiceDefaults, invoiceDefaults };
