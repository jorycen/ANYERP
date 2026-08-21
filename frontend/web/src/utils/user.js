export function getUserInfo() {
  try {
    return JSON.parse(localStorage.getItem('userInfo') || '{}')
  } catch {
    return {}
  }
}

export function getRoleCode() {
  return getUserInfo().roleCode || ''
}

export function getRoleCodes() {
  const user = getUserInfo()
  if (Array.isArray(user.roles) && user.roles.length > 0) return user.roles
  return String(user.roleCode || '').split(',').map(role => role.trim()).filter(Boolean)
}

export function getStoreId() {
  const roles = getRoleCodes()
  const storeOnlyRoles = new Set(['clerk', 'staff', 'manager', 'store_manager'])
  return roles.length > 0 && roles.every(role => storeOnlyRoles.has(role))
    ? (getUserInfo().storeId || '')
    : ''
}

export function getStoreName() {
  return getStoreId() ? (getUserInfo().storeName || '') : ''
}

export function isStoreUser() {
  const roles = getRoleCodes()
  return roles.length > 0 && roles.every(role => ['clerk', 'staff', 'manager', 'store_manager'].includes(role))
}

export function isDistributorAccount() {
  const storeOnlyRoles = new Set(['clerk', 'staff', 'manager', 'store_manager'])
  return getRoleCodes().some(role => !storeOnlyRoles.has(role))
}

export function hasRole(roles) {
  const currentRoles = getRoleCodes()
  return currentRoles.includes('boss') || currentRoles.includes('admin') || currentRoles.some(role => roles.includes(role))
}
