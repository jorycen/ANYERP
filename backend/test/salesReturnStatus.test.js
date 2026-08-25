const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSalesReturnInProgressStatus,
  getSalesReturnStatusLabel,
  getOrderExportArchiveStatus
} = require('../src/modules/sales/controller')._test;

test('销售退单审批和退货入库使用不同的订单状态', () => {
  assert.equal(isSalesReturnInProgressStatus('return_pending'), true);
  assert.equal(isSalesReturnInProgressStatus('return_inbound'), true);
  assert.equal(getSalesReturnStatusLabel('return_pending'), '退单审批中');
  assert.equal(getSalesReturnStatusLabel('return_inbound'), '退货入库中');
  assert.equal(getSalesReturnStatusLabel('returned'), '已退单');
});

test('退单处理中订单不再按普通未归档订单导出', () => {
  assert.equal(getOrderExportArchiveStatus('return_pending'), '退单审批中');
  assert.equal(getOrderExportArchiveStatus('return_inbound'), '退货入库中');
  assert.equal(getOrderExportArchiveStatus('returned'), '已退单');
});
