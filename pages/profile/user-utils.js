// 用户信息管理工具
// pages/profile/user-utils.js

/**
 * 用户角色枚举
 */
const USER_ROLES = {
  DISTRIBUTOR: 'distributor', // 经销商（最大权限）
  STORE_ADMIN: 'store_admin',  // 门店管理员/店长
  STAFF: 'staff'               // 普通员工/店员
};

/**
 * 用户信息存储键
 */
const USER_INFO_KEY = 'userInfo';
const PURCHASE_QUERY_ONLY_ACCOUNT = '13800138001';

/**
 * 获取当前用户信息
 * @returns {Object} 用户信息对象
 */
function getUserInfo() {
  const storedUserInfo = wx.getStorageSync(USER_INFO_KEY);
  
  // 默认用户信息
  const defaultUserInfo = {
    userId: '1',
    userName: '测试用户',
    userRole: USER_ROLES.STAFF,
    phoneNumber: '',
    distributorId: '1',
    distributorName: '联想授权经销商',
    storeId: '1',
    storeName: '成都旗舰店'
  };
  
  if (!storedUserInfo) {
    return defaultUserInfo;
  }
  
  // 合并存储的用户信息和默认值，确保 phoneNumber 字段存在
  return {
    ...defaultUserInfo,
    ...storedUserInfo
  };
}

/**
 * 设置当前用户信息
 * @param {Object} userInfo 用户信息对象
 */
function setUserInfo(userInfo) {
  wx.setStorageSync(USER_INFO_KEY, userInfo);
}

function getRoleCodes(userInfo) {
  const user = userInfo || getUserInfo();
  const values = [user.userRole, user.role, user.roleCode]
    .concat(Array.isArray(user.roles) ? user.roles : []);
  return [...new Set(values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function isStoreScoped(userInfo) {
  const roles = getRoleCodes(userInfo);
  return roles.length > 0 && roles.every(role => ['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role));
}

/**
 * 检查用户是否为经销商
 * @returns {boolean} 是否为经销商
 */
function isDistributor(userInfo) {
  userInfo = userInfo || getUserInfo();
  return getRoleCodes(userInfo).some(role => !['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role));
}

/**
 * 检查用户是否为门店管理员/店长
 * @returns {boolean} 是否为门店管理员/店长
 */
function isStoreAdmin() {
  const userInfo = getUserInfo();
  return userInfo.userRole === USER_ROLES.STORE_ADMIN;
}

/**
 * 检查用户是否为普通员工
 * @returns {boolean} 是否为普通员工
 */
function isStaff() {
  const userInfo = getUserInfo();
  return userInfo.userRole === USER_ROLES.STAFF;
}

/**
 * 检查用户是否有门店管理权限
 * @returns {boolean} 是否有门店管理权限
 */
function canManageStore() {
  const userInfo = getUserInfo();
  return userInfo.userRole === USER_ROLES.DISTRIBUTOR || 
         userInfo.userRole === USER_ROLES.STORE_ADMIN;
}

/**
 * 检查用户是否已授权
 * @returns {boolean} 是否已授权
 */
function isAuthorized() {
  const userInfo = getUserInfo();
  return userInfo.userRole !== 'unauthorized';
}

/**
 * 检查用户是否可以查看其他员工的订单
 * @returns {boolean} 是否可以查看其他员工的订单
 */
function canViewOtherOrders() {
  const userInfo = getUserInfo();
  return userInfo.userRole === USER_ROLES.DISTRIBUTOR || 
         userInfo.userRole === USER_ROLES.STORE_ADMIN;
}

function isDistributorAccount(userInfo) {
  const roles = getRoleCodes(userInfo);
  return roles.length > 0 && !isStoreScoped(userInfo);
}

function isPurchaseQueryOnly(userInfo) {
  const user = userInfo || getUserInfo();
  return String(user.phoneNumber || user.phone || user.phone_number || user.mobile || '').trim() === PURCHASE_QUERY_ONLY_ACCOUNT;
}

function canUsePurchaseQueryApi(url, method) {
  const path = String(url || '').split('?')[0];
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (!isPurchaseQueryOnly()) return true;
  if (path === '/auth/login' || path === '/auth/profile' || path === '/auth/userinfo' || path === '/auth/logout') return true;
  if (path === '/purchase/request-list' && normalizedMethod === 'GET') return true;
  if (/^\/purchase\/request-detail\//.test(path) && normalizedMethod === 'GET') return true;
  return false;
}

module.exports = {
  USER_ROLES,
  getUserInfo,
  setUserInfo,
  isDistributor,
  isStoreAdmin,
  isStaff,
  canManageStore,
  canViewOtherOrders,
  getRoleCodes,
  isStoreScoped,
  isDistributorAccount,
  isAuthorized,
  isPurchaseQueryOnly,
  canUsePurchaseQueryApi
};
