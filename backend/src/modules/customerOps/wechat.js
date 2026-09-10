const S = require('./security');
let cached;
function config() {
  const appid = process.env.CUSTOMER_WECHAT_APPID, secret = process.env.CUSTOMER_WECHAT_SECRET;
  if (!appid || !secret) S.fail(503, '消费者微信账号尚未配置');
  return { appid, secret };
}
async function request(path, body) {
  const response = await fetch(`https://api.weixin.qq.com${path}`, {
    method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) S.fail(502, '微信服务暂不可用');
  if (response.headers.get('content-type')?.startsWith('image/')) return Buffer.from(await response.arrayBuffer());
  const data = await response.json();
  if (data.errcode) S.fail(502, '微信校验失败，请重新操作');
  return data;
}
async function access() {
  if (cached && cached.until > Date.now()) return cached.token;
  const { appid, secret } = config();
  const data = await request(`/cgi-bin/token?${new URLSearchParams({ grant_type: 'client_credential', appid, secret })}`);
  if (!data.access_token) S.fail(502, '微信服务响应异常');
  cached = { token: data.access_token, until: Date.now() + Math.max(60, Number(data.expires_in) - 300) * 1000 };
  return cached.token;
}
async function login(code) {
  if (typeof code !== 'string' || code.length > 256 || !code) S.fail(400, '登录凭证无效');
  const { appid, secret } = config();
  const data = await request(`/sns/jscode2session?${new URLSearchParams({ appid, secret, js_code: code, grant_type: 'authorization_code' })}`);
  if (!data.openid) S.fail(401, '微信登录失败');
  return { appid, openid: data.openid, unionid: data.unionid || null };
}
async function phone(code) {
  if (typeof code !== 'string' || !code || code.length > 256) S.fail(400, '手机号授权凭证无效');
  const data = await request(`/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(await access())}`, { code });
  if (!data.phone_info?.purePhoneNumber) S.fail(502, '手机号校验失败');
  return data.phone_info.purePhoneNumber;
}
async function claimImage(scene) {
  return request(`/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(await access())}`, {
    scene, page: 'pages/points/index', check_path: true, env_version: 'release', width: 280
  });
}
module.exports = { login, phone, claimImage };
