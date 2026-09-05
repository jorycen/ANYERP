export function getUserInfo() {
  try {
    return JSON.parse(localStorage.getItem('userInfo') || '{}')
  } catch {
    return {}
  }
}

export function getRoleCode() {
  return String(getUserInfo().roleCode || '').trim().toLowerCase()
}

export function getRoleCodes() {
  const user = getUserInfo()
  const rawRoles = Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : String(user.roleCode || '').split(',')
  return rawRoles
    .map(role => String(role || '').trim().toLowerCase())
    .filter(Boolean)
}

export function isSalesQueryOnly(user = getUserInfo()) {
  const roles = Array.isArray(user.roles) && user.roles.length ? user.roles : String(user.roleCode || '').split(',')
  return roles.some(role => String(role).trim().toLowerCase() === 'mall_report_viewer')
}

export function getStoreId() {
  const roles = getRoleCodes()
  const storeOnlyRoles = new Set(['clerk', 'staff', 'manager', 'store_manager', 'store_admin'])
  return roles.length > 0 && roles.every(role => storeOnlyRoles.has(role))
    ? (getUserInfo().storeId || '')
    : ''
}

export function getStoreName() {
  return getStoreId() ? (getUserInfo().storeName || '') : ''
}

export function isStoreUser() {
  const roles = getRoleCodes()
  return roles.length > 0 && roles.every(role => ['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role))
}

export function isDistributorAccount() {
  const storeOnlyRoles = new Set(['clerk', 'staff', 'manager', 'store_manager', 'store_admin'])
  return getRoleCodes().some(role => !storeOnlyRoles.has(role))
}

export function hasRole(roles) {
  const currentRoles = getRoleCodes()
  return currentRoles.includes('boss') || currentRoles.includes('admin') || currentRoles.some(role => roles.includes(role))
}
