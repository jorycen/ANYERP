// Opt-in isolated schema. Never copies or modifies production rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const run = process.env.RUN_CUSTOMER_DB_TESTS === 'true';
test('customer operations on isolated MySQL: races, ownership, returns, rollback', { skip: !run }, async () => {
  const config = require('../src/config');
  const mysql = require('mysql2/promise');
  const source = config.database.database;
  if (!/^[a-zA-Z0-9_-]+$/.test(source)) throw new Error('Unexpected database identifier');
  const name = `customer_ops_test_${Date.now()}_${process.pid}`;
  const connectionOptions = { host: config.database.host, port: config.database.port,
    user: config.database.username, password: config.database.password, connectTimeout: 20000, enableKeepAlive: true };
  const control = await mysql.createConnection(connectionOptions);
  let sequelize, server, failure;
  try {
    await control.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    for (const table of ['T_ORDER', 'T_ORDER_ITEM', 'T_STORE', 'T_STAFF', 'T_DISTRIBUTOR', 'T_SALES_RETURN_REQUEST', 'T_SALES_RETURN_REQUEST_ITEM']) {
      await control.query(`CREATE TABLE \`${name}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
    }
    config.database.database = name;
    process.env.CUSTOMER_OPS_ENABLED = 'true';
    process.env.CUSTOMER_TOKEN_SECRET = require('crypto').randomBytes(32).toString('hex');
    sequelize = require('../src/config/database').sequelize;
    const M = require('../src/modules/customerOps/models');
    const V = require('../src/modules/customerOps/service');
    const S = require('../src/modules/customerOps/security');
    const Core = require('../src/models');
    for (const model of Object.values(M)) await model.sync();
    await Core.Store.create({ store_id: 'test_store', distributor_id: 'test_dist', name: 'test', status: 1 });
    const member = await M.Member.create({ phone: '13000000000', phone_verified_at: new Date() });
    const other = await M.Member.create({ phone: '13000000000', phone_verified_at: new Date() });
    const order = await Core.Order.create({ order_id: 'test_order', order_no: 'test_order', store_id: 'test_store',
      customer_phone: member.phone, order_status: '已归档' });
    const item = await Core.OrderItem.create({ order_id: order.order_id, product_id: null, sale_price: '100', subtotal: '100', quantity: 1 });
    const snapshot = { numerator: '1', denominator: '100', lines: [{ item_id: String(item.item_id), quantity: 1, amount: '10000' }] };
    const nonce = '01234567890123456789012345678901';
    const token = S.token('claim', nonce);
    await M.Claim.create({ order_id: order.order_id, store_id: 'test_store', distributor_id: 'test_dist', nonce,
      token_hash: S.hash(token), expires_at: new Date(Date.now() + 60000), snapshot });
    const claims = await Promise.allSettled([V.bind(member, { token }), V.bind(other, { token })]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    const binding = await M.Binding.findOne();
    const owner = binding.member_id === member.id ? member : other;
    const stranger = owner.id === member.id ? other : member;
    await V.bind(owner, { token });
    assert.equal(await M.Ledger.count(), 1);
    const reward = await M.Reward.create({ distributor_id: 'test_dist', name: 'clean', kind: 'service', points: '80', stock: 1, valid_days: 30, on_sale: true });
    await M.RewardStore.create({ reward_id: reward.id, store_id: 'test_store' });
    await assert.rejects(V.exchange(owner, reward.id, 'stale_quote_key01', '79'), /积分价格已更新/);
    assert.equal(await M.Exchange.count(), 0);
    const attempts = await Promise.allSettled([V.exchange(owner, reward.id, 'exchange_key_0001'), V.exchange(owner, reward.id, 'exchange_key_0002')]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    const exchanged = await M.Exchange.findOne();
    const Koa = require('koa');
    const app = new Koa();
    app.use(async (ctx, next) => { try { await next(); } catch (e) { ctx.status = e.status || 500; ctx.body = { message: e.message }; } });
    app.use(require('koa-bodyparser')());
    const customer = require('../src/modules/customerOps/routes').customer;
    app.use(customer.routes());
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer`;
    const get = (path, token) => fetch(url + path, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await get('/member/profile', 'invalid')).status, 401);
    const employeeToken = require('jsonwebtoken').sign({ staffId: 1 }, process.env.CUSTOMER_TOKEN_SECRET);
    assert.equal((await get('/member/profile', employeeToken)).status, 401);
    assert.equal((await get(`/exchange/${exchanged.id}`, S.sign(stranger))).status, 404);
    assert.equal((await get(`/exchange/${exchanged.id}`, S.sign(owner))).status, 200);
    const credential = await get(`/exchange/${exchanged.id}/credential`, S.sign(owner));
    assert.equal(credential.status, 200);
    const qr = await credential.json();
    assert.ok(qr.image.startsWith('data:image/png;base64,'));
    assert.equal((await M.Account.findByPk(binding.account_id)).balance, '20');
    assert.equal((await M.Reward.findByPk(reward.id)).stock, 0);
    assert.equal((await V.exchange(owner, reward.id, exchanged.request_key)).id, exchanged.id);
    const employee = { staffId: 1, roles: ['staff'], accessibleDistributorIds: ['test_dist'], accessibleStoreIds: ['test_store'] };
    const code = S.token('redeem', exchanged.id);
    await assert.rejects(V.redeem(code, 'test_store', { ...employee, accessibleStoreIds: [] }, true));
    await Promise.all([V.redeem(code, 'test_store', employee, true), V.redeem(code, 'test_store', employee, true)]);
    assert.equal(await M.Redemption.count(), 1);
    const returned = await Core.SalesReturnRequest.create({ return_id: 'test_return', return_no: 'test_return', order_id: order.order_id,
      order_no: order.order_no, store_id: order.store_id, status: 'completed' });
    await Core.SalesReturnRequestItem.create({ return_id: returned.return_id, order_item_id: item.item_id, quantity: 1, unit_price: '100', subtotal: '100' });
    await V.transaction(t => V.reverseReturn(order, returned, t));
    await V.transaction(t => V.reverseReturn(order, returned, t));
    assert.equal((await M.Account.findByPk(binding.account_id)).balance, '-80');
    const pending = await M.Exchange.create({ member_id: owner.id, account_id: binding.account_id, distributor_id: 'test_dist', reward_id: reward.id,
      points: '1', request_key: 'pending_negative_test', code_hash: S.hash('negative-code'), expires_at: new Date(Date.now() + 60000), snapshot: { name: 'pending', storeIds: ['test_store'] } });
    await assert.rejects(V.redeem('negative-code', 'test_store', employee, true, pending.id), /待抵扣积分/);
    const expired = await M.Exchange.create({ member_id: owner.id, account_id: binding.account_id, distributor_id: 'test_dist', reward_id: reward.id,
      points: '1', request_key: 'expired_test_key1', code_hash: S.hash('expired-code'), expires_at: new Date(Date.now() - 1000), snapshot: { name: 'expired', storeIds: ['test_store'] } });
    await assert.rejects(V.redeem('expired-code', 'test_store', employee, true, expired.id), /已失效/);
    assert.equal(await M.Ledger.count({ where: { type: 'return' } }), 1);
    const ledger = await M.Ledger.findAll();
    assert.equal(ledger.reduce((sum, r) => sum + BigInt(r.delta), 0n), -80n);
    await assert.rejects(V.transaction(async t => {
      const acc = await M.Account.findByPk(binding.account_id, V.lock(t));
      await V.post(acc, 100n, { type: 'adjustment', business_key: 'rollback-test' }, t);
      throw new Error('injected rollback');
    }));
    assert.equal(await M.Ledger.count({ where: { business_key: 'rollback-test' } }), 0);
    assert.equal((await M.Account.findByPk(binding.account_id)).balance, '-80');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (sequelize) await sequelize.close();
    // Name was generated here, never supplied by input or sourced from DB_NAME.
    if (!/^customer_ops_test_\d+_\d+$/.test(name)) throw new Error('Unsafe cleanup target');
    try {
      const cleanup = await mysql.createConnection(connectionOptions);
      try { await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``); } finally { await cleanup.end(); }
    } catch (error) {
      if (!failure) throw error;
      console.error('Isolated schema cleanup requires retry:', name, error.code);
    }
    control.destroy();
  }
});
