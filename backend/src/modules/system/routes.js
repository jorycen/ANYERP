/**
 * 系统管理路由
 */
const Router = require('koa-router');
const {
  getMenus, getRoles, createRole, updateRole, deleteRole, getRoleMenus, assignMenus,
  getUsers, createUser, updateUser, resetUserPassword, getUserRegions, assignUserRegions,
  getLocations, createLocation, updateLocation, deleteLocation
} = require('./controller');
const { requireRole } = require('../../middleware/permission');

const router = new Router();

router.get('/menus', getMenus);
router.get('/roles', getRoles);
router.post('/role', requireRole('admin', 'boss'), createRole);
router.put('/role/:roleId', requireRole('admin', 'boss'), updateRole);
router.delete('/role/:roleId', requireRole('admin', 'boss'), deleteRole);
router.get('/role-menus/:roleId', getRoleMenus);
router.post('/role-menus/:roleId', requireRole('admin', 'boss'), assignMenus);
router.get('/users', requireRole('admin', 'boss'), getUsers);
router.post('/user', requireRole('admin', 'boss'), createUser);
router.put('/user/:staffId', requireRole('admin', 'boss'), updateUser);
router.post('/user/:staffId/reset-password', requireRole('admin', 'boss'), resetUserPassword);
router.get('/user-regions/:staffId', requireRole('admin', 'boss'), getUserRegions);
router.post('/assign-user-regions/:staffId', requireRole('admin', 'boss'), assignUserRegions);
router.get('/locations', requireRole('admin', 'boss'), getLocations);
router.post('/locations', requireRole('admin', 'boss'), createLocation);
router.put('/locations/:locationId', requireRole('admin', 'boss'), updateLocation);
router.delete('/locations/:locationId', requireRole('admin', 'boss'), deleteLocation);

module.exports = router;
