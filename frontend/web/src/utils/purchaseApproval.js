export function purchaseApprovalForm(data = {}) {
  return { supplierName: data.supplier_name || data.Supplier?.name || '', storeName: data.store_name || data.Store?.name || '',
    purchaseAmount: Number(data.total_amount ?? data.totalAmount ?? 0).toFixed(2),
    freightAmount: Number(data.freight_amount ?? data.freightAmount ?? 0).toFixed(2),
    freightPlatformName: data.freight_platform_name || data.freightPlatformName || '-',
    productType: data.product_type || data.productType || [...new Set((data.items || []).map(item => item.product_type || item.productType).filter(Boolean))].join('、') || '-',
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
