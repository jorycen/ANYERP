const DRAFT_PREFIX = 'anyerp:draft'

const readUserScope = () => {
  try {
    const raw = localStorage.getItem('userInfo')
    const user = raw ? JSON.parse(raw) : {}
    return user.userId || user.user_id || user.staffId || user.staff_id || user.phone || user.username || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

const storageKey = (key) => `${DRAFT_PREFIX}:${readUserScope()}:${key}`

export const cloneDraft = (value) => JSON.parse(JSON.stringify(value))

export const saveDraft = (key, data) => {
  localStorage.setItem(storageKey(key), JSON.stringify({
    updatedAt: Date.now(),
    data: cloneDraft(data)
  }))
}

export const loadDraft = (key) => {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return null
    return JSON.parse(raw)?.data || null
  } catch {
    return null
  }
}

export const clearDraft = (key) => {
  localStorage.removeItem(storageKey(key))
}

export const replaceReactive = (target, data = {}) => {
  Object.keys(target).forEach(key => {
    delete target[key]
  })
  Object.assign(target, cloneDraft(data))
}
