const {run}=require('../src/modules/inventory/foundationBackfill');
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>require('../src/models').sequelize.close());
module.exports={run};