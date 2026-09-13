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
    await Core.Distributor.create({distributor_id:'test_dist',name:'test distributor',status:1,is_deleted:0});
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
    app.use(require('../src/middleware/responseFormatter').responseFormatter);
    const customer = require('../src/modules/customerOps/routes').customer;
    app.use(customer.routes());
    const staffRouter = new (require('koa-router'))();
    app.use(async (ctx,next)=>{if(ctx.path.startsWith('/test-staff'))ctx.state.user={staffId:1,roles:['boss'],accessibleDistributorIds:['test_dist'],accessibleStoreIds:['test_store']};await next();});
    staffRouter.use('/test-staff',require('../src/modules/customerOps/routes').staff.routes());
    app.use(staffRouter.routes());
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
    assert.equal(qr.code, 0);
    assert.equal(qr.data.code, S.token('redeem', exchanged.id));
    assert.ok(qr.data.image.startsWith('data:image/png;base64,'));
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

    // Fixed official-account entry: no claim token, no final archive required.
    await M.Rule.create({ id: 'batch_rule', distributor_id: 'test_dist', numerator: '1', denominator: '100', product_ids: [], effective_at: new Date(Date.now() - 60000) });
    const batchMember = await M.Member.create({});
    const batchOther = await M.Member.create({});
    const phone = '13100000000';
    const makeOrder = async (id, status, phoneValue = phone) => {
      const row = await Core.Order.create({ order_id: id, order_no: id, store_id: 'test_store',
        customer_phone: phoneValue, order_status: status, submit_time: status === 'draft' ? null : new Date() });
      await Core.OrderItem.create({ order_id: id, sale_price: '20', subtotal: '20', quantity: 1 });
      return row;
    };
    const first = await makeOrder('batch_a', '未归档');
    await makeOrder('batch_b', '已归档');
    await makeOrder('batch_c', 'draft');
    await makeOrder('batch_d', 'return_pending');
    await makeOrder('batch_e', '已作废');
    await makeOrder('batch_f', '未归档', '13200000000');
    const races = await Promise.all([V.claimByPhone(batchMember, { phone }), V.claimByPhone(batchOther, { phone })]);
    assert.equal(races.reduce((n, r) => n + r.claimedCount, 0), 2);
    assert.equal(await M.Binding.count({ where: { order_id: ['batch_a', 'batch_b'] } }), 2);
    assert.equal(await M.Claim.count({ where: { order_id: ['batch_a', 'batch_b'] } }), 0);
    assert.equal((await V.claimByPhone(batchMember, { phone })).claimedCount, 0);
    assert.equal((await V.claimByPhone(batchMember, { phone: '13999999999' })).results.length, 0);
    await assert.rejects(V.claimByPhone(batchMember, { phone: 'bad' }), /手机号/);
    const firstBinding = await M.Binding.findOne({ where: { order_id: first.order_id } });
    const firstAccount = await M.Account.findByPk(firstBinding.account_id);
    const initialBalance = BigInt(firstAccount.balance);
    const firstItem = await Core.OrderItem.findOne({ where: { order_id: first.order_id } });
    await V.transaction(async t => {
      const locked = await Core.Order.findByPk(first.order_id, V.lock(t));
      await firstItem.update({ sale_price: '10', subtotal: '10' }, { transaction: t });
      await V.reconcileOrder(locked, t);
    });
    assert.equal(BigInt((await firstAccount.reload()).balance), initialBalance - 10n);
    await V.transaction(t => V.reconcileOrder(first, t));
    assert.equal(await M.Ledger.count({ where: { order_id: first.order_id, type: 'order_adjust' } }), 1);
    await V.transaction(async t => {
      const locked = await Core.Order.findByPk(first.order_id, V.lock(t));
      await locked.update({ order_status: '已作废' }, { transaction: t });
      await V.reconcileOrder(locked, t);
    });
    assert.equal(BigInt((await firstAccount.reload()).balance), initialBalance - 20n);
    assert.equal((await M.Binding.findByPk(firstBinding.id)).awarded, '0');

    const second = await Core.Order.findByPk('batch_b');
    const secondBinding = await M.Binding.findOne({ where: { order_id: second.order_id } });
    const secondItem = await Core.OrderItem.findOne({ where: { order_id: second.order_id } });
    const batchReturn = await Core.SalesReturnRequest.create({ return_id: 'batch_return', return_no: 'batch_return', order_id: second.order_id,
      order_no: second.order_no, store_id: second.store_id, status: 'completed' });
    await Core.SalesReturnRequestItem.create({ return_id: batchReturn.return_id, order_item_id: secondItem.item_id, quantity: 1, unit_price: '20', subtotal: '20' });
    await V.transaction(t => V.reverseReturn(second, batchReturn, t));
    await V.transaction(t => V.reverseReturn(second, batchReturn, t));
    assert.equal((await secondBinding.reload()).reversed, '20');
    const postBatch = (token, body) => fetch(url + '/member/claim-orders', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await postBatch(employeeToken, { phone })).status, 401);
    assert.equal((await postBatch(S.sign(batchMember), { phone: 'invalid' })).status, 400);
    assert.equal((await postBatch(S.sign(batchMember), { phone })).status, 200);
    // Keyset pagination includes every order beyond the first batch.
    for (let i = 0; i < 51; i++) await makeOrder('page_' + String(i).padStart(2, '0'), '未归档', '13300000000');
    const page1 = await V.claimByPhone(batchMember, { phone: '13300000000' });
    assert.equal(page1.claimedCount, 50);
    assert.ok(page1.next);
    const page2 = await V.claimByPhone(batchMember, { phone: '13300000000', after: page1.next });
    assert.equal(page2.claimedCount, 1);
    assert.equal(page2.next, null);
    // Member center: persisted cash/coupon snapshots, fail-closed legacy redemption,
    // price changes, catalog ordering, coupon ownership and expiration filters.
    const centerMember = await M.Member.create({phone:'13800000000'});
    await V.transaction(async t => {
      const acc = await V.account(centerMember.id,'test_dist',t);
      await V.post(acc,2000n,{type:'activity',business_key:'center-activity',reason:'到店活动'},t);
    });
    const createReward = async extra => {
      const reward = await M.Reward.create({distributor_id:'test_dist',name:'member center reward',kind:'service',points:'300',stock:5,valid_days:30,on_sale:true,...extra});
      await M.RewardStore.create({reward_id:reward.id,store_id:'test_store'});return reward;
    };
    const mixed = await createReward({name:'mouse',kind:'gift',points:'800',cash_required:'39.00',per_member_limit:1});
    await assert.rejects(V.exchange(centerMember,mixed.id,'mixed_missing_cash','800'),/现金价格/);
    await assert.rejects(V.exchange(centerMember,mixed.id,'mixed_stale_cash','800','38'),/现金价格/);
    assert.equal(await M.Exchange.count({where:{member_id:centerMember.id}}),0);
    const mixedExchange = await V.exchange(centerMember,mixed.id,'mixed_exchange_key','800','39');
    assert.equal(mixedExchange.snapshot.cash_required,'39.00');
    const replay=await Promise.all([V.exchange(centerMember,mixed.id,'mixed_exchange_key','800','39'),V.exchange(centerMember,mixed.id,'mixed_exchange_key','800','39')]);
    assert.equal(replay[0].id,replay[1].id);
    await assert.rejects(V.exchange(centerMember,mixed.id,'mixed_limit_key_01','800','39'),/兑换数量/);
    const mixedCode=S.token('redeem',mixedExchange.id);
    await assert.rejects(V.redeem(mixedCode,'test_store',employee,true,mixedExchange.id),/现金补差/);
    await assert.rejects(V.redeem(mixedCode,'test_store',employee,true,mixedExchange.id,{cash_confirmed:true,cash_received:'38',receipt_reference:'receipt'}),/现金补差/);
    await mixed.update({cash_required:'99.00'});
    const received=await V.redeem(mixedCode,'test_store',employee,true,mixedExchange.id,{cash_confirmed:true,cash_received:'39',receipt_reference:'receipt-001'});
    assert.equal(String(received.redemption.cash_received),'39.00');
    const coupon=await createReward({name:'配件券',kind:'coupon',points:'500',coupon_value:'50',coupon_min_spend:'299',coupon_scope:'指定配件'});
    const couponExchange=await V.exchange(centerMember,coupon.id,'coupon_exchange_01','500','0');
    const couponCode=S.token('redeem',couponExchange.id);
    await assert.rejects(V.redeem(couponCode,'test_store',employee,true,couponExchange.id),/使用范围/);
    await assert.rejects(V.redeem(couponCode,'test_store',employee,true,couponExchange.id,{scope_confirmed:true,eligible_amount:'298',receipt_reference:'sale-001'}),/门槛/);
    let response=await get('/member/coupons?status=pending',S.sign(centerMember));
    assert.equal(response.status,200);let body=await response.json();assert.equal(body.data.total,1);
    assert.equal(body.data.list[0].snapshot.coupon_scope,'指定配件');
    assert.equal((await (await get('/member/coupons',S.sign(stranger))).json()).data.total,0);
    await V.redeem(couponCode,'test_store',employee,true,couponExchange.id,{scope_confirmed:true,eligible_amount:'299',receipt_reference:'sale-001'});
    assert.equal((await (await get('/member/coupons?status=redeemed',S.sign(centerMember))).json()).data.total,1);
    await createReward({name:'near target',points:'851'});
    const listResponse=await get('/rewards?distributor_id=test_dist&type=service',S.sign(centerMember));
    assert.equal(listResponse.status,200);body=await listResponse.json();
    const near=body.data.list.find(r=>r.name==='near target');assert.equal(near.points_shortfall,'151');
    const future=await createReward({valid_start_time:new Date(Date.now()+86400000)});
    await assert.rejects(V.exchange(centerMember,future.id,'future_exchange01','300','0'),/有效期/);
    const old=await createReward({valid_end_time:new Date(Date.now()-1000)});
    await assert.rejects(V.exchange(centerMember,old.id,'expired_exchange1','300','0'),/有效期/);
    const ledgerResponse=await (await get('/member/points/ledger?direction=spend',S.sign(centerMember))).json();
    assert.ok(ledgerResponse.data.list.every(r=>BigInt(r.delta)<0n));
    assert.ok(ledgerResponse.data.list.some(r=>r.reason==='兑换配件券'));
    const migration = require('../scripts/migrate-member-center');
    const activityMember=await M.Member.create({});
    const activityRequest = (type='activity') => fetch(`http://127.0.0.1:${server.address().port}/test-staff/points/adjustments`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'new_member_activity_01'},body:JSON.stringify({member_id:activityMember.id,distributor_id:'test_dist',delta:'100',reason:'到店活动',type})});
    assert.equal((await activityRequest()).status,200);
    assert.equal((await activityRequest()).status,200);
    assert.equal((await activityRequest('adjustment')).status,409);
    const activityAccount=await M.Account.findOne({where:{member_id:activityMember.id}});
    assert.equal(activityAccount.balance,'100');assert.equal(activityAccount.earned,'100');
    await sequelize.getQueryInterface().removeColumn(M.Reward.tableName, 'description');
    await migration.migrate(true);
    const ruleCount = await M.Rule.count();
    await migration.migrate(true);
    assert.equal(await M.Rule.count(), ruleCount);
    const currentRule=await M.Rule.findOne({where:{distributor_id:'test_dist'},order:[['effective_at','DESC']]});
    assert.equal(currentRule.denominator,'1000');
    assert.ok((await sequelize.getQueryInterface().describeTable(M.Reward.tableName)).description);
    for (const acc of await M.Account.findAll()) {
      const rows = await M.Ledger.findAll({ where: { account_id: acc.id } });
      assert.equal(rows.reduce((sum, row) => sum + BigInt(row.delta), 0n), BigInt(acc.balance));
    }
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
