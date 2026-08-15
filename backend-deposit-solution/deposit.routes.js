const express = require('express');

function toId(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function makeDepositNo() {
  const d = new Date();
  return 'DJ' +
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    Math.random().toString(36).slice(2, 5).toUpperCase();
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function pageParams(query) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize || query.limit || 50)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function userOf(req) {
  return req.user || req.auth || req.currentUser || {};
}

function mapDeposit(row) {
  const amount = money(row.AMOUNT);
  const reservedAmount = money(row.RESERVED_AMOUNT);
  const redeemedAmount = money(row.REDEEMED_AMOUNT);
  const refundedAmount = money(row.REFUNDED_AMOUNT);
  return {
    deposit_id: row.DEPOSIT_ID,
    depositId: row.DEPOSIT_ID,
    deposit_no: row.DEPOSIT_NO,
    depositNo: row.DEPOSIT_NO,
    store_id: row.STORE_ID,
    storeId: row.STORE_ID,
    store_name: row.STORE_NAME || '',
    storeName: row.STORE_NAME || '',
    customer_name: row.CUSTOMER_NAME,
    customerName: row.CUSTOMER_NAME,
    customer_phone: row.CUSTOMER_PHONE,
    customerPhone: row.CUSTOMER_PHONE,
    amount,
    reserved_amount: reservedAmount,
    reservedAmount,
    redeemed_amount: redeemedAmount,
    redeemedAmount,
    refunded_amount: refundedAmount,
    refundedAmount,
    available_amount: money(amount - reservedAmount - redeemedAmount - refundedAmount),
    availableAmount: money(amount - reservedAmount - redeemedAmount - refundedAmount),
    payment_method: row.PAYMENT_METHOD || '',
    paymentMethod: row.PAYMENT_METHOD || '',
    status: row.STATUS,
    create_user: row.CREATE_USER || '',
    createUser: row.CREATE_USER || '',
    create_time: row.CREATE_TIME,
    createTime: row.CREATE_TIME,
    archive_time: row.ARCHIVE_TIME,
    archiveTime: row.ARCHIVE_TIME,
    refund_time: row.REFUND_TIME,
    refundTime: row.REFUND_TIME,
    remark: row.REMARK || ''
  };
}

async function listDeposits(pool, query, onlyAvailable) {
  const { page, pageSize, offset } = pageParams(query);
  const where = ['IS_DELETED = 0'];
  const args = [];

  if (query.storeId) {
    where.push('STORE_ID = ?');
    args.push(query.storeId);
  }
  if (query.customerPhone) {
    where.push('CUSTOMER_PHONE = ?');
    args.push(query.customerPhone);
  }
  if (query.status) {
    where.push('STATUS = ?');
    args.push(query.status);
  }
  if (onlyAvailable) {
    // 新流程提交后立即可用；submitted 保留用于兼容历史数据。
    where.push("STATUS IN ('submitted', 'archived', 'available')");
    where.push('(AMOUNT - RESERVED_AMOUNT - REDEEMED_AMOUNT - REFUNDED_AMOUNT) > 0');
  }

  const whereSql = where.join(' AND ');
  const [rows] = await pool.execute(
    `SELECT * FROM T_SALES_DEPOSIT
     WHERE ${whereSql}
     ORDER BY CREATE_TIME DESC
     LIMIT ? OFFSET ?`,
    args.concat([pageSize, offset])
  );
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM T_SALES_DEPOSIT WHERE ${whereSql}`,
    args
  );

  return {
    code: 0,
    data: rows.map(mapDeposit),
    pagination: {
      page,
      pageSize,
      total: Number(countRow.total || 0)
    }
  };
}

function getOrderIdentity(order) {
  const orderNo = order.orderNo || order.order_no || '';
  return {
    orderId: order.orderId || order.order_id || orderNo,
    orderNo
  };
}

function getDepositItems(order) {
  const deposits = order.depositItems || order.deposit_items || order.deposits || [];
  return Array.isArray(deposits) ? deposits : [];
}

function getDepositItemAmount(item) {
  return money(
    item.amount !== undefined
      ? item.amount
      : (item.deductionAmount !== undefined ? item.deductionAmount : item.deduction_amount)
  );
}

async function reserveDepositsForOrder(connection, order) {
  const deposits = getDepositItems(order);
  if (deposits.length === 0) return [];

  const identity = getOrderIdentity(order);
  if (!identity.orderNo) throw new Error('Order number is required to reserve deposits');

  const results = [];
  for (const item of deposits) {
    const depositId = item.depositId || item.deposit_id;
    if (!depositId) continue;
    const amount = getDepositItemAmount(item);
    if (amount <= 0) {
      throw new Error('Deposit deduction amount must be greater than 0: ' + depositId);
    }

    const [rows] = await connection.execute(
      `SELECT * FROM T_SALES_DEPOSIT
       WHERE DEPOSIT_ID = ? AND IS_DELETED = 0
       FOR UPDATE`,
      [depositId]
    );
    if (!rows.length) throw new Error('Deposit not found: ' + depositId);

    const deposit = rows[0];
    const [redemptionRows] = await connection.execute(
      `SELECT * FROM T_SALES_DEPOSIT_REDEMPTION
       WHERE DEPOSIT_ID = ? AND ORDER_ID = ?
       FOR UPDATE`,
      [depositId, identity.orderId]
    );
    const existingRedemption = redemptionRows[0];
    if (existingRedemption && ['reserved', 'redeemed', 'applied'].includes(existingRedemption.STATUS)) {
      if (money(existingRedemption.AMOUNT) !== amount) {
        throw new Error('Deposit reservation amount cannot be changed: ' + deposit.DEPOSIT_NO);
      }
      results.push({ depositId, amount, status: existingRedemption.STATUS, idempotent: true });
      continue;
    }

    const available = money(
      deposit.AMOUNT -
      deposit.RESERVED_AMOUNT -
      deposit.REDEEMED_AMOUNT -
      deposit.REFUNDED_AMOUNT
    );
    if (deposit.STATUS !== 'submitted' && deposit.STATUS !== 'archived' && deposit.STATUS !== 'available') {
      throw new Error('Deposit is not available: ' + deposit.DEPOSIT_NO);
    }
    if (amount > available) {
      throw new Error('Deposit amount exceeds available amount: ' + deposit.DEPOSIT_NO);
    }

    await connection.execute(
      `UPDATE T_SALES_DEPOSIT
       SET RESERVED_AMOUNT = RESERVED_AMOUNT + ?,
           STATUS = 'occupied'
       WHERE DEPOSIT_ID = ?`,
      [amount, depositId]
    );
    await connection.execute(
      `INSERT INTO T_SALES_DEPOSIT_REDEMPTION
       (DEPOSIT_ID, ORDER_ID, ORDER_NO, AMOUNT, STATUS)
       VALUES (?, ?, ?, ?, 'reserved')
       ON DUPLICATE KEY UPDATE AMOUNT = VALUES(AMOUNT), STATUS = 'reserved'`,
      [depositId, identity.orderId, identity.orderNo, amount]
    );

    results.push({ depositId, amount, status: 'reserved' });
  }

  return results;
}

async function redeemDepositsForOrder(connection, order) {
  const identity = getOrderIdentity(order);
  if (!identity.orderNo) throw new Error('Order number is required to redeem deposits');

  let [redemptions] = await connection.execute(
    `SELECT * FROM T_SALES_DEPOSIT_REDEMPTION
     WHERE (ORDER_ID = ? OR ORDER_NO = ?) AND STATUS IN ('reserved', 'applied', 'redeemed')
     FOR UPDATE`,
    [identity.orderId, identity.orderNo]
  );

  // 兼容尚未预占的历史订单：先按订单快照建立预占记录，再执行核销。
  if (!redemptions.length && getDepositItems(order).length) {
    await reserveDepositsForOrder(connection, order);
    [redemptions] = await connection.execute(
      `SELECT * FROM T_SALES_DEPOSIT_REDEMPTION
       WHERE (ORDER_ID = ? OR ORDER_NO = ?) AND STATUS = 'reserved'
       FOR UPDATE`,
      [identity.orderId, identity.orderNo]
    );
  }

  const results = [];
  for (const redemption of redemptions) {
    if (redemption.STATUS === 'redeemed') {
      results.push({ depositId: redemption.DEPOSIT_ID, amount: money(redemption.AMOUNT), idempotent: true });
      continue;
    }

    const amount = money(redemption.AMOUNT);
    if (redemption.STATUS === 'reserved') {
      await connection.execute(
        `UPDATE T_SALES_DEPOSIT
         SET RESERVED_AMOUNT = GREATEST(0, RESERVED_AMOUNT - ?),
             REDEEMED_AMOUNT = REDEEMED_AMOUNT + ?,
             STATUS = 'redeemed'
         WHERE DEPOSIT_ID = ? AND IS_DELETED = 0`,
        [amount, amount, redemption.DEPOSIT_ID]
      );
    } else {
      // applied 是旧流程已增加 REDEEMED_AMOUNT 的记录，仅统一最终状态。
      await connection.execute(
        `UPDATE T_SALES_DEPOSIT SET STATUS = 'redeemed'
         WHERE DEPOSIT_ID = ? AND IS_DELETED = 0`,
        [redemption.DEPOSIT_ID]
      );
    }
    await connection.execute(
      `UPDATE T_SALES_DEPOSIT_REDEMPTION SET STATUS = 'redeemed'
       WHERE REDEMPTION_ID = ?`,
      [redemption.REDEMPTION_ID]
    );
    results.push({ depositId: redemption.DEPOSIT_ID, amount, status: 'redeemed' });
  }
  return results;
}

async function releaseDepositsForOrder(connection, order) {
  const identity = getOrderIdentity(order);
  if (!identity.orderNo) throw new Error('Order number is required to release deposits');

  const [redemptions] = await connection.execute(
    `SELECT * FROM T_SALES_DEPOSIT_REDEMPTION
     WHERE (ORDER_ID = ? OR ORDER_NO = ?) AND STATUS IN ('reserved', 'applied', 'redeemed')
     FOR UPDATE`,
    [identity.orderId, identity.orderNo]
  );

  const results = [];
  for (const redemption of redemptions) {
    const amount = money(redemption.AMOUNT);
    const [depositRows] = await connection.execute(
      `SELECT * FROM T_SALES_DEPOSIT
       WHERE DEPOSIT_ID = ? AND IS_DELETED = 0
       FOR UPDATE`,
      [redemption.DEPOSIT_ID]
    );
    if (!depositRows.length) throw new Error('Deposit not found: ' + redemption.DEPOSIT_ID);
    const deposit = depositRows[0];
    const reservedAmount = redemption.STATUS === 'reserved'
      ? Math.max(0, money(deposit.RESERVED_AMOUNT) - amount)
      : money(deposit.RESERVED_AMOUNT);
    const redeemedAmount = redemption.STATUS === 'reserved'
      ? money(deposit.REDEEMED_AMOUNT)
      : Math.max(0, money(deposit.REDEEMED_AMOUNT) - amount);
    const nextStatus = reservedAmount > 0 ? 'occupied' : 'available';

    await connection.execute(
      `UPDATE T_SALES_DEPOSIT
       SET RESERVED_AMOUNT = ?,
           REDEEMED_AMOUNT = ?,
           STATUS = ?
       WHERE DEPOSIT_ID = ? AND IS_DELETED = 0`,
      [reservedAmount, redeemedAmount, nextStatus, redemption.DEPOSIT_ID]
    );
    await connection.execute(
      `UPDATE T_SALES_DEPOSIT_REDEMPTION SET STATUS = 'released'
       WHERE REDEMPTION_ID = ?`,
      [redemption.REDEMPTION_ID]
    );
    results.push({ depositId: redemption.DEPOSIT_ID, amount, status: 'released' });
  }
  return results;
}

function createDepositRouter({ pool, authMiddleware } = {}) {
  if (!pool) throw new Error('createDepositRouter requires a mysql2 pool');

  const router = express.Router();
  if (authMiddleware) router.use(authMiddleware);

  router.get('/deposits/available', async (req, res, next) => {
    try {
      res.json(await listDeposits(pool, req.query, true));
    } catch (err) {
      next(err);
    }
  });

  router.get('/deposits', async (req, res, next) => {
    try {
      res.json(await listDeposits(pool, req.query, false));
    } catch (err) {
      next(err);
    }
  });

  router.post('/deposits', async (req, res, next) => {
    try {
      const body = req.body || {};
      const user = userOf(req);
      const amount = money(body.amount);
      if (!body.storeId && !body.store_id) return res.status(400).json({ code: 400, message: 'storeId is required' });
      if (!body.customerName && !body.customer_name) return res.status(400).json({ code: 400, message: 'customerName is required' });
      if (!body.customerPhone && !body.customer_phone) return res.status(400).json({ code: 400, message: 'customerPhone is required' });
      if (amount <= 0) return res.status(400).json({ code: 400, message: 'amount must be greater than 0' });

      const depositId = toId('DEP');
      const depositNo = makeDepositNo();
      await pool.execute(
        `INSERT INTO T_SALES_DEPOSIT
         (DEPOSIT_ID, DEPOSIT_NO, STORE_ID, STORE_NAME, CUSTOMER_NAME, CUSTOMER_PHONE, AMOUNT,
          PAYMENT_METHOD, STATUS, CREATE_USER, CREATE_USER_PHONE, REMARK)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
        [
          depositId,
          depositNo,
          body.storeId || body.store_id,
          body.storeName || body.store_name || '',
          body.customerName || body.customer_name,
          body.customerPhone || body.customer_phone,
          amount,
          body.paymentMethod || body.payment_method || '',
          body.createUser || user.name || user.userName || '',
          body.createUserPhone || user.phone || user.phoneNumber || '',
          body.remark || ''
        ]
      );
      res.json({ code: 0, data: { depositId, depositNo } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/deposits/:depositId/archive', async (req, res, next) => {
    try {
      const user = userOf(req);
      const [result] = await pool.execute(
        `UPDATE T_SALES_DEPOSIT
         SET STATUS = 'archived', ARCHIVE_USER = ?, ARCHIVE_TIME = NOW()
         WHERE DEPOSIT_ID = ? AND STATUS = 'submitted' AND IS_DELETED = 0`,
        [user.name || user.userName || '', req.params.depositId]
      );
      if (!result.affectedRows) return res.status(409).json({ code: 409, message: 'Deposit cannot be archived' });
      res.json({ code: 0, data: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/deposits/order-transition', async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      const body = req.body || {};
      const action = String(body.action || '').toLowerCase();
      const handlers = {
        reserve: reserveDepositsForOrder,
        redeem: redeemDepositsForOrder,
        release: releaseDepositsForOrder
      };
      if (!handlers[action]) {
        return res.status(400).json({ code: 400, message: 'Invalid deposit transition action' });
      }

      await connection.beginTransaction();
      const data = await handlers[action](connection, body);
      await connection.commit();
      res.json({ code: 0, data });
    } catch (err) {
      await connection.rollback();
      next(err);
    } finally {
      if (connection && connection.release) connection.release();
    }
  });

  router.post('/deposits/:depositId/refund', async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT * FROM T_SALES_DEPOSIT
         WHERE DEPOSIT_ID = ? AND IS_DELETED = 0
         FOR UPDATE`,
        [req.params.depositId]
      );
      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ code: 404, message: 'Deposit not found' });
      }

      const row = rows[0];
      if (row.STATUS === 'occupied') {
        await connection.rollback();
        return res.status(409).json({ code: 409, message: 'Occupied deposit cannot be refunded' });
      }
      const available = money(
        row.AMOUNT - row.RESERVED_AMOUNT - row.REDEEMED_AMOUNT - row.REFUNDED_AMOUNT
      );
      const refundAmount = money(req.body && req.body.amount ? req.body.amount : available);
      if (refundAmount <= 0 || refundAmount > available) {
        await connection.rollback();
        return res.status(400).json({ code: 400, message: 'Invalid refund amount' });
      }

      await connection.execute(
        `UPDATE T_SALES_DEPOSIT
         SET REFUNDED_AMOUNT = REFUNDED_AMOUNT + ?,
             STATUS = CASE
               WHEN AMOUNT - REDEEMED_AMOUNT - (REFUNDED_AMOUNT + ?) <= 0 THEN 'refunded'
               ELSE STATUS
             END,
             REFUND_TIME = NOW()
         WHERE DEPOSIT_ID = ?`,
        [refundAmount, refundAmount, req.params.depositId]
      );
      await connection.commit();
      res.json({ code: 0, data: true });
    } catch (err) {
      await connection.rollback();
      next(err);
    } finally {
      connection.release();
    }
  });

  return router;
}

module.exports = {
  createDepositRouter,
  reserveDepositsForOrder,
  redeemDepositsForOrder,
  releaseDepositsForOrder
};
