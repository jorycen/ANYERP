/**
 * 按商品现有主数据重建商品分类树。
 *
 * 默认只输出归类预览；传入 --apply 才会写入数据库。
 * 归类原则：
 * - 使用现有 CATEGORY/BRAND/SERIES/MODEL 字段，不改商品名称和维度字段；
 * - 配件统一到“电脑配件”；
 * - “其他”只按高置信度名称归类，无法判断的放到“待整理”；
 * - 每个商品最终落到四级叶子节点，保持现有商品分类模型一致；
 * - 保留原分类/商品数据备份表，便于追溯和恢复。
 */

const crypto = require('crypto');
const { sequelize } = require('../src/config/database');

const APPLY = process.argv.includes('--apply');
const TOP_LEVELS = [
  '显示器', '笔记本', '台机', '手机', '平板', '电脑配件',
  '选件', '二手', '售后', 'Care服务', '待整理'
];
const REPLACED_TOP_LEVELS = new Set(['配件', '其他', '选件周边', '笔记本/联想', '二手优品']);

function text(value) {
  return String(value ?? '').trim();
}

function cleanNodeName(value, fallback = '未归类') {
  const normalized = text(value)
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
}

function createId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

function matches(value, patterns) {
  return patterns.some(pattern => pattern.test(value));
}

function classifyOther(product) {
  const value = [product.NAME, product.BRAND, product.SERIES, product.MODEL, product.ACCESSORY_TYPE]
    .map(text)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // 先识别二手和服务，避免被“笔记本/配件”等设备关键词覆盖。
  if (/二手|中古/.test(value)) return '二手';
  if (matches(value, [/维修/, /检测/, /碎屏/, /延保/, /保值换新/, /换新服务/, /服务费/, /服务-/, /板级维修/])) return '售后';
  if (matches(value, [/平板/, /pad\b/, /小新平板/, /yoga tab/])) return '平板';
  if (matches(value, [/手机/, /moto\b/, /razr/, /折叠屏/, /荣耀\d+/, /华为\s*nova/])) return '手机';
  if (matches(value, [/显示器/, /电竞屏/, /曲面屏/, /显示屏/, /monitor\b/, /thinkvision/])) return '显示器';
  if (matches(value, [/清洁套装/, /清洁用品/])) return '选件';

  if (matches(value, [
    /内存/, /固态/, /ssd/, /硬盘/, /闪存盘/, /显卡/, /主板/, /电源/, /机箱/,
    /散热/, /水冷/, /风扇/, /键盘/, /鼠标/, /键鼠/, /耳机/, /充电器/, /适配器/, /拓展坞/, /扩展坞/,
    /支架/, /电脑包/, /网卡/, /网线/, /hdmi/, /高清线/, /u盘/, /内存条/, /电池/, /手写笔/, /电脑配件/,
    /处理器/, /cpu/, /酷睿/
  ])) return '电脑配件';

  // 对“其他”里的整机，只处理名称中有明确设备特征的记录。
  if (matches(value, [
    /笔记本/, /notebook/, /laptop/, /think\s*pad/, /thinkbook/, /ideapad/, /legion/,
    /拯救者/, /y[579]000/, /r[579]000/, /yoga\s*(14|15|16)/, /小新\s*(14|15|16)/,
    /yoga\s*(air|pro|book|\d)/, /小新.*(?:14|15|16)/, /redmibook/, /matebook/, /pavilion/, /g470/, /战7000/,
    /灵越/, /星book/, /魔霸/, /lecco\s*n\d+/, /thinbook/, /联想v\d+/, /lenovo\s*v\d+/, /云电脑/
  ])) return '笔记本';
  if (matches(value, [
    /台机/, /台式/, /一体机/, /aio/, /主机/, /组装机/, /天逸/, /启天/, /扬天/,
    /ideacentre/, /geekpro/, /拯救者刃/, /刃9000/, /小新\s*(24|27|30)/,
    /lecoo.*(?:酷|d)\s*\d+/
  ])) return '台机';

  return '待整理';
}

function normalizeTopLevel(product) {
  const current = text(product.CATEGORY).split('/')[0].trim();
  if (current === '配件' || current === '选件周边') return '电脑配件';
  if (current === '其他' || !current) return classifyOther(product);
  if (current === '笔记本/联想') return '笔记本';
  if (TOP_LEVELS.includes(current)) return current;
  return '待整理';
}

