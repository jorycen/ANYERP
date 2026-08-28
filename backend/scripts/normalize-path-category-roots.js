/**
 * 修复历史上把完整分类路径写入 T_PRODUCT_CATEGORY.name 的一级分类。
 *
 * 明确路径会恢复为真实分类树，例如：
 *   笔记本/联想/ThinkPad -> 笔记本 -> 联想 -> ThinkPad
 *
 * 特殊历史数据按商品实际内容处理：
 *   电子产品/笔记本/鼠标垫       -> 选件
 *   电子产品/笔记本/二手七彩虹P15 -> 二手优品
 *   手机/荣耀/500/Legion 27Q-10  -> 选件
 *
 * 默认执行事务迁移；使用 --dry-run 只输出计划并回滚。
 */

const crypto = require('crypto');
const { sequelize, ProductCategory, ProductCategoryField, Product, ProductApplication } = require('../src/models');

const SPECIAL_CATEGORY_RULES = {
  '电子产品/笔记本': [
    { matches: product => String(product.name || '').trim() === '鼠标垫', targetPath: '选件' },
    { matches: product => String(product.name || '').trim() === '二手七彩虹P15', targetPath: '二手优品' }
  ],
  '手机/荣耀/500': [
    { matches: product => String(product.name || '').trim() === '*Legion 27Q-10', targetPath: '选件' }
  ]
};

function generateId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function normalizeSegment(value) {
  return String(value || '').trim();
}

function splitPath(value) {
  return String(value || '')
    .split('/')
    .map(normalizeSegment);
}

function buildCanonicalSegments(sourceName) {
  const raw = splitPath(sourceName);
  const root = raw[0];
  if (!root) return [];

  if (root === '台机' && raw[1] === '') {
    raw.splice(1, 1, '联想');
  }

  return raw.filter(Boolean);
}

function createPlan() {
  return {
    categoryCreates: [],
    categoryUpdates: new Map(),
    fieldUpdates: new Map(),
    applicationCategoryUpdates: new Map(),
    sourceToTarget: [],
    productSpecialUpdates: [],
    normalizedCategoryCount: 0,
    mergedCategoryCount: 0,
    productPathUpdateCount: 0,
    applicationPathUpdateCount: 0
  };
}

function updateCategory(plan, category, patch) {
  Object.assign(category, patch);
  const previous = plan.categoryUpdates.get(category.category_id) || {};
  plan.categoryUpdates.set(category.category_id, { ...previous, ...patch });
}

function activeChildren(categories, parentId) {
  return categories.filter(category => category.parent_id === parentId && Number(category.status) === 1);
}

