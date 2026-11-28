function isPurchaseUpliftExemptCategory(category) {
  return /^(售后|二手)/.test(String(category || '').trim());
}

module.exports = { isPurchaseUpliftExemptCategory };
