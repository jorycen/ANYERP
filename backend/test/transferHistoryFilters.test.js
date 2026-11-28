const test = require('node:test');
const assert = require('node:assert/strict');
const { _test, getTransferList } = require('../src/modules/inventory/controller');
const DB = require('../src/models');
const { Op, QueryTypes } = require('sequelize');

test('历史调拨组合筛选在分页前执行，保留整单商品并按单去重计数', async () => {
  const original = [DB.Transfer.findAndCountAll, DB.Product.findAll, DB.Inbound.findAll];
  let options;
  try {
    DB.Transfer.findAndCountAll = async value => {
      options = value;
      return { count: 1, rows: [{ transfer_no:'T1', TransferItems:[], toJSON:()=>({transfer_id:'T1',TransferItems:[]}) }] };
    };
    DB.Product.findAll = async () => [];
    DB.Inbound.findAll = async () => [];
    const ctx={query:{history:'1',fromStoreId:'OUT',toStoreId:'IN',productKeyword:'电脑',page:'2',pageSize:'20'},state:{user:{roles:['boss']}},throw:(code,message)=>{throw new Error(message)}};
    await getTransferList(ctx);
    assert.equal(options.distinct,true);
    assert.equal(options.offset,20);
    const conditions=options.where[Op.and];
    assert.ok(conditions.some(c=>c.from_store_id==='OUT'));
    assert.ok(conditions.some(c=>c.to_store_id==='IN'));
    assert.ok(conditions.some(c=>c.val?.includes('EXISTS')));
    assert.equal(options.include[2].where,undefined);
    assert.equal(_test.buildTransferProductKeywordCondition('   '),null);
  } finally {
    [DB.Transfer.findAndCountAll, DB.Product.findAll, DB.Inbound.findAll]=original;
  }
});

test('商品模糊查询匹配名称、编码、多PN及历史PN，特殊字符不扩大结果', {skip:process.env.RUN_TRANSFER_DB_TESTS!=='true'}, async()=>{
  // Only SELECT against inline fixtures; no production tables or rows are read or changed.
  const fixtures=`WITH T_TRANSFER_ITEM AS (
    SELECT 'T1' TRANSFER_ID,'P1' PRODUCT_ID,'OLD-PN' PN_CODE,1 QUANTITY UNION ALL
    SELECT 'T1','P2','',1 UNION ALL SELECT 'T2','P2','',1 UNION ALL SELECT 'T3','P1','',0
  ), T_PRODUCT AS (
    SELECT 'P1' PRODUCT_ID,'礼品鼠标100%' NAME,'CODE-001' PRODUCT_CODE,'LEGACY-PN' MANUFACTURER_CODE UNION ALL
    SELECT 'P2','电脑100X','CODE-002',''
  ), T_PRODUCT_PN AS (
    SELECT 'P1' PRODUCT_ID,'NEW-PN-1' PN_CODE,1 STATUS,0 IS_DELETED UNION ALL
    SELECT 'P1','NEW-PN-2',1,0 UNION ALL SELECT 'P1','DELETED-PN',1,1
  ) SELECT Transfer.TRANSFER_ID FROM (SELECT 'T1' TRANSFER_ID UNION ALL SELECT 'T2' UNION ALL SELECT 'T3') Transfer WHERE `;
  try {
    for(const keyword of ['鼠标','CODE-001','LEGACY-PN','OLD-PN','NEW-PN-1','NEW-PN-2','100%']){
      const rows=await DB.sequelize.query(fixtures+_test.buildTransferProductKeywordCondition(keyword).val,{type:QueryTypes.SELECT});
      assert.deepEqual(rows.map(r=>r.TRANSFER_ID),['T1'],keyword);
    }
    for(const keyword of ['DELETED-PN',"%' OR 1=1 --"]){
      const rows=await DB.sequelize.query(fixtures+_test.buildTransferProductKeywordCondition(keyword).val,{type:QueryTypes.SELECT});
      assert.equal(rows.length,0,keyword);
    }
  } finally { await DB.sequelize.close(); }
});