function categoryPath(categories, categoryId) {
  const byId = new Map(categories.map(category => [category.category_id, category]));
  const parts = [];
  const visited = new Set();
  let current = byId.get(categoryId);
  while (current && !visited.has(current.category_id)) {
    visited.add(current.category_id);
    parts.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return parts.join('/');
}

function findActiveChild(categories, parentId, name, label) {
  const matches = activeChildren(categories, parentId)
    .filter(category => normalizeSegment(category.name) === normalizeSegment(name));
  if (matches.length > 1) {
    throw new Error(`${label}下存在多个启用的“${name}”分类，无法安全合并`);
  }
  return matches[0] || null;
}

function moveActiveSubtree(plan, categories, category, parentId, level) {
  if (level > 4) throw new Error(`分类“${category.name}”迁移后超过四级限制`);
  updateCategory(plan, category, { parent_id: parentId, level });
  for (const child of activeChildren(categories, category.category_id)) {
    moveActiveSubtree(plan, categories, child, category.category_id, level + 1);
  }
}

function reassignFields(plan, fields, sourceId, targetId) {
  const sourceFields = fields.filter(field => field.category_id === sourceId && Number(field.status) === 1);
  const targetFields = fields.filter(field => field.category_id === targetId && Number(field.status) === 1);
  const targetKeys = new Set(targetFields.map(field => normalizeSegment(field.field_key).toLowerCase()));

  for (const field of sourceFields) {
    const key = normalizeSegment(field.field_key).toLowerCase();
    if (targetKeys.has(key)) {
      throw new Error(`分类合并时发现重复字段“${field.field_key}”，源分类 ${sourceId}、目标分类 ${targetId}`);
    }
    targetKeys.add(key);
    field.category_id = targetId;
    plan.fieldUpdates.set(field.field_id, targetId);
  }
}

function mergeSourceIntoTarget(plan, categories, fields, applications, source, target) {
  reassignFields(plan, fields, source.category_id, target.category_id);

  for (const application of applications.filter(item => item.category_id === source.category_id)) {
    application.category_id = target.category_id;
    plan.applicationCategoryUpdates.set(application.application_id, target.category_id);
  }

  const sourceChildren = activeChildren(categories, source.category_id);
  if (sourceChildren.length > 0) {
    throw new Error(`路径型一级分类“${source.name}”仍有启用子分类，已停止以避免改变未知层级`);
  }

  updateCategory(plan, source, { status: 0 });
  plan.mergedCategoryCount += 1;
}

function ensurePath(plan, categories, root, segments) {
  let parent = root;
  for (const segment of segments) {
    let child = findActiveChild(categories, parent.category_id, segment, `分类“${categoryPath(categories, parent.category_id)}”`);
    if (!child) {
      child = {
        category_id: generateId(),
        parent_id: parent.category_id,
        name: segment,
        level: Number(parent.level) + 1,
        sort_order: Math.max(0, ...activeChildren(categories, parent.category_id).map(item => Number(item.sort_order) || 0)) + 1,
        show_in_finance: 0,
        status: 1
      };
      if (child.level > 4) throw new Error(`路径“${segments.join('/')}”超过四级限制`);
      categories.push(child);
      plan.categoryCreates.push(child);
    }
    parent = child;
  }
  return parent;
}

function buildPlan(categories, fields, applications) {
  const plan = createPlan();
  const activeRoots = new Map(
    categories
      .filter(category => category.parent_id === null && Number(category.level) === 1 && Number(category.status) === 1)
      .map(category => [normalizeSegment(category.name), category])
  );

  const malformedRoots = categories.filter(category => (
    category.parent_id === null &&
    Number(category.level) === 1 &&
    Number(category.status) === 1 &&
    String(category.name || '').includes('/')
  ));

  for (const source of malformedRoots) {
    const sourceName = String(source.name || '');
    if (SPECIAL_CATEGORY_RULES[sourceName]) {
      const sourceFields = fields.filter(field => field.category_id === source.category_id && Number(field.status) === 1);
      if (sourceFields.length > 0) {
        throw new Error(`特殊路径型一级分类“${sourceName}”仍有字段配置，无法在商品级拆分后安全停用`);
      }
      if (activeChildren(categories, source.category_id).length > 0) {
        throw new Error(`特殊路径型一级分类“${sourceName}”仍有启用子分类，无法安全停用`);
      }
      updateCategory(plan, source, { status: 0 });
      plan.normalizedCategoryCount += 1;
      continue;
    }

    const segments = buildCanonicalSegments(sourceName);
    const root = activeRoots.get(segments[0]);
    if (!root || segments.length < 2) {
      throw new Error(`路径型一级分类“${sourceName}”找不到对应的启用一级分类`);
    }

    const target = ensurePath(plan, categories, root, segments.slice(1));
    const targetPath = categoryPath(categories, target.category_id);
    plan.sourceToTarget.push({ source, target, sourceName, targetPath });
    if (source.category_id === target.category_id) continue;

    if (target.level !== segments.length) {
      throw new Error(`目标分类“${targetPath}”层级异常，期望${segments.length}级，实际${target.level}级`);
    }
    mergeSourceIntoTarget(plan, categories, fields, applications, source, target);
    plan.normalizedCategoryCount += 1;
  }

  return plan;
}

async function loadState(transaction) {
  const options = { raw: true, transaction };
  if (transaction) options.lock = transaction.LOCK.UPDATE;
  const [categories, fields, applications, products] = await Promise.all([
    ProductCategory.findAll(options),
    ProductCategoryField.findAll(options),
    ProductApplication.findAll({ ...options, attributes: ['application_id', 'category_id', 'category_name'] }),
    Product.findAll({ ...options, attributes: ['product_id', 'name', 'category'] })
  ]);
  return { categories, fields, applications, products };
}

async function countExact(model, column, value, transaction) {
  const table = model.getTableName();
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${column}\` = ?`,
    { replacements: [value], transaction }
  );
  return Number(rows[0]?.count || 0);
}

async function rewriteExact(model, column, sourceValue, targetValue, transaction) {
  if (sourceValue === targetValue) return 0;
  const count = await countExact(model, column, sourceValue, transaction);
  if (count === 0) return 0;
  const table = model.getTableName();
  await sequelize.query(
    `UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`,
    { replacements: [targetValue, sourceValue], transaction }
  );
  return count;
}

