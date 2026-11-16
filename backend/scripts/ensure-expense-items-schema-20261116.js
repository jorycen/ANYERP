const M=require('../src/models'),fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
async function main(){
 const dir=path.resolve(__dirname,'../backup/schema/EXPENSE-ITEMS-'+Date.now());
 const snapshot=async()=>{const [columns]=await M.sequelize.query('SHOW COLUMNS FROM T_EXPENSE');const [counts]=await M.sequelize.query('SELECT STATUS AS status, COUNT(*) AS count, SUM(AMOUNT) AS amount, SUM(SETTLED_AMOUNT) AS settled FROM T_EXPENSE GROUP BY STATUS ORDER BY STATUS');return {columns,counts};};
 fs.mkdirSync(dir,{recursive:true});const before=await snapshot();fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify(before,null,2));
 await require('../src/utils/dbMigration').ensureExpenseItemsSchema();
 const after=await snapshot();a.deepEqual(after.counts,before.counts);a(after.columns.some(c=>c.Field.toLowerCase()==='expense_items_json'));
 fs.writeFileSync(path.join(dir,'after.json'),JSON.stringify(after,null,2));
 console.log(JSON.stringify({verified:true,historyUnchanged:true,path:dir}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
