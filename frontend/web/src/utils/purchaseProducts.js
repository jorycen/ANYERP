// Keep complete records for selected items when remote search replaces its options.
export function mergePurchaseProductOptions(current, incoming, selectedIds) {
  const selected = new Set(selectedIds.filter(Boolean).map(String))
  const byId = new Map()
  for (const product of current) {
    if (selected.has(String(product.product_id))) byId.set(String(product.product_id), product)
  }
  for (const product of incoming) byId.set(String(product.product_id), product)
  return [...byId.values()]
}
