const M=require('../src/models');
async function main(){
 const qi=M.sequelize.getQueryInterface(),columns=await qi.describeTable('T_MONTHLY_INDICATOR');
 if(!Object.keys(columns).some(k=>k.toLowerCase()==='scope_config'))await qi.addColumn('T_MONTHLY_INDICATOR','scope_config',{type:require('sequelize').DataTypes.JSON,allowNull:true});
 await M.MonthlyIndicatorPlan.sync();
 await M.sequelize.query('SELECT scope_config FROM T_MONTHLY_INDICATOR LIMIT 0');
 console.log('Monthly indicator v2 schema ready');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>M.sequelize.close());