function inferAccessoryType(product) {
  const existingSeries = cleanNodeName(product.SERIES, '');
  if (existingSeries && existingSeries !== '其他') return existingSeries;
  const value = [product.NAME, product.ACCESSORY_TYPE, product.MODEL].map(text).join(' ').toLowerCase();
  const rules = [
    [/键盘|鼠标|键鼠/, '键鼠'],
    [/耳机|音箱|音响|麦克风/, '音频设备'],
    [/固态|ssd|硬盘|u盘|移动存储/, '存储设备'],
    [/内存/, '内存'],
    [/充电器|适配器|电源适配器/, '适配器/充电器'],
    [/支架|拓展坞|扩展坞/, '支架/拓展坞'],
    [/电脑包|手提包|双肩包/, '电脑包'],
    [/显示器|屏幕/, '显示器配件']
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1] || '其他选件';
}

function inferServiceType(product) {
  const value = [product.NAME, product.SERIES, product.MODEL].map(text).join(' ');
  if (/维修|板级/.test(value)) return '维修';
  if (/检测/.test(value)) return '检测';
  if (/碎屏/.test(value)) return '碎屏';
  if (/延保|无忧/.test(value)) return '延保';
  if (/保值换新|换新/.test(value)) return '保值换新';
  return '其他服务';
}

function inferBrand(product, topLevel) {
  const existing = cleanNodeName(product.BRAND, '');
  if (existing && existing !== '其他' && existing !== '通用') return existing;
  const value = [product.NAME, product.SERIES, product.MODEL].map(text).join(' ').toLowerCase();
  if (/来酷|lecoo/.test(value)) return '来酷';
  if (/华硕|asus|天选/.test(value)) return '华硕';
  if (/dell|戴尔/.test(value)) return 'DELL';
  if (/hp\b|惠普|pavilion/.test(value)) return 'HP';
  if (/荣耀/.test(value)) return '荣耀';
  if (/联想|lenovo|think\s*pad|thinkbook|ideapad|ideacentre|legion|拯救者|小新|yoga|geekpro|天逸|启天|扬天|moto/.test(value)) return '联想';
  if (topLevel === '选件' || topLevel === '电脑配件') return '通用';
  return '未归类';
}

function inferSeries(product, topLevel) {
  const existing = cleanNodeName(product.SERIES, '');
  if (existing && existing !== '其他') return existing;
  const value = [product.NAME, product.BRAND, product.MODEL].map(text).join(' ').toLowerCase();
  const rules = [
    [/moto|razr/, 'MOTO'],
    [/拯救者|legion|y[579]000|r[579]000/, '拯救者'],
    [/小新/, '小新'],
    [/yoga/, 'YOGA'],
    [/think\s*pad/, 'ThinkPad'],
    [/thinkbook/, 'ThinkBook'],
    [/ideapad/, 'IdeaPad'],
    [/ideacentre/, 'IdeaCentre'],
    [/geekpro/, 'GeekPro'],
    [/天逸/, '天逸'],
    [/启天|扬天/, '商用台机'],
    [/斗战者|战7000/, '斗战者'],
    [/来酷|lecoo/, '来酷'],
    [/酷\s*\d+/, '酷'],
    [/mini/, 'MINI']
  ];
  if (topLevel === '售后') return inferServiceType(product);
  return rules.find(([pattern]) => pattern.test(value))?.[1] || '未归类';
}

function inferPath(product, topLevel) {
  let brand = inferBrand(product, topLevel);
  let series = inferSeries(product, topLevel);
  const model = cleanNodeName(product.MODEL);

  if (topLevel === '选件') {
    brand = cleanNodeName(product.BRAND, '通用');
    series = inferAccessoryType(product);
  } else if (topLevel === '电脑配件') {
    brand = inferBrand(product, topLevel);
    series = cleanNodeName(product.SERIES, '其他配件');
    if (series === '未归类' || series === '其他') series = inferAccessoryType(product);
  } else if (topLevel === '售后') {
    brand = '服务';
    series = inferServiceType(product);
  } else if (topLevel === 'Care服务') {
    brand = inferBrand(product, topLevel) === '未归类' ? '联想' : inferBrand(product, topLevel);
    series = cleanNodeName(product.SERIES, '服务');
  } else if (topLevel === '待整理') {
    brand = '未归类';
    series = '待人工确认';
  }

  if (brand === '来酷' && series === '来酷') series = '未归类';

  return [topLevel, brand, series, model].map(cleanNodeName);
}