function resolveSpecialProductTarget(product) {
  const rules = SPECIAL_CATEGORY_RULES[product.category] || [];
  return rules.find(rule => rule.matches(product))?.targetPath || null;
}

function printPlan(plan, specialUpdates) {
  console.log(JSON.stringify({
    normalizedCategoryCount: plan.normalizedCategoryCount,
    createdCategoryCount: plan.categoryCreates.length,
    mergedCategoryCount: plan.mergedCategoryCount,
    fieldReassignCount: plan.fieldUpdates.size,
    applicationCategoryRefCount: plan.applicationCategoryUpdates.size,
    specialProductUpdates: specialUpdates,
    pathMappings: plan.sourceToTarget.map(item => ({ from: item.sourceName, to: item.targetPath }))
  }, null, 2));
}

async function applyPlan(plan, products, applications, transaction) {
  for (const category of plan.categoryCreates) {
    await ProductCategory.create(category, { transaction });
  }
  for (const [categoryId, patch] of plan.categoryUpdates) {
    await ProductCategory.update(patch, { where: { category_id: categoryId }, transaction });
  }
  for (const [fieldId, categoryId] of plan.fieldUpdates) {
    await ProductCategoryField.update({ category_id: categoryId }, { where: { field_id: fieldId }, transaction });
  }
  for (const [applicationId, categoryId] of plan.applicationCategoryUpdates) {
    await ProductApplication.update({ category_id: categoryId }, { where: { application_id: applicationId }, transaction });
  }

  let productPathUpdateCount = 0;
  let applicationPathUpdateCount = 0;
  for (const mapping of plan.sourceToTarget) {
    productPathUpdateCount += await rewriteExact(Product, 'CATEGORY', mapping.sourceName, mapping.targetPath, transaction);
    applicationPathUpdateCount += await rewriteExact(ProductApplication, 'CATEGORY_NAME', mapping.sourceName, mapping.targetPath, transaction);
  }

  const specialUpdates = [];
  for (const product of products) {
    const targetPath = resolveSpecialProductTarget(product);
    if (!targetPath) continue;
    specialUpdates.push({ productId: product.product_id, productName: product.name, from: product.category, to: targetPath });
    await Product.update(
      { category: targetPath },
      { where: { product_id: product.product_id }, transaction }
    );
  }

  for (const application of applications) {
    const rules = SPECIAL_CATEGORY_RULES[application.category_name] || [];
    if (rules.length > 0) {
      throw new Error(`商品申请“${application.application_id}”仍使用需要商品级匹配的特殊分类，已停止迁移`);
    }
  }

  return { productPathUpdateCount, applicationPathUpdateCount, specialUpdates };
}

async function ensureNoSpecialSourceProducts(products, applications) {
  const specialProductIds = new Set();
  for (const product of products) {
    if (SPECIAL_CATEGORY_RULES[product.category] && !resolveSpecialProductTarget(product)) {
      throw new Error(`特殊分类“${product.category}”下的商品“${product.name}”没有明确匹配规则`);
    }
    if (resolveSpecialProductTarget(product)) specialProductIds.add(product.product_id);
  }
  for (const application of applications) {
    if (SPECIAL_CATEGORY_RULES[application.category_name]) {
      throw new Error(`商品申请“${application.application_id}”使用特殊分类，无法仅凭商品申请快照安全重新匹配`);
    }
  }
  return specialProductIds;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const transaction = await sequelize.transaction();
  try {
    const { categories, fields, applications, products } = await loadState(transaction);
    const specialProductIds = await ensureNoSpecialSourceProducts(products, applications);
    const plan = buildPlan(categories, fields, applications);
    const specialUpdates = products
      .filter(product => specialProductIds.has(product.product_id))
      .map(product => ({ productId: product.product_id, productName: product.name, from: product.category, to: resolveSpecialProductTarget(product) }));
    printPlan(plan, specialUpdates);

    if (dryRun) {
      await transaction.rollback();
      console.log('Dry run complete; no data was changed.');
      return;
    }

    const result = await applyPlan(plan, products, applications, transaction);
    await transaction.commit();
    console.log(JSON.stringify({ ...result, message: 'Path category root normalization committed.' }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

main()
  .catch(error => {
    console.error(`Path category root normalization failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
