const { test } = require('node:test');
const a = require('node:assert/strict');
const { ensureEmployeeProfitMenu } = require('../src/utils/employeeProfitMenu');
test('missing menu inherits existing employee-report roles once', async () => {
  const sql=[];
  const db={transaction:fn=>fn({}),query:async(s,o)=>{sql.push(s);if(s.includes("MENU_CODE='reports'"))return [[{MENU_ID:'parent'}]];if(s.startsWith('SELECT'))return [[]];return [[],{}]}};
  await ensureEmployeeProfitMenu(db);
  a.equal(sql.length,4);a.match(sql[2],/employee-profit-summary/);a.match(sql[3],/reports_employee'/);
});
test('existing disabled menu is not reactivated or reassigned',async()=>{
  let calls=0;
  const db={transaction:fn=>fn({}),query:async()=>{calls++;return [[{MENU_ID:'existing',STATUS:0}]]}};
  await ensureEmployeeProfitMenu(db);a.equal(calls,2);
});
