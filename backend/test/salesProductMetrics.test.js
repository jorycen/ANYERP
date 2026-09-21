const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _test } = require('../src/modules/report/controller');

test('销售报表按产品分类汇总三种毛利', () => {
  const result = _test.aggregateProductSalesMetrics([
    {
      category: '电脑', categoryPath: '电脑 / 笔记本', brand: '品牌A', series: '系列1', model: '型号1',
      quantity: 2, salesAmount: 10000, salesGrossProfit: 1500, productGrossProfit: 900, financialGrossProfit: 800
    },
    {
      category: '电脑', categoryPath: '电脑 / 笔记本', brand: '品牌A', series: '系列1', model: '型号1',
      quantity: 1, salesAmount: 5000, salesGrossProfit: 700, productGrossProfit: 400, financialGrossProfit: 350
    }
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    category: '电脑', categoryPath: '电脑 / 笔记本', brand: '品牌A', series: '系列1', model: '型号1',
    itemCount: 2, totalQuantity: 3, totalAmount: 15000, salesGrossProfit: 2200,
    productGrossProfit: 1300, financialGrossProfit: 1150,
    productGrossProfitPendingCount: 0, financialGrossProfitPendingCount: 0
  });
});

test('产品端或财务成本缺失时不以零毛利展示', () => {
  const [row] = _test.aggregateProductSalesMetrics([{
    category: '手机', categoryPath: '手机', brand: '品牌B', series: '系列2', model: '型号2',
    quantity: 1, salesAmount: 3000, salesGrossProfit: 300, productGrossProfit: null, financialGrossProfit: null
  }]);

  assert.equal(row.productGrossProfit, null);
  assert.equal(row.financialGrossProfit, null);
  assert.equal(row.productGrossProfitPendingCount, 1);
  assert.equal(row.financialGrossProfitPendingCount, 1);
});

test('销售报表页面展示分类、销售和三类毛利列', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../frontend/web/src/views/Reports.vue'), 'utf8');
  assert.match(view, /prop="categoryPath" label="商品分类"/);
  assert.match(view, /label="销售数量"/);
  assert.match(view, /label="销售额"/);
  assert.match(view, /label="销售毛利"/);
  assert.match(view, /label="产品端毛利"/);
  assert.match(view, /label="财务毛利"/);
});
