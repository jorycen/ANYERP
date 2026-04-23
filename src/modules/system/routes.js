/**
 * 系统管理路由
 */
const Router = require('koa-router');
const { getMenus, getRoles, getRoleMenus, assignMenus, getUsers, updateUserRoles, getUserRegions, assignUserRegions } = require('./controller');

const router = new Router();

// 菜单管理
router.get('/menus', getMenus);

// 角色管理
router.get('/roles', getRoles);
router.get('/roles/:roleId/menus', getRoleMenus);
router.post('/roles/:roleId/menus', assignMenus);

// 用户管理
router.get('/users', getUsers);
router.post('/users/:staffId/roles', updateUserRoles);
router.get('/users/:staffId/regions', getUserRegions);
router.post('/users/:staffId/regions', assignUserRegions);

module.exports = router;
