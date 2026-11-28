const {test}=require('node:test'),a=require('node:assert/strict'),S=require('../src/utils/productSearch'),M=require('../src/models');
test('库存独立字段交集匹配，不把商品名称扩展到编码和配置',()=>{
 const name=S.fieldExpressions(M.sequelize,{productName:'小新'});
 a.match(name,/Product.NAME LIKE/);a.doesNotMatch(name,/CONFIG|MANUFACTURER_CODE|SN_CODE/);
 const config=S.fieldExpressions(M.sequelize,{manufacturerConfig:'16G 512G'});
 a.match(config,/CONFIG LIKE.* AND Product.CONFIG LIKE/);a.doesNotMatch(config,/NAME|REMARK/);
 const code=S.fieldExpressions(M.sequelize,{manufacturerCode:'QX31'});
 a.match(code,/MANUFACTURER_CODE/);a.match(code,/T_PRODUCT_PN/);a.doesNotMatch(code,/\.NAME|\.CONFIG/);
 const all=S.fieldExpressions(M.sequelize,{productName:'小新',manufacturerCode:'QX',manufacturerConfig:'16G'});
 a.match(all,/NAME LIKE.* AND Product.CONFIG LIKE.* AND \(Product.MANUFACTURER_CODE/);
});
test('独立库存筛选转义SQL通配符，SN受授权门店限制',()=>{
 a.match(S.fieldExpressions(M.sequelize,{productName:'100%_!'}),/100!%!_!!/);
 a.match(S.fieldExpressions(M.sequelize,{snCode:'SN'},'p',['STORE']),/STORE_ID IN \('STORE'\)/);
 a.throws(()=>S.fieldExpressions(M.sequelize,{},'p;DROP'),/Invalid/);
});
