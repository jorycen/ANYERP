function money(value) {
  const number = Number(value || 0);
  return Number((Number.isFinite(number) ? number : 0).toFixed(2));
}

function allocateProfit(participants, grossProfit) {
  const total = money(grossProfit);
  if (!participants.length) return [];
  const auxiliaries = participants.slice(1);
  const hasCustom = auxiliaries.some(item =>
    Number(item.profitAmount) > 0 || (item.ratio !== '' && item.ratio !== null && Number.isFinite(Number(item.ratio)))
  );
  if (!hasCustom) {
    let allocated = 0;
    return participants.map((_, index) => {
      const amount = index === participants.length - 1
        ? money(total - allocated)
        : money(total / participants.length);
      allocated = money(allocated + amount);
      return amount;
    });
  }

  const shares = [0];
  let allocated = 0;
  for (const item of auxiliaries) {
    const fixed = Number(item.profitAmount);
    const ratio = Number(item.ratio);
    const amount = Number.isFinite(fixed) && fixed > 0
      ? money(fixed)
      : item.ratio !== '' && item.ratio !== null && Number.isFinite(ratio)
        ? money(total * Math.max(0, Math.min(100, ratio)) / 100)
        : 0;
    allocated = money(allocated + amount);
    shares.push(amount);
  }
  shares[0] = money(total - allocated);
  return shares;
}

module.exports = { allocateProfit, money };
