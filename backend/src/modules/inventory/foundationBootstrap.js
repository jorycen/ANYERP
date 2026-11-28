const M=require('../../models');
async function bootstrap(run=require('./foundationBackfill').run){
  // A dedicated transaction pins the connection holding the MySQL named lock.
  // Do not advertise readiness until both schema and initial references exist.
  return M.sequelize.transaction(async transaction=>{
    const [lock]=await M.sequelize.query("SELECT GET_LOCK('inventory_foundation_bootstrap_v1',60) AS acquired",{transaction,type:M.sequelize.QueryTypes.SELECT});
    if(Number(lock?.acquired)!==1)throw Error('统一库存基础资料初始化锁未取得');
    try{
      const marker=await M.BusinessActionLog.findOne({where:{business_type:'inventory_foundation_migration',business_id:'bootstrap-v1',action:'bootstrap_completed'},transaction});
      if(marker)return;
      const counts=await run({apply:true,startup:true,schemaReady:true});
      // Seed chunks have committed independently. Commit the completion marker
      // before releasing the named lock, so the next replica cannot seed again.
      await require('../../utils/businessActionLog').recordBusinessAction({businessType:'inventory_foundation_migration',businessId:'bootstrap-v1',action:'bootstrap_completed',
        user:{name:'system'},comment:'统一库存基础资料首次建档完成；不修改历史金额',detail:counts});
    }finally{
      await M.sequelize.query("SELECT RELEASE_LOCK('inventory_foundation_bootstrap_v1')",{transaction});
    }
  });
}
module.exports={bootstrap};
