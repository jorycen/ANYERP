/**
 * 将笔记本、平板、手机下的商品分类统一整理为：
 *   一级 / 联想 / 原二级 / 原三级
 *
 * 该脚本只迁移分类树和可以从旧完整路径确定的新路径，不根据商品名称猜测
 * 商品所属的三级/四级分类。默认执行事务迁移，使用 --dry-run 只输出计划并回滚。
 */

const crypto = require('crypto');
const {
  sequelize,
  ProductCategory,
  ProductCategoryField,
  Product,
  ProductApplication
} = require('../src/models');

const ROOT_NAMES = ['笔记本', '平板', '手机'];
const LENOVO_NAME = '联想';

function generateId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function sameName(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

function createPlan() {
  return {
    categoryCreates: [],
    categoryUpdates: new Map(),
    fieldUpdates: new Map(),
    applicationCategoryUpdates: new Map(),
    categoryPathRewrites: [],
    mergeCount: 0,
    movedCategoryCount: 0,
    reparentedDescendantCount: 0,
    createdLenovoCount: 0
  };
}

function setCategory(plan, category, patch) {
  Object.assign(category, patch);
  const previous = plan.categoryUpdates.get(category.category_id) || {};
  plan.categoryUpdates.set(category.category_id, { ...previous, ...patch });
}

function setFieldCategory(plan, field, categoryId) {
  field.category_id = categoryId;
  plan.fieldUpdates.set(field.field_id, categoryId);
}

function setApplicationCategory(plan, application, categoryId) {
  application.category_id = categoryId;
  plan.applicationCategoryUpdates.set(application.application_id, categoryId);
}

function descendants(categories, parentId) {
  return categories.filter(category => category.parent_id === parentId);
}

function activeChildren(categories, parentId) {
  return descendants(categories, parentId).filter(category => Number(category.status) === 1);
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

function findSingleActiveChild(categories, parentId, name, label) {
  const matches = activeChildren(categories, parentId).filter(category => sameName(category.name, name));
  if (matches.length > 1) {
    throw new Error(`${label}存在多个启用的“${name}”分类，无法安全迁移`);
  }
  return matches[0] || null;
}

function mergeFields(plan, fields, sourceId, targetId) {
  const sourceFields = fields.filter(field => field.category_id === sourceId && Number(field.status) === 1);
  const targetFields = fields.filter(field => field.category_id === targetId && Number(field.status) === 1);
  const targetKeys = new Set(targetFields.map(field => String(field.field_key || '').trim().toLowerCase()));

  for (const field of sourceFields) {
    const key = String(field.field_key || '').trim().toLowerCase();
    if (targetKeys.has(key)) {
      throw new Error(`合并分类时发现重复字段标识“${field.field_key}”，源分类 ${sourceId}、目标分类 ${targetId}`);
    }
    targetKeys.add(key);
    setFieldCategory(plan, field, targetId);
  }
}

function moveSubtree(plan, categories, category, parentId, level) {
  const nextLevel = Number(level);
  if (nextLevel > 4) {
    throw new Error(`分类“${category.name}”迁移后超过四级限制`);
  }

  setCategory(plan, category, { parent_id: parentId, level: nextLevel });
  plan.reparentedDescendantCount += 1;

  for (const child of activeChildren(categories, category.category_id)) {
    moveSubtree(plan, categories, child, category.category_id, nextLevel + 1);
  }
}

function mergeCategory(plan, categories, fields, applications, source, target, targetLevel) {
  if (source.category_id === target.category_id) return;
  if (Number(target.level) !== Number(targetLevel)) {
    throw new Error(`目标分类“${target.name}”层级异常，期望${targetLevel}级，实际${target.level}级`);
  }

  mergeFields(plan, fields, source.category_id, target.category_id);

  for (const application of applications.filter(item => item.category_id === source.category_id)) {
    setApplicationCategory(plan, application, target.category_id);
  }

  for (const child of activeChildren(categories, source.category_id)) {
    const existing = findSingleActiveChild(
      categories,
      target.category_id,
      child.name,
      `目标分类“${categoryPath(categories, target.category_id)}”`
    );

    if (existing && existing.category_id !== child.category_id) {
      mergeCategory(plan, categories, fields, applications, child, existing, targetLevel + 1);
    } else {
      moveSubtree(plan, categories, child, target.category_id, targetLevel + 1);
    }
  }

  setCategory(plan, source, { status: 0 });
  plan.mergeCount += 1;
}

function addPathRewrite(plan, rootName, sourceName) {
  const oldPrefix = `${rootName}/${sourceName}`;
  const newPrefix = `${rootName}/${LENOVO_NAME}/${sourceName}`;
  plan.categoryPathRewrites.push({ oldPrefix, newPrefix });
}

function buildPlan(categories, fields, applications) {
  const plan = createPlan();
  const activeRoots = ROOT_NAMES.map(name => {
    const matches = categories.filter(category => (
      Number(category.status) === 1 &&
      Number(category.level) === 1 &&
      category.parent_id === null &&
      sameName(category.name, name)
    ));
    if (matches.length !== 1) {
      throw new Error(`一级分类“${name}”应有且只能有一个启用根节点，实际${matches.length}个`);
    }
    return matches[0];
  });

  for (const root of activeRoots) {
    let lenovo = findSingleActiveChild(categories, root.category_id, LENOVO_NAME, `一级分类“${root.name}”`);
    if (!lenovo) {
      lenovo = {
        category_id: generateId(),
        parent_id: root.category_id,
        name: LENOVO_NAME,
        level: 2,
        sort_order: Math.max(0, ...activeChildren(categories, root.category_id).map(item => Number(item.sort_order) || 0)) + 1,
        show_in_finance: 0,
        status: 1
      };
      categories.push(lenovo);
      plan.categoryCreates.push(lenovo);
      plan.createdLenovoCount += 1;
    }

    const sources = activeChildren(categories, root.category_id)
      .filter(category => category.category_id !== lenovo.category_id);

    for (const source of sources) {
      addPathRewrite(plan, root.name, source.name);
      const existing = findSingleActiveChild(
        categories,
        lenovo.category_id,
        source.name,
        `联想分类“${root.name}/${LENOVO_NAME}”`
      );

      if (existing && existing.category_id !== source.category_id) {
        mergeCategory(plan, categories, fields, applications, source, existing, 3);
      } else {
        moveSubtree(plan, categories, source, lenovo.category_id, 3);
        plan.movedCategoryCount += 1;
      }
    }
  }

  return plan;
}

async function loadState(transaction) {
  const options = { raw: true, transaction };
  if (transaction) options.lock = transaction.LOCK.UPDATE;

  const [categories, fields, applications] = await Promise.all([
    ProductCategory.findAll(options),
    ProductCategoryField.findAll(options),
    ProductApplication.findAll({ ...options, attributes: ['application_id', 'category_id', 'category_name'] })
  ]);

  return { categories, fields, applications };
}

async function countPathRows(model, column, rewrite, transaction) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM ${model.getTableName()} WHERE ${column} = ? OR ${column} LIKE ?`,
    {
      replacements: [rewrite.oldPrefix, `${rewrite.oldPrefix}/%`],
      transaction
    }
  );
  return Number(rows[0]?.count || 0);
}

async function rewritePaths(model, column, rewrites, transaction) {
  let updated = 0;
  for (const rewrite of rewrites) {
    const count = await countPathRows(model, column, rewrite, transaction);
    if (count === 0) continue;

    await sequelize.query(
      `UPDATE ${model.getTableName()}
       SET ${column} = CONCAT(?, SUBSTRING(${column}, CHAR_LENGTH(?) + 1))
       WHERE ${column} = ? OR ${column} LIKE ?`,
      {
        replacements: [rewrite.newPrefix, rewrite.oldPrefix, rewrite.oldPrefix, `${rewrite.oldPrefix}/%`],
        transaction
      }
    );
    updated += count;
  }
  return updated;
}

async function applyPlan(plan, categories, fields, applications, transaction) {
  for (const category of plan.categoryCreates) {
    await ProductCategory.create(category, { transaction });
  }

  for (const [categoryId, patch] of plan.categoryUpdates) {
    await ProductCategory.update(patch, { where: { category_id: categoryId }, transaction });
  }

  for (const [fieldId, categoryId] of plan.fieldUpdates) {
    await ProductCategoryField.update(
      { category_id: categoryId },
      { where: { field_id: fieldId }, transaction }
    );
  }

  for (const [applicationId, categoryId] of plan.applicationCategoryUpdates) {
    await ProductApplication.update(
      { category_id: categoryId },
      { where: { application_id: applicationId }, transaction }
    );
  }

  const productPathsUpdated = await rewritePaths(Product, 'CATEGORY', plan.categoryPathRewrites, transaction);
  const applicationPathsUpdated = await rewritePaths(
    ProductApplication,
    'CATEGORY_NAME',
    plan.categoryPathRewrites,
    transaction
  );

  return { productPathsUpdated, applicationPathsUpdated };
}

function printPlan(plan) {
  console.log(JSON.stringify({
    createdLenovoCount: plan.createdLenovoCount,
    movedCategoryCount: plan.movedCategoryCount,
    reparentedDescendantCount: plan.reparentedDescendantCount,
    mergedCategoryCount: plan.mergeCount,
    fieldReassignCount: plan.fieldUpdates.size,
    applicationCategoryRefCount: plan.applicationCategoryUpdates.size,
    pathRewrites: plan.categoryPathRewrites
  }, null, 2));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const transaction = await sequelize.transaction();

  try {
    const { categories, fields, applications } = await loadState(transaction);
    const plan = buildPlan(categories, fields, applications);
    printPlan(plan);

    if (dryRun) {
      await transaction.rollback();
      console.log('Dry run complete; no data was changed.');
      return;
    }

    const result = await applyPlan(plan, categories, fields, applications, transaction);
    await transaction.commit();
    console.log(JSON.stringify({ ...result, message: 'Lenovo category migration committed.' }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

main()
  .catch(error => {
    console.error(`Lenovo category migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
