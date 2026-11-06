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

function isInstantRetail(order) {
  const created = order.create_time;
  const day = created instanceof Date
    ? new Date(created.getTime() + 8 * 3600000).toISOString().slice(0, 10)
    : String(created || '').slice(0, 10);
  return String(order.customer_source || '').trim() === '即时零售' && day >= '2026-10-01';
}

function splitInstantRetail(total, participantCount = 0) {
  if (total == null) return { sales: null, operations: null, shares: [] };
  const cents = Math.round(money(total) * 100);
  const operations = Math.sign(cents) * Math.ceil(Math.abs(cents) / 2);
  const sales = cents - operations;
  if (!participantCount) return { sales: sales / 100, operations: operations / 100, shares: [] };
  const each = Math.trunc(sales / participantCount);
  const remainder = sales % participantCount;
  const shares = Array.from({ length: participantCount }, (_, index) =>
    (each + (index < Math.abs(remainder) ? Math.sign(remainder) : 0)) / 100);
  return { sales: sales / 100, operations: operations / 100, shares };
}

function instantRetailStaffShares(total, participants) {
  const ordered = participants.map((participant, index) => ({ index, staffId: String(participant.staffId ?? '') }))
    .sort((a, b) => a.staffId.localeCompare(b.staffId));
  const { shares } = splitInstantRetail(total, ordered.length);
  const byParticipant = [];
  ordered.forEach(({ index }, position) => { byParticipant[index] = shares[position]; });
  return byParticipant;
}

// Return ledgers contain the original full sales margin, one row per participant.
function instantRetailReturnShares(rows, groupKey, orderOf, amountOf) {
  const groups = new Map();
  for (const row of rows) {
    if (!isInstantRetail(orderOf(row))) continue;
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const shares = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => String(a.staff_id ?? a.create_staff_id ?? '').localeCompare(String(b.staff_id ?? b.create_staff_id ?? '')));
    const split = splitInstantRetail(group.reduce((sum, row) => sum + Number(amountOf(row)), 0), group.length);
    group.forEach((row, index) => shares.set(row, split.shares[index]));
  }
  return shares;
}

module.exports = { allocateProfit, money, isInstantRetail, splitInstantRetail, instantRetailStaffShares, instantRetailReturnShares };
