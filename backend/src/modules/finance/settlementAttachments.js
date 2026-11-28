function attachmentFiles(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(attachmentFiles);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (/^[\[{]/.test(text)) {
      try { return attachmentFiles(JSON.parse(text)); } catch { return []; }
    }
    const parts = text.split(/[\r\n]+|,(?=\s*(?:https?:\/\/|cloud:\/\/|\/(?!\/)))/);
    if (parts.length > 1) return parts.flatMap(attachmentFiles);
    return /^(https?:\/\/|cloud:\/\/|\/(?!\/))/i.test(text) ? [{ url: text }] : [];
  }
  if (typeof value !== 'object') return [];
  const url = value.url || value.fileID || value.fileId || value.file_id || value.path;
  return attachmentFiles(url).map(file => ({ ...file, name: String(value.name || value.fileName || '') }));
}
function collectSettlementAttachments(settlement, expenses = []) {
  const files = new Map();
  const add = (value, sourceNo, sourceType) => {
    for (const file of attachmentFiles(value)) {
      if (files.has(file.url)) continue;
      files.set(file.url, { ...file, name: file.name || `申请附件${files.size + 1}`, sourceNo: sourceNo || '', sourceType });
    }
  };
  add(settlement.other_payment_image, settlement.settlement_no, 'settlement');
  for (const expense of [...expenses, ...(settlement.items || []).map(item => item.expense).filter(Boolean)]) {
    add(expense.attachment_urls, expense.expense_no, 'expense');
  }
  return [...files.values()];
}
module.exports = { attachmentFiles, collectSettlementAttachments };
