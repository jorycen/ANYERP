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

export function getStoreId() {
  return getUserInfo().storeId || ''
}

export function getStoreName() {
  return getUserInfo().storeName || ''
}

export function isStoreUser() {
  const rc = getRoleCode()
  return rc === 'clerk' || rc === 'manager'
}

export function hasRole(roles) {
  const rc = getRoleCode()
  return rc === 'boss' || rc === 'admin' || roles.includes(rc)
}