function summarize(rows) {
  const summary = new Map();
  for (const row of rows) {
    const topLevel = normalizeTopLevel(row);
    const path = inferPath(row, topLevel);
    const key = path.join('/');
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  return [...summary.entries()].sort((a, b) => b[1] - a[1]);
}

async function loadProducts() {
  return sequelize.query(
    `SELECT PRODUCT_ID, CATEGORY, CATEGORY_ID, CATEGORY_PATH_LEGACY, NAME, BRAND, SERIES, MODEL, ACCESSORY_TYPE
       FROM T_PRODUCT
      WHERE IS_DELETED = 0
      ORDER BY PRODUCT_ID`,
    { type: sequelize.QueryTypes.SELECT }
  );
}

async function printPreview(products) {
  const summary = summarize(products);
  const topSummary = new Map();
  const pendingSamples = [];
  let pending = 0;
  for (const product of products) {
    const top = normalizeTopLevel(product);
    topSummary.set(top, (topSummary.get(top) || 0) + 1);
    if (top === '待整理') {
      pending += 1;
      if (pendingSamples.length < 120) {
        pendingSamples.push({
          productId: product.PRODUCT_ID,
          category: product.CATEGORY,
          name: product.NAME,
          brand: product.BRAND,
          series: product.SERIES,
          model: product.MODEL
        });
      }
    }
  }
  console.log(JSON.stringify({
    mode: 'preview',
    productCount: products.length,
    topLevelCounts: Object.fromEntries([...topSummary.entries()].sort((a, b) => b[1] - a[1])),
    pendingReviewCount: pending,
    pendingSamples,
    topPaths: summary.slice(0, 80)
  }, null, 2));
}

async function ensureBackupTables(transaction) {
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS T_PRODUCT_CATEGORY_REORG_20260903 AS SELECT * FROM T_PRODUCT_CATEGORY WHERE 1 = 0`,
    { transaction }
  );
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS T_PRODUCT_REORG_20260903 AS SELECT * FROM T_PRODUCT WHERE 1 = 0`,
    { transaction }
  );
  const [categoryCount] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM T_PRODUCT_CATEGORY_REORG_20260903`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  const [productCount] = await sequelize.query(
    `SELECT COUNT(*) AS count FROM T_PRODUCT_REORG_20260903`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  if (Number(categoryCount.count) === 0) {
    await sequelize.query(`INSERT INTO T_PRODUCT_CATEGORY_REORG_20260903 SELECT * FROM T_PRODUCT_CATEGORY`, { transaction });
  }
  if (Number(productCount.count) === 0) {
    await sequelize.query(`INSERT INTO T_PRODUCT_REORG_20260903 SELECT * FROM T_PRODUCT WHERE IS_DELETED = 0`, { transaction });
  }
}

async function getActiveCategories(transaction) {
  return sequelize.query(
    `SELECT CATEGORY_ID, PARENT_ID, NAME, LEVEL, SORT_ORDER, STATUS
       FROM T_PRODUCT_CATEGORY
      WHERE STATUS = 1
      ORDER BY LEVEL, SORT_ORDER, NAME, CATEGORY_ID`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
}

async function createOrGetCategory(parentId, name, level, sortOrder, cache, transaction) {
  const cacheKey = `${parentId || 'ROOT'}\u0000${name}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const [existing] = await sequelize.query(
    `SELECT CATEGORY_ID, NAME FROM T_PRODUCT_CATEGORY
      WHERE STATUS = 1 AND ((PARENT_ID = :parentId) OR (PARENT_ID IS NULL AND :parentId IS NULL)) AND LOWER(NAME) = LOWER(:name)
      ORDER BY CATEGORY_ID LIMIT 1`,
    { replacements: { parentId: parentId || null, name }, transaction, type: sequelize.QueryTypes.SELECT }
  );
  if (existing) {
    if (existing.NAME !== name) {
      await sequelize.query(
        `UPDATE T_PRODUCT_CATEGORY SET NAME = :name WHERE CATEGORY_ID = :categoryId`,
        { replacements: { name, categoryId: existing.CATEGORY_ID }, transaction }
      );
    }
    cache.set(cacheKey, existing.CATEGORY_ID);
    return existing.CATEGORY_ID;
  }
  const categoryId = createId();
  await sequelize.query(
    `INSERT INTO T_PRODUCT_CATEGORY (CATEGORY_ID, PARENT_ID, NAME, LEVEL, SORT_ORDER, STATUS)
     VALUES (:categoryId, :parentId, :name, :level, :sortOrder, 1)`,
    { replacements: { categoryId, parentId: parentId || null, name, level, sortOrder }, transaction }
  );
  cache.set(cacheKey, categoryId);
  return categoryId;
}

