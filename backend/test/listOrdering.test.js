const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPendingFirstOrder } = require('../src/utils');

const sequelize = {
  escape(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  },
  literal(value) {
    return { literal: value };
  }
};

test('业务清单按待处理状态、时间和唯一 ID 依次排序', () => {
  const order = buildPendingFirstOrder(sequelize, {
    statusColumn: 'Order.order_status',
    pendingStatuses: ['pending_approval', '未归档'],
    dateColumns: ['Order.create_time'],
    idColumn: 'Order.order_id'
  });

  assert.deepEqual(order, [
    [
      {
        literal: "CASE WHEN `Order`.`order_status` IN ('pending_approval', '未归档') THEN 0 ELSE 1 END"
      },
      'ASC'
    ],
    [{ literal: '`Order`.`create_time`' }, 'DESC'],
    [{ literal: '`Order`.`order_id`' }, 'DESC']
  ]);
});

test('业务清单排序拒绝非法字段名', () => {
  assert.throws(() => buildPendingFirstOrder(sequelize, {
    statusColumn: 'status; DROP TABLE orders',
    pendingStatuses: ['pending']
  }), /排序字段无效/);
});
