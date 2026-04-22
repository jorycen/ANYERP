/**
 * 认证模块路由
 */
const Router = require('koa-router');
const { login, getUserInfo, changePassword } = require('./controller');

const router = new Router();

// 登录
router.post('/login', login);

// 获取用户信息
router.get('/userinfo', getUserInfo);

// 修改密码
router.post('/changePassword', changePassword);

module.exports = router;
