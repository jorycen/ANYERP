const test=require('node:test'),assert=require('node:assert/strict');
const {selectedPaths,aggregateFocusCategories}=require('../src/modules/report/focusCategorySales');
test('focus category sales includes all descendants but never a similar-name sibling',()=>{
 const rows=[{categoryPath:'笔记本/联想/拯救者/Y7000',quantity:2,salesAmount:12000},
 {categoryPath:'笔记本/联想/拯救者/Y9000',quantity:1,salesAmount:9000},
 {categoryPath:'笔记本/联想/拯救者配件',quantity:10,salesAmount:100}];
 const result=aggregateFocusCategories(rows,['笔记本/联想/拯救者','笔记本/联想/拯救者/Y7000','平板/无销量']);
 assert.equal(result[0].quantity,3);assert.equal(result[0].salesAmount,21000);assert.equal(result[0].unit,'台');
 assert.equal(result[1].quantity,2);assert.equal(result[2].quantity,0);assert.equal(result[2].salesAmount,0);
});
test('category paths are validated, deduplicated and retain signed source values',()=>{
 assert.deepEqual(selectedPaths('["A/B","A/B"]'),['A/B']);assert.throws(()=>selectedPaths('A/B'));assert.throws(()=>selectedPaths(Array(51).fill('A')));
 const result=aggregateFocusCategories([{categoryPath:'A/B',quantity:2,salesAmount:20.12},{categoryPath:'A/B',quantity:-1,salesAmount:-10.11}],['A']);
 assert.equal(result[0].quantity,1);assert.equal(result[0].salesAmount,10.01);
});
