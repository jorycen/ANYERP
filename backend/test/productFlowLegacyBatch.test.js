const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { listProductFlow } = require('../src/modules/inventory/productFlow');

test('历史批量流水兼容主单执行完成但明细pending，保持成功明细及权限分页筛选', async t => {
  const queries = [];
  t.mock.method(sequelize, 'query', async (sql, options) => {
    queries.push({ sql, options });
    return sql.startsWith('SELECT COUNT') ? [{ total: 1 }] : [{ flow_id: 'batch:1' }];
  });
  const ctx = { query: { keyword: 'IBM20260821', direction: 'in', page: 2, pageSize: 20, storeId: 'STORE' },
    state: { user: { roles: ['boss'] } } };
  await listProductFlow(ctx);
  assert.equal(ctx.body.data.total, 1);
  assert.equal(queries.length, 2);
  for (const { sql, options } of queries) {
    assert.match(sql, /i\.EXECUTE_STATUS = 'success'/);
    assert.match(sql, /i\.EXECUTE_STATUS = 'pending' AND a\.STATUS = 'executed' AND a\.EXECUTE_TIME IS NOT NULL/);
    assert.match(sql, /flow\.store_id = :storeId/);
    assert.match(sql, /flow\.direction = :direction/);
    assert.equal(options.replacements.keyword, '%IBM20260821%');
    assert.equal(options.replacements.offset, 20);
  }
});
