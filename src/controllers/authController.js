const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');

/**
 * 员工登录
 */
exports.login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return ApiResponse.error('Username and password are required').send(res, 400);
  }

  try {
    // 1. 查询用户
    const [users] = await db.execute(
      'SELECT USER_ID, USERNAME, NICKNAME, PASSWORD_HASH, ROLE, STORE_ID FROM T_USER WHERE USERNAME = ? AND DELETE_FLAG = b\'0\'',
      [username]
    );

    if (users.length === 0) {
      return ApiResponse.error('Invalid username or password').send(res, 401);
    }

    const user = users[0];

    // 2. 校验密码
    const isMatch = await bcrypt.compare(password, user.PASSWORD_HASH);
    if (!isMatch) {
      return ApiResponse.error('Invalid username or password').send(res, 401);
    }

    // 3. 生成 JWT Token
    const token = jwt.sign(
      { userId: user.USER_ID, username: user.USERNAME, role: user.ROLE, storeId: user.STORE_ID },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // 4. 更新登录时间 (可选)
    await db.execute('UPDATE T_USER SET LAST_LOGIN_TIME = CURRENT_TIMESTAMP WHERE USER_ID = ?', [user.USER_ID]);

    // 5. 返回结果 (不包含哈希)
    const userData = {
      userId: user.USER_ID,
      username: user.USERNAME,
      nickname: user.NICKNAME,
      role: user.ROLE,
      storeId: user.STORE_ID
    };

    return ApiResponse.success({ token, user: userData }, 'Login successful').send(res);
  } catch (error) {
    console.error('Login Error:', error);
    return ApiResponse.error('Internal server error during login', error.message).send(res, 500);
  }
};

/**
 * 获取个人信息
 */
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const [users] = await db.execute(
      'SELECT USER_ID, USERNAME, NICKNAME, ROLE, STORE_ID FROM T_USER WHERE USER_ID = ?',
      [userId]
    );

    if (users.length === 0) {
      return ApiResponse.error('User not found').send(res, 404);
    }

    return ApiResponse.success(users[0], 'Profile fetched successfully').send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching profile', error.message).send(res, 500);
  }
};
