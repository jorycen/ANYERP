// Consumer records live in the ERP database. Importing this module never runs DDL.
const { DataTypes: D } = require('sequelize');
const { sequelize } = require('../../config/database');
const crypto = require('crypto');
const id = () => crypto.randomBytes(16).toString('hex');
function define(name, columns, indexes = []) {
  return sequelize.define(name, {
    id: { type: D.STRING(32), primaryKey: true, defaultValue: id },
    ...columns,
    created_at: { type: D.DATE, allowNull: false, defaultValue: D.NOW }
  }, { tableName: name, timestamps: false, engine: 'InnoDB', charset: 'utf8mb4',
    indexes: indexes.map((index, n) => ({ ...index, name: `${name.toLowerCase()}_idx_${n}` })) });
}
const ref = () => ({ type: D.STRING(32), allowNull: false });
const text = (n = 255) => ({ type: D.STRING(n) });
// DECIMAL(scale=0) keeps large integer balances as strings in mysql2.
const integer = (value = '0') => ({ type: D.DECIMAL(30, 0), allowNull: false, defaultValue: value });
const unique = (...fields) => ({ unique: true, fields });
const Member = define('T_CUSTOMER_MEMBER', {
  phone: text(32), phone_verified_at: D.DATE, source_store_id: text(32),
  status: { type: D.STRING(16), defaultValue: 'active', allowNull: false }
});
const Identity = define('T_MEMBER_WECHAT_IDENTITY', {
  member_id: ref(), appid: { type: D.STRING(64), allowNull: false },
  // Binary bytes prevent a case-insensitive MySQL collation merging identities.
  identity_hash: { type: D.STRING(64), allowNull: false }, openid: text(128), unionid: text(128)
}, [unique('identity_hash')]);
const Account = define('T_MEMBER_POINT_ACCOUNT', {
  member_id: ref(), distributor_id: ref(), balance: integer(), earned: integer(), reversed: integer(), spent: integer()
}, [unique('member_id', 'distributor_id')]);
const Ledger = define('T_MEMBER_POINT_LEDGER', {
  account_id: ref(), member_id: ref(), distributor_id: ref(), store_id: text(32),
  delta: integer(), before: integer(), after: integer(), type: { type: D.STRING(32), allowNull: false },
  business_key: { type: D.STRING(160), allowNull: false }, order_id: text(32), return_id: text(32),
  exchange_id: text(32), actor: text(64), reason: text(512), snapshot: D.JSON
}, [unique('business_key'), { fields: ['account_id', 'created_at', 'id'] }]);
const Rule = define('T_POINT_RULE', {
  distributor_id: ref(), numerator: integer('1'), denominator: integer('100'),
  effective_at: { type: D.DATE, allowNull: false }, actor: text(64),
  basis: { type: D.STRING(32), allowNull: false, defaultValue: 'customer_net' },
  // Published versions are immutable; explicit product IDs avoid guessed category eligibility.
  product_ids: { type: D.JSON, allowNull: false }
}, [unique('distributor_id', 'effective_at')]);
const Reward = define('T_REWARD_ITEM', {
  distributor_id: ref(), name: { type: D.STRING(128), allowNull: false }, image: text(1024),
  kind: { type: D.STRING(16), allowNull: false }, points: integer(), stock: { type: D.INTEGER, allowNull: true },
  per_member_limit: { type: D.INTEGER, allowNull: true }, valid_days: { type: D.INTEGER, allowNull: false },
  instructions: D.TEXT, revision: { type: D.INTEGER, allowNull: false, defaultValue: 0 },
  on_sale: { type: D.BOOLEAN, defaultValue: false, allowNull: false }
});
const RewardStore = define('T_REWARD_ITEM_STORE', { reward_id: ref(), store_id: ref() }, [unique('reward_id', 'store_id')]);
const Exchange = define('T_REWARD_EXCHANGE', {
  member_id: ref(), account_id: ref(), distributor_id: ref(), reward_id: ref(), points: integer(),
  request_key: { type: D.STRING(80), allowNull: false },
  status: { type: D.STRING(16), defaultValue: 'pending', allowNull: false },
  expires_at: { type: D.DATE, allowNull: false }, snapshot: { type: D.JSON, allowNull: false },
  code_hash: { type: D.STRING(64), allowNull: false }
}, [unique('member_id', 'request_key'), unique('code_hash'), { fields: ['member_id', 'created_at'] }]);
const Redemption = define('T_REWARD_REDEMPTION', {
  exchange_id: ref(), member_id: ref(), distributor_id: ref(), store_id: ref(),
  staff_id: { type: D.BIGINT, allowNull: false }
}, [unique('exchange_id')]);
const Claim = define('T_ORDER_MEMBER_CLAIM', {
  order_id: ref(), store_id: ref(), distributor_id: ref(),
  token_hash: { type: D.STRING(64), allowNull: false }, nonce: { type: D.STRING(32), allowNull: false },
  expires_at: { type: D.DATE, allowNull: false }, snapshot: { type: D.JSON, allowNull: false },
  approved_member_id: text(32), approved_staff_id: D.BIGINT, approved_reason: text(512)
}, [unique('order_id'), unique('token_hash')]);
const Binding = define('T_ORDER_MEMBER_BINDING', {
  order_id: ref(), member_id: ref(), account_id: ref(), awarded: integer(), reversed: integer(),
  snapshot: { type: D.JSON, allowNull: false }
}, [unique('order_id')]);
module.exports = { Member, Identity, Account, Ledger, Rule, Reward, RewardStore, Exchange, Redemption, Claim, Binding };
