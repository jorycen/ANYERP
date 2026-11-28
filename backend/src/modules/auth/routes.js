/**
 * 认证模块路由
 */
const Router = require('koa-router');
const { login, getUserInfo, changePassword } = require('./controller');
const { authMiddleware } = require('../../middleware/auth');

const router = new Router();

// 登录
router.post('/login', login);

// 获取用户信息
router.get('/userinfo', authMiddleware, getUserInfo);

// 修改密码
router.post('/changePassword', authMiddleware, changePassword);
router.post('/changepassword', authMiddleware, changePassword);

module.exports = router;