async function apply(products) {
  const transaction = await sequelize.transaction();
  try {
    await ensureBackupTables(transaction);

    const active = await getActiveCategories(transaction);
    const rootByName = new Map();
    for (const category of active.filter(item => Number(item.LEVEL) === 1)) {
      if (!rootByName.has(category.NAME)) rootByName.set(category.NAME, category.CATEGORY_ID);
    }

    for (const rootName of TOP_LEVELS) {
      if (!rootByName.has(rootName)) {
        const id = await createOrGetCategory(null, rootName, 1, TOP_LEVELS.indexOf(rootName), rootByName, transaction);
        rootByName.set(rootName, id);
      }
    }

    await sequelize.query(
      `UPDATE T_PRODUCT_CATEGORY SET STATUS = 0 WHERE LEVEL = 1 AND NAME IN (:names) AND STATUS = 1`,
      { replacements: { names: [...REPLACED_TOP_LEVELS] }, transaction }
    );

    const categoryCache = new Map();
    const groups = new Map();
    const categoryPaths = new Map();
    for (const product of products) {
      const topLevel = normalizeTopLevel(product);
      const path = inferPath(product, topLevel);
      const key = path.join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(product.PRODUCT_ID);
      categoryPaths.set(key, path);
    }

    const idByPath = new Map();
    const desiredCategoryIds = new Set();
    for (const [key, path] of categoryPaths.entries()) {
      let parentId = rootByName.get(path[0]);
      if (!parentId) throw new Error(`缺少一级分类：${path[0]}`);
      for (let index = 1; index < path.length; index += 1) {
        parentId = await createOrGetCategory(parentId, path[index], index + 1, index, categoryCache, transaction);
        desiredCategoryIds.add(parentId);
      }
      idByPath.set(key, parentId);
    }

    // 只保留本次真实商品使用到的二级及以下节点，历史空挂节点停用。
    await sequelize.query(
      `UPDATE T_PRODUCT_CATEGORY SET STATUS = 0
        WHERE LEVEL > 1 AND STATUS = 1 AND CATEGORY_ID NOT IN (:categoryIds)`,
      { replacements: { categoryIds: [...desiredCategoryIds] }, transaction }
    );

    const finalCategories = await getActiveCategories(transaction);
    const finalCategoryById = new Map(finalCategories.map(category => [String(category.CATEGORY_ID), category]));
    function resolveFinalPath(categoryId) {
      const parts = [];
      const visited = new Set();
      let currentId = String(categoryId || '');
      while (currentId && finalCategoryById.has(currentId) && !visited.has(currentId)) {
        visited.add(currentId);
        const category = finalCategoryById.get(currentId);
        parts.unshift(String(category.NAME || ''));
        currentId = String(category.PARENT_ID || '');
      }
      return parts;
    }

    // 商品映射使用临时表一次性更新，避免逐分类远程往返导致整理超时。
    await sequelize.query(
      `CREATE TEMPORARY TABLE reorg_product_category_mapping_20260903 (
        PRODUCT_ID VARCHAR(32) NOT NULL PRIMARY KEY,
        CATEGORY_ID VARCHAR(32) NOT NULL,
        CATEGORY VARCHAR(128) NOT NULL,
        CATEGORY_PATH_LEGACY VARCHAR(512) NOT NULL
      )`,
      { transaction }
    );
    const mappingRows = products.map(product => {
      const topLevel = normalizeTopLevel(product);
      const path = inferPath(product, topLevel);
      const key = path.join('/');
      const categoryId = idByPath.get(key);
      const finalPath = resolveFinalPath(categoryId);
      if (finalPath.length !== 4) throw new Error(`分类路径未形成四级：${key}`);
      return [product.PRODUCT_ID, categoryId, finalPath[0], finalPath.join('/')];
    });
    for (let index = 0; index < mappingRows.length; index += 500) {
      const chunk = mappingRows.slice(index, index + 500);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(',');
      await sequelize.query(
        `INSERT INTO reorg_product_category_mapping_20260903
          (PRODUCT_ID, CATEGORY_ID, CATEGORY, CATEGORY_PATH_LEGACY) VALUES ${values}`,
        { replacements: chunk.flat(), transaction }
      );
    }
    await sequelize.query(
      `UPDATE T_PRODUCT p
         INNER JOIN reorg_product_category_mapping_20260903 m ON m.PRODUCT_ID = p.PRODUCT_ID
          SET p.CATEGORY_ID = m.CATEGORY_ID,
              p.CATEGORY = m.CATEGORY,
              p.CATEGORY_PATH_LEGACY = m.CATEGORY_PATH_LEGACY
        WHERE p.IS_DELETED = 0`,
      { transaction }
    );

    await transaction.commit();
    console.log(JSON.stringify({
      mode: 'applied',
      productCount: products.length,
      pathCount: groups.size,
      backupTables: ['T_PRODUCT_CATEGORY_REORG_20260903', 'T_PRODUCT_REORG_20260903']
    }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

(async () => {
  try {
    const products = await loadProducts();
    if (!APPLY) {
      await printPreview(products);
    } else {
      await apply(products);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
