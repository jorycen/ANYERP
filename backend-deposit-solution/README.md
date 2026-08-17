# Deposit backend fix

The mini program currently calls:

- `GET /api/v1/sales/deposits`
- `POST /api/v1/sales/deposits`
- `POST /api/v1/sales/deposits/:depositId/archive`
- `POST /api/v1/sales/deposits/:depositId/refund`
- `GET /api/v1/sales/deposits/available`
- `POST /api/v1/sales/deposits/order-transition`

Production currently serves HTML for `/api/v1/sales/deposits/available`, which means that route is missing and the admin web SPA fallback is handling the request.

## Files

- `001_deposit_schema.sql`: MySQL tables and order/payment columns required by deposits.
- `deposit.routes.js`: Express + mysql2 route implementation.

## Express integration

Mount the router in the `anyerp-api` backend before the admin web/static fallback:

```js
const {
  createDepositRouter,
  reserveDepositsForOrder,
  redeemDepositsForOrder,
  releaseDepositsForOrder
} = require('./deposit.routes');

app.use('/api/v1/sales', createDepositRouter({
  pool,
  authMiddleware
}));

// Keep this after all /api/v1 routes.
app.get('*', serveAdminWebIndex);
```

定金抵扣采用三阶段状态流转，必须与订单状态更新使用同一个数据库事务：

- 新建订单提交：`available` → `occupied`
- 订单归档：`occupied` → `redeemed`
- 订单作废：`occupied/redeemed` → `available`

订单创建服务应在创建订单的同一个事务中预占定金：

```js
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();

  const order = await createSalesOrder(connection, payload);
  await reserveDepositsForOrder(connection, {
    orderId: order.orderId,
    orderNo: order.orderNo,
    depositItems: payload.depositItems || payload.deposit_items || []
  });

  await connection.commit();
} catch (err) {
  await connection.rollback();
  throw err;
} finally {
  connection.release();
}
```

订单状态更新服务应在更新订单状态的同一个事务中核销或释放定金：

```js
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();

  const order = await getOrderForUpdate(connection, orderIdOrNo);
  await updateSalesOrderStatus(connection, order, targetStatus);

  if (targetStatus === '已归档' || targetStatus === 'archived') {
    await redeemDepositsForOrder(connection, order);
  }
  if (targetStatus === '已作废' || targetStatus === 'voided' || targetStatus === 'cancelled') {
    await releaseDepositsForOrder(connection, order);
  }

  await connection.commit();
} catch (err) {
  await connection.rollback();
  throw err;
} finally {
  connection.release();
}
```

`POST /deposits/order-transition` 提供幂等的补偿/运维入口；正常订单流程应优先调用上述事务函数，避免订单状态与定金状态不一致。

## Deployment checklist

1. Run `001_deposit_schema.sql` on the production MySQL database.
2. Add `deposit.routes.js` to the `anyerp-api` backend.
3. Mount it at `/api/v1/sales` before the static web fallback.
4. Redeploy `anyerp-api`.
5. Verify these responses after login:
   - `GET /api/v1/sales/deposits/available` returns JSON, not HTML.
   - Newly submitted deposits immediately return with status `available`.
   - Available deposits and historical `submitted`/`archived` deposits with a remaining balance appear in available results.
   - Creating an order with deposit deductions increases `RESERVED_AMOUNT`, sets status to `occupied`, and writes a `reserved` redemption record.
   - Archiving that order moves the reserved amount into `REDEEMED_AMOUNT` and sets status to `redeemed`.
   - Voiding the order reverses its reserved/redeemed amount and sets the deposit back to `available`.

The mini program keeps a fallback to `/sales/deposits` during rollout, but the backend route above is the permanent fix.
