const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const XLSX = require('xlsx');
const M = require('../src/models');
const C = require('../src/modules/finance/payableController');

test('付款批次合并供应商，列表和导出共用筛选且导出不限当前页', async t => {
  const captured = [];
  const batch = { batch_id: 'B', batch_no: 'PB001', distributor_id: 'D', total_amount: 300, total_count: 3, status: 'active',
    create_time: new Date('2026-10-21T00:00:00+08:00'), records: [
      { Settlement: { supplier_name: '供应商甲', distributor_id: 'D', tax_status: 'UNTAXED' } },
      { Settlement: { supplier_name: '供应商乙', distributor_id: 'D', tax_status: 'UNTAXED' } },
      { Settlement: { supplier_name: '供应商甲', distributor_id: 'D', tax_status: 'UNTAXED' } }
    ] };
  t.mock.method(M.sequelize, 'query', async () => { throw Error('No database access in test'); });
  t.mock.method(M.SettlementPaymentBatch, 'findAndCountAll', async options => { captured.push(options); return { count: 2, rows: [batch] }; });
  t.mock.method(M.SettlementPaymentBatch, 'findAll', async options => { captured.push(options); return [batch]; });
  t.mock.method(M.Distributor, 'findAll', async () => [{ distributor_id: 'D', name: '经销商一' }]);
  const query = { batchNo: 'PB', supplierName: '供应商甲', distributorId: 'D', startDate: '2026-10-01', endDate: '2026-10-21', page: 2, pageSize: 20 };
  const ctx = { query, state: { user: { roles: ['boss'] } }, set() {} };
  await C.getPaymentBatches(ctx, () => {});
  assert.equal(ctx.body.list[0].supplier_names, '供应商甲、供应商乙');
  assert.equal(ctx.body.list[0].total_amount, 300);
  assert.equal(captured[0].where.batch_no[Op.like], '%PB%');
  assert.equal(captured[0].where.distributor_id, 'D');
  assert.equal(captured[0].where.create_time[Op.gte].toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(captured[0].where.create_time[Op.lte].toISOString(), '2026-10-21T15:59:59.999Z');
  assert.match(captured[0].where[Op.and][0].val, /EXISTS.*SELECT 1/s);
  assert.equal(captured[0].offset, 20);
  await C.exportPaymentBatches(ctx);
  assert.equal(captured[1].limit, undefined);
  assert.deepEqual(captured[0].where, captured[1].where);
  const book = XLSX.read(ctx.body, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
  assert.equal(rows[0]['供应商'], '供应商甲、供应商乙');
  assert.equal(rows[0]['付款总额'], 300);
});

test('经销商筛选与供应商筛选不能覆盖账号权限', async t => {
  let options;
  t.mock.method(M.SettlementPaymentBatch, 'findAndCountAll', async value => { options = value; return { count: 0, rows: [] }; });
  await C.getPaymentBatches({ query: { supplierName: "a' OR 1=1 --", distributorId: 'OTHER' },
    state: { user: { roles: ['finance'], accessibleDistributorIds: ['D'] } } });
  assert.equal(options.where.distributor_id, 'OTHER');
  assert.equal(options.where[Op.and].length, 2);
  assert.match(options.where[Op.and][0].val, /\\'/);
});
