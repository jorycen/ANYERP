// Align Care products sold in October with the category dimensions shown in Products.
// Preview by default; --execute records the previous product fields before updating.
const fs = require('fs');
const path = require('path');
const { sequelize, Product, ProductCategory } = require('../src/models');
const { generateUUID } = require('../src/utils');

const execute = process.argv.includes('--execute');
const afterSalesId = '082dda065167485493615bb86db392c8';
const careId = '9885dd85ba234601812cc08b372acf23';
const lecooCode = 'SP05167';
const fields = ['product_id', 'product_code', 'name', 'category_id', 'category_path_legacy',
  'category', 'brand', 'series', 'model', 'processor'];

async function activeChild(parentId, name, transaction) {
  const rows = await ProductCategory.findAll({
    where: { parent_id: parentId, name, status: 1 }, transaction, raw: true
  });
  if (rows.length > 1) throw new Error(`Ambiguous active category: ${parentId}/${name}`);
  return rows[0] || null;
}

async function ensureChild(parentId, name, level, transaction) {
  const existing = await activeChild(parentId, name, transaction);
  if (existing) {
    if (Number(existing.level) !== level) throw new Error(`Wrong level: ${name}`);
    return existing;
  }
  return ProductCategory.create({
    category_id: generateUUID(), parent_id: parentId, name, level,
    sort_order: 0, show_in_finance: 0, status: 1
  }, { transaction });
}

async function main() {
  const [afterSales, care] = await Promise.all([
    ProductCategory.findByPk(afterSalesId, { raw: true }),
    ProductCategory.findByPk(careId, { raw: true })
  ]);
  if (afterSales?.name !== '售后' || care?.name !== 'Care服务'
    || care?.parent_id !== afterSalesId || Number(care?.status) !== 1) {
    throw new Error('The target 售后/Care服务 category changed; stop for review');
  }
  const careProducts = await Product.findAll({
    where: { category: '售后', brand: 'Care服务', is_deleted: 0 }, raw: true
  });
  const lecoo = await Product.findOne({ where: { product_code: lecooCode, is_deleted: 0 }, raw: true });
  if (careProducts.length !== 10 || !lecoo || lecoo.name !== 'Care服务 智惠服务 来酷') {
    throw new Error('Care product set changed; stop for review');
  }
  const plans = careProducts.map(product => {
    if (!['笔记本', '一体机'].includes(product.series)
      || !['智慧', '智臻', '智享'].includes(product.model)) {
      throw new Error(`Unexpected Care dimensions: ${product.product_code}`);
    }
    return { product, categoryPath: `售后/Care服务/${product.series}/${product.model}`,
      dimensions: { category: '售后', brand: 'Care服务', series: product.series, model: product.model } };
  });
  plans.push({ product: lecoo, categoryPath: '售后/Care服务/智惠服务/来酷',
    dimensions: { category: '售后', brand: 'Care服务', series: '智惠服务', model: '来酷' } });
  const changed = plans.filter(plan => plan.product.category_path_legacy !== plan.categoryPath
    || Object.entries(plan.dimensions).some(([key, value]) => plan.product[key] !== value));
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', products: plans.length,
    changed: changed.length, plans: plans.map(plan => ({ productCode: plan.product.product_code,
      before: plan.product.category_path_legacy, after: plan.categoryPath })) }, null, 2));
  if (!execute || changed.length === 0) return;

  const backupPath = path.resolve(__dirname, '../../backup/care-product-categories-before-20261013.json');
  if (fs.existsSync(backupPath)) throw new Error(`Backup already exists: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, JSON.stringify(changed.map(({ product }) =>
    Object.fromEntries(fields.map(field => [field, product[field]]))), null, 2), 'utf8');

  await sequelize.transaction(async transaction => {
    for (const plan of changed) {
      const parts = plan.categoryPath.split('/');
      let parentId = careId;
      for (let index = 2; index < parts.length; index++) {
        const child = await ensureChild(parentId, parts[index], index + 1, transaction);
        parentId = child.category_id;
      }
      const [updated] = await Product.update({
        category_id: parentId, category_path_legacy: plan.categoryPath, ...plan.dimensions
      }, { where: { product_id: plan.product.product_id,
        category_id: plan.product.category_id }, transaction });
      if (updated !== 1) throw new Error(`Product changed while updating: ${plan.product.product_code}`);
    }
  });
  console.log(JSON.stringify({ updatedProducts: changed.length, backupPath }));
}

main().then(() => sequelize.close()).catch(async error => {
  console.error(error.message);
  await sequelize.close();
  process.exitCode = 1;
});
