export function purchaseApprovalForm(data = {}) {
  return { supplierName: data.supplier_name || data.Supplier?.name || '', storeName: data.store_name || data.Store?.name || '',
    invoiceType: data.invoice_type || data.invoiceType || '',
    paymentMethod: data.payment_method || data.paymentMethod || '',
    items: (data.items || []).map(item => ({ itemId: item.item_id || item.itemId,
      productName: item.product_name || item.productName || '', isUsedProduct: Number(item.is_used_product || item.isUsedProduct) === 1,
      pnCode: item.pn_code || item.pnCode || '', quantity: item.quantity, unitPrice: item.unit_price ?? item.unitPrice, subtotal: item.subtotal,
      grossProfitCostMode: item.gross_profit_cost_mode || item.grossProfitCostMode || 'PURCHASE_PRICE' })) }
}
export function purchaseApprovalPayload(form) {
  return { invoiceType: form.invoiceType, paymentMethod: form.paymentMethod,
    items: form.items.map(item => ({ itemId: item.itemId, grossProfitCostMode: item.grossProfitCostMode })) }
}
