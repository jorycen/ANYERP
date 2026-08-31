const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const inventoryController = require('../src/modules/inventory/controller');
const financeController = require('../src/modules/finance/controller');
const productController = require('../src/modules/product/controller');
const resourceRights = require('../src/modules/inventory/resourceRights');
const batchMaintenance = require('../src/modules/inventory/batchMaintenance');

function emptyContext(user, query = {}) {
  return {
    state: { user },
    query,
    throw(status, message) {
      const error = new Error(message);
      error.status = status;
      throw error;
    }
  };
}

test('非审批角色查询退库审批范围时返回不可命中的条件', async () => {
  const original = models.ReturnStock.findAndCountAll;
  let options;
  models.ReturnStock.findAndCountAll = async value => {
    options = value;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = emptyContext({ roles: ['manager'], accessibleStoreIds: ['STORE-1'] }, { scope: 'review', status: 'pending' });
    await inventoryController.getReturnList(ctx);
    assert.equal(options.where.return_id, '__NO_RETURN_APPROVAL_ACCESS__');
  } finally {
    models.ReturnStock.findAndCountAll = original;
  }
});

test('非审批角色查询报销审批范围时返回不可命中的条件', async () => {
  const originals = {
    storeFindAll: models.Store.findAll,
    expenseFindAndCountAll: models.Expense.findAndCountAll
  };
  let options;
  models.Store.findAll = async () => [];
  models.Expense.findAndCountAll = async value => {
    options = value;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = emptyContext({ roles: ['finance'], accessibleStoreIds: ['STORE-1'] }, { scope: 'review', status: 'pending_approval' });
    await financeController.getExpenseList(ctx);
    assert.equal(options.where.expense_id, '__NO_EXPENSE_APPROVAL_ACCESS__');
  } finally {
    models.Store.findAll = originals.storeFindAll;
    models.Expense.findAndCountAll = originals.expenseFindAndCountAll;
  }
});

test('非审批角色查询商品审批范围时返回不可命中的条件', async () => {
  const original = models.ProductApplication.findAndCountAll;
  let options;
  models.ProductApplication.findAndCountAll = async value => {
    options = value;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = emptyContext({ roles: ['manager'], accessibleDistributorIds: ['DIST-1'], staffId: 'STAFF-1' }, { scope: 'review', status: 'pending' });
    await productController.getProductApplicationList(ctx);
    assert.equal(options.where.application_id, '__NO_PRODUCT_APPROVAL_ACCESS__');
  } finally {
    models.ProductApplication.findAndCountAll = original;
  }
});

test('非财务角色查询资源套回审批范围时返回不可命中的条件', async () => {
  const original = models.ResourceRightChangeOrder.findAndCountAll;
  let options;
  models.ResourceRightChangeOrder.findAndCountAll = async value => {
    options = value;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = emptyContext({ roles: ['manager'], accessibleStoreIds: ['STORE-1'] }, { scope: 'review', approvalStatus: 'pending_finance' });
    await resourceRights.listChanges(ctx);
    assert.equal(options.where.change_id, '__NO_RESOURCE_APPROVAL_ACCESS__');
  } finally {
    models.ResourceRightChangeOrder.findAndCountAll = original;
  }
});

test('非经销商总权限角色查询批量库存审批范围时返回不可命中的条件', async () => {
  const original = models.InventoryBatchApplication.findAndCountAll;
  let options;
  models.InventoryBatchApplication.findAndCountAll = async value => {
    options = value;
    return { count: 0, rows: [] };
  };
  try {
    const ctx = emptyContext({ roles: ['clerk'], staffId: 'STAFF-1' }, { scope: 'review', status: 'pending' });
    await batchMaintenance.listBatchApplications(ctx);
    assert.equal(options.where.application_id, '__NO_BATCH_APPROVAL_ACCESS__');
  } finally {
    models.InventoryBatchApplication.findAndCountAll = original;
  }
});
