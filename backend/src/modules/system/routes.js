/**
 * 系统管理路由
 */
const Router = require('koa-router');
const { getMenus, getRoles, getRoleMenus, assignMenus, getUsers, createUser, updateUser, getUserRegions, assignUserRegions } = require('./controller');

const router = new Router();

router.get('/menus', getMenus);
router.get('/roles', getRoles);
router.get('/role-menus/:roleId', getRoleMenus);
router.post('/role-menus/:roleId', assignMenus);
router.get('/users', getUsers);
router.post('/user', createUser);
router.put('/user/:staffId', updateUser);
router.get('/user-regions/:staffId', getUserRegions);
router.post('/assign-user-regions/:staffId', assignUserRegions);

module.exports = router;