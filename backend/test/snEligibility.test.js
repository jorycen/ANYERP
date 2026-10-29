const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/config/database');
const { evaluateEvidence, assertSnEligible, inspectSnEligibility } = require('../src/utils/snEligibility');
const sn = { sn_id: 'S1', sn_code: 'SN1', store_id: 'A', inventory_type: 'normal_qty', inbound_price: 0 };
const location = { location_id: 'L1', store_id: 'A', type: 'normal_qty', status: 1 };

function evidenceStub({ current = sn, source = location, entries = [], approvals = [], logs = [] }, run) {
  const original = sequelize.query;
  const transaction = { id: 'TEST_TRANSACTION' };
  sequelize.query = async (sql, options) => {
    assert.equal(options.transaction, transaction);
    assert.ok(options.replacements.snIds.includes(current.sn_id));
    if (sql.includes('FROM T_PRODUCT_SN')) return [{ ...source, snId: current.sn_id }];
    if (sql.includes('FROM T_INVENTORY_BATCH_APPLICATION_ITEM')) {
      assert.match(sql, /EXECUTE_STATUS='success'/);
      assert.match(sql, /a.STATUS IN \('executed','executing'\)/);
      return entries;
    }
    if (sql.includes('FROM T_SN_LOG')) return logs;
    if (sql.includes('FROM T_PURCHASE_REQUEST_ITEM')) return approvals;
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return Promise.resolve().then(() => run(transaction)).finally(() => { sequelize.query = original; });
}

test('normal zero cost is allowed; both special warehouse types remain restricted', () => {
  assert.equal(evaluateEvidence(sn, location).restricted, false);
  assert.equal(evaluateEvidence({ ...sn, source_type: 'PURCHASED_FROM_SPECIAL_WAREHOUSE' }, location).restricted, true);
  for (const type of ['display_qty', 'rental_demo_qty']) {
    assert.equal(evaluateEvidence({ ...sn, inventory_type: type }, location).restricted, true);
    assert.equal(evaluateEvidence(sn, { ...location, type }).restricted, true);
  }
});
test('only conversion after latest special entry clears history; missing time fails closed', () => {
  assert.equal(evaluateEvidence(sn, location, [{ epoch: 100 }], [{ epoch: 200 }]).restricted, false);
  assert.equal(evaluateEvidence(sn, location, [{ epoch: 100 }, { epoch: 300 }], [{ epoch: 200 }]).restricted, true);
  assert.equal(evaluateEvidence(sn, location, [{}], [{ epoch: 200 }]).restricted, true);
  assert.equal(evaluateEvidence(sn, location, [{ epoch: 200 }], [{ epoch: 200 }]).restricted, true);
});
test('disabled and cross-store physical locations are invalid', () => {
  assert.equal(evaluateEvidence(sn, { ...location, store_id: 'B' }).locationValid, false);
  assert.equal(evaluateEvidence(sn, { ...location, status: 0 }).locationValid, false);
});
test('special transfer out is permitted and target must stay in either special warehouse', async () => {
  for (const type of ['display_qty', 'rental_demo_qty']) {
    const current = { ...sn, inventory_type: type };
    await evidenceStub({ current, source: { ...location, type } }, async transaction => {
      await assertSnEligible(current, { transaction, movement: true });
      for (const toType of ['display_qty', 'rental_demo_qty']) {
        await assertSnEligible(current, { transaction, movement: true, targetStoreId: 'B',
          targetLocation: { ...location, store_id: 'B', type: toType } });
      }
      for (const toType of ['normal_qty', 'demo_qty', 'unsellable_qty', 'pending_qty']) {
        await assert.rejects(assertSnEligible(current, { transaction, movement: true,
          targetStoreId: 'B', targetLocation: { ...location, store_id: 'B', type: toType } }), /须完成采购转换/);
      }
      await assert.rejects(assertSnEligible(current, { transaction }), /须完成采购转换/);
      // Checking eligibility never edits the SN or financial fields.
      assert.equal(current.inventory_type, type);
      assert.equal(current.inbound_price, 0);
    });
  }
});
test('normal fields and nonzero price cannot launder special history', async () => {
  await evidenceStub({ entries: [{ snId: 'S1', document: 'BATCH1' }],
    logs: [{ snId: 'S1', action: 'batch_inbound', remark: 'BATCH1', epoch: 100 }] }, async transaction => {
    await assert.rejects(assertSnEligible({ ...sn, inbound_price: 9999 }, { transaction }), /须完成采购转换/);
    await assert.rejects(assertSnEligible(sn, { transaction, movement: true, reentry: true,
      targetLocation: location }), /须完成采购转换/);
    await assertSnEligible(sn, { transaction, movement: true, reentry: true,
      targetLocation: { ...location, type: 'display_qty' } });
  });
});
test('approval alone or conversion text without matching approval never grants eligibility', async () => {
  for (const approved of [false, true]) {
    await evidenceStub({ entries: [{ snId: 'S1', document: 'BATCH1' }],
      approvals: approved ? [{ snId: 'S1', document: 'PR1' }] : [],
      logs: [{ snId: 'S1', action: 'batch_inbound', remark: 'BATCH1', epoch: 100 },
        ...(!approved ? [{ snId: 'S1', action: 'special_warehouse_purchase', remark: 'PR1', epoch: 200 }] : [])] }, async transaction => {
      await assert.rejects(assertSnEligible(sn, { transaction }), /须完成采购转换/);
    });
  }
});
test('executed approved conversion works; entering special again restores restriction', async () => {
  for (const reentered of [false, true]) {
    await evidenceStub({ entries: [{ snId: 'S1', document: 'BATCH1' }], approvals: [{ snId: 'S1', document: 'PR1' }],
      logs: [{ snId: 'S1', action: 'batch_inbound', remark: 'BATCH1', epoch: 100 },
        { snId: 'S1', action: 'special_warehouse_purchase', remark: 'PR1', epoch: 200 },
        ...(reentered ? [{ snId: 'S1', action: 'special_warehouse_flow', epoch: 300 }] : [])] }, async transaction => {
      if (reentered) await assert.rejects(assertSnEligible(sn, { transaction }), /须完成采购转换/);
      else await assertSnEligible(sn, { transaction });
    });
  }
});
test('normal transfers and duplicate special receipts pass without field changes', async () => {
  await evidenceStub({}, async transaction => {
    await assertSnEligible(sn, { transaction, movement: true, targetStoreId: 'B', targetLocation: { ...location, store_id: 'B' } });
    await assertSnEligible(sn, { transaction });
  });
  const current = { ...sn, inventory_type: 'display_qty' };
  await evidenceStub({ current, source: { ...location, type: 'display_qty' } }, async transaction => {
    const options = { transaction, movement: true, targetLocation: { ...location, type: 'display_qty' } };
    await assertSnEligible(current, options);
    await assertSnEligible(current, options);
    await assert.rejects(assertSnEligible(current, { ...options, targetStoreId: 'B' }), /采购转换|接收门店/);
  });
});
test('empty candidate set needs no query', async () => {
  assert.equal((await inspectSnEligibility([])).size, 0);
});

test('another historical identity with the same code cannot block an approved current SN', async () => {
  await evidenceStub({ entries: [{ snId: 'OTHER-ID', snCode: 'SN1', document: 'OLD-BATCH' },
    { snId: 'S1', snCode: 'SN1', document: 'BATCH1' }], approvals: [{ snId: 'S1', document: 'PR1' }],
    logs: [{ snId: 'S1', action: 'batch_inbound', remark: 'BATCH1', epoch: 100 },
      { snId: 'S1', action: 'special_warehouse_purchase', remark: 'PR1', epoch: 200 }] }, async transaction => {
    await assertSnEligible(sn, { transaction });
  });
});

test('legacy executed rows with pending line status require concrete SN execution evidence', async () => {
  for (const executed of [false, true]) {
    await evidenceStub({ entries: [{ snId: 'S1', document: 'OLD-BATCH', executeStatus: 'pending' }],
      logs: executed ? [{ snId: 'S1', action: 'batch_inbound', remark: 'OLD-BATCH', epoch: 100 }] : [] }, async transaction => {
      if (executed) await assert.rejects(assertSnEligible(sn, { transaction }), /须完成采购转换/);
      else await assertSnEligible(sn, { transaction });
    });
  }
});
