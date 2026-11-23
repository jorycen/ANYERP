export function createSalesRequestId() {
  const random = globalThis.crypto
  if (typeof random?.randomUUID === 'function') return random.randomUUID()
  if (typeof random?.getRandomValues === 'function') {
    const bytes = random.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return `sales_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
}
