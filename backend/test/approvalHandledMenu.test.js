const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureApprovalHandledMenu } = require('../src/utils/approvalHandledMenu');
function database(existing = [], parents = [{ MENU_ID: 'P' }]) {
  const calls = [], transaction = {};
  return { calls, transaction: async fn => fn(transaction), query: async (sql, options) => {
    calls.push({sql, options}); assert.equal(options.transaction, transaction);
    if (sql.startsWith('SELECT MENU_ID FROM')) return [parents];
    if (sql.startsWith('SELECT MENU_ID, STATUS')) return [existing];
    return [[]];
  }};
}
test('missing entry is created transactionally and inherits only existing approval audience', async () => {
  const db = database(); await ensureApprovalHandledMenu(db);
  assert.equal(db.calls.length,4);
  assert.equal(db.calls[2].options.replacements[1],'P');
  assert.match(db.calls[3].sql,/M.MENU_CODE = 'approval_tasks'/);
  assert.equal(db.calls[2].options.replacements[0],db.calls[3].options.replacements[0]);
});
test('existing or explicitly disabled entry is untouched', async () => {
  for (const status of [0,1]) { const db = database([{MENU_ID:'M',STATUS:status}]); await ensureApprovalHandledMenu(db); assert.equal(db.calls.length,2); }
});
test('no approval parent does not create an orphan', async () => {
  const db = database([],[]); await ensureApprovalHandledMenu(db); assert.equal(db.calls.length,1);
});
