
const { createHash, randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const M = require('../../models');
const { getUserRoles, isDealerAccount } = require('../../middleware/permission');
const { canAccessDistributor } = require('../../utils/distributorScope');
const approval = require('../approval/service');
const metrics = ['sales', 'profit', 'quantity', 'management'];
const active = { status: 1, is_deleted: 0 };
const key = value => String(value ?? '');
const idsFrom = values => [...new Set(Array.isArray(values) ? values.map(value => key(value).trim()).filter(Boolean) : [])];
const nowMonth = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const result = (ctx, data) => { ctx.body = { code: 0, data }; };
const {groupedOverview,groupKey}=require('./monthlyIndicatorOverview');

function month(ctx, value = nowMonth()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) ctx.throw(400, '请选择有效月份');
  return value;
}

function target(ctx, value, metric, label = '目标值') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e12 ||
      (['quantity', 'management'].includes(metric) ? !Number.isInteger(number) :
        Math.abs(number * 100 - Math.round(number * 100)) > 0.001)) {
    ctx.throw(400, `${label}须为${['quantity', 'management'].includes(metric) ? '正整数' : '大于 0 且最多两位小数的金额'}，且不能超过 1 万亿`);
  }
  return number;
}

async function storesFor(user) {
  const stores = await M.Store.findAll({
    where: active, attributes: ['store_id', 'name', 'distributor_id', 'manager_staff_id'], raw: true
  });
  return stores.filter(store => canAccessDistributor(user, store.distributor_id));
}

function permissions(user, store) {
  return { company: isDealerAccount(user) && ['boss', 'admin', 'distributor'].some(role =>
    getUserRoles(user).includes(role)),
    manager: !!user.staffId && key(store.manager_staff_id) === key(user.staffId) };
}

function definitionStores(definition, stores) {
  return stores.filter(store => key(store.distributor_id) === key(definition.distributor_id) &&
    (definition.source === 'company' ? store.company : store.manager && key(store.store_id) === key(definition.store_id)));
}

async function saveDefinition(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  const stores = (await storesFor(user)).map(store => ({ ...store, ...permissions(user, store) }));
  const id = ctx.params?.definitionId;
  await M.sequelize.transaction(async transaction => {
    const current = id ? await M.MonthlyIndicatorDefinition.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (id && !current) ctx.throw(404, '指标定义不存在');
    const scope = current || { source: body.source, distributor_id: key(body.distributorId),
      store_id: body.source === 'store' ? key(body.storeId) : null };
    if (!['company', 'store'].includes(scope.source) || !definitionStores(scope, stores).length) ctx.throw(403, '无权维护该范围的指标定义');
    if (body.disable === true) {
      if (!current) ctx.throw(400, '请先保存指标定义');
      await current.update({ status: 0 }, { transaction });
      return;
    }
    const name = key(body.name).trim();
    const roleCodes = idsFrom(body.roleCodes);
    const categoryIds = idsFrom(body.categoryIds);
    const requirements = key(body.requirements).trim();
    const kind = body.kind;
    if(current?.config?.legacyGrossProfit&&(kind!=='operating'||categoryIds.length||idsFrom(body.metrics).join(',')!=='profit'))ctx.throw(400,'迁移的主毛利指标保持全商品毛利口径，请另建其他范围指标');
    if (!name || name.length > 128) ctx.throw(400, '请填写指标名称，最多 128 字');
    if (!roleCodes.length || roleCodes.some(code => code.length > 32) ||
        await M.Role.count({ where: { role_code: roleCodes, status: 1 }, transaction }) !== roleCodes.length) ctx.throw(400, '请选择有效的适用岗位');
    const allowed = idsFrom(body.metrics);
    if (['operating','ability'].includes(kind)) {
      if (!allowed.length || allowed.some(metric => !metrics.slice(0, 3).includes(metric))) ctx.throw(400, '请选择至少一个经营考核项');
      if (kind==='operating' && !current?.config?.allProducts && (!categoryIds.length || await M.ProductCategory.count({ where: { category_id: categoryIds, status: 1 }, transaction }) !== categoryIds.length)) {
        ctx.throw(400, '请选择有效的商品分类');
      }
    } else if (kind !== 'management' || !['photo', 'text'].includes(body.checkMethod) || requirements.length > 1000) {
      ctx.throw(400, '请选择管理指标检查方式，检查要求最多 1000 字');
    }
    if(kind==='ability'&&(!['overdue','special','source'].includes(body.abilityType)||
      (body.abilityType==='source'&&!idsFrom(body.customerSources).length)))ctx.throw(400,'请选择销售能力范围及客户来源');
    if(kind==='ability'&&body.abilityType==='source'&&await M.CustomerSource.count({where:{status:1,level:1,name:idsFrom(body.customerSources)},transaction})!==idsFrom(body.customerSources).length)ctx.throw(400,'客户来源无效，请重新选择');
    const config = { kind, roleCodes, categoryIds: kind === 'operating' ? categoryIds : [],allProducts:!!current?.config?.allProducts,legacyGrossProfit:!!current?.config?.legacyGrossProfit,
      abilityType:kind==='ability'?body.abilityType:null,customerSources:kind==='ability'?idsFrom(body.customerSources):[],
      metrics: kind !== 'management' ? allowed : ['management'],
      checkMethod: kind === 'management' ? body.checkMethod : null, requirements: kind === 'management' ? requirements : '' };
    if (current) await current.update({ name, config, status: 1 }, { transaction });
    else await M.MonthlyIndicatorDefinition.create({ ...scope, definition_id: randomUUID(), name, config }, { transaction });
  });
  result(ctx, {});
}

function indicatorOverview(indicators, assignments, stores, query) {
  const byIndicator = new Map();
  for (const assignment of assignments) {
    if (!byIndicator.has(assignment.indicator_id)) byIndicator.set(assignment.indicator_id, []);
    byIndicator.get(assignment.indicator_id).push(assignment);
  }
  const groups = new Map();
  const storesById = new Map(stores.map(store => [store.store_id, store]));
  for (const row of indicators) {
    const kind = row.scope_config?.kind || (row.metric === 'management' ? 'management' : 'operating');
    if ((query.storeId && row.store_id !== query.storeId) || (query.source && row.source !== query.source) ||
        (query.kind && kind !== query.kind)) continue;
    if(row.status<0)continue;
    const id = `${groupKey(row)}:${row.store_id}`;
    const store = storesById.get(row.store_id);
    const group = groups.get(id) || { id, releaseId: row.release_id, indicatorId: row.indicator_id,
      name: row.name, source: row.source, kind, storeId: row.store_id, storeName: store?.name,
      metrics: [], people: new Set(), active: false };
    const people = byIndicator.get(row.indicator_id) || [];
    for (const person of people) group.people.add(key(person.staff_id));
    group.active ||= !!row.status;
    group.metrics.push({ ...row, allocated: people.reduce((sum, person) => sum + Math.round(Number(person.target) * 100), 0) / 100,
      assignedCount: people.length });
    groups.set(id, group);
  }
  return [...groups.values()].map(({ people, ...group }) => {
    const activeMetrics = group.metrics.filter(metric => metric.status);
    const allocationStatus = !activeMetrics.length ? 'disabled' : activeMetrics.every(metric => metric.allocated >= Number(metric.target))
      ? 'assigned' : activeMetrics.some(metric => metric.assignedCount) ? 'partial' : 'unassigned';
    return { ...group, assignedPeople: people.size, allocationStatus };
  }).filter(row => !query.allocationStatus || row.allocationStatus === query.allocationStatus);
}

async function setup(ctx) {
  const user = ctx.state.user;
  const monthKey = month(ctx, ctx.query.monthKey);
  const stores = (await storesFor(user)).map(store => ({ ...store, ...permissions(user, store) }))
    .filter(store => store.company || store.manager);
  const ids = stores.map(store => store.store_id);
  const [indicators, staff, roles] = await Promise.all([
    M.MonthlyIndicator.findAll({ where: { month_key: monthKey, store_id: ids },
      order: [['name', 'ASC'], ['store_id', 'ASC'], ['metric', 'ASC']], raw: true }),
    M.Staff.findAll({ where: { ...active, [Op.or]: [{ store_id: ids }, { staff_id: stores.map(store => store.manager_staff_id).filter(Boolean) }] },
      attributes: ['staff_id', 'store_id', 'name', 'role_code'], raw: true }),
    ids.length ? M.Role.findAll({ where: { status: 1 }, attributes: ['role_code', 'name'], order: [['name', 'ASC']], raw: true }) : []
  ]);
  const assignments = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: indicators.filter(r=>r.status>=0).map(row => row.indicator_id) }, raw: true });
  const definitions = ids.length ? await M.MonthlyIndicatorDefinition.findAll({
    where: { distributor_id: [...new Set(stores.map(store => store.distributor_id))] }, order: [['name', 'ASC']], raw: true
  }) : [];
  const distributors = ids.length ? await M.Distributor.findAll({ where: { distributor_id: [...new Set(stores.map(store => store.distributor_id))] },
    attributes: ['distributor_id', 'name'], raw: true }) : [];
  const plans=await M.MonthlyIndicatorPlan.findAll({where:{month_key:monthKey},raw:true});
  const customerSources=await M.CustomerSource.findAll({where:{status:1,level:1},attributes:['source_id','name'],raw:true});
  const overview=indicatorOverview(indicators, assignments, stores, ctx.query);
  let grouped=groupedOverview(overview,plans,stores,definitions,indicators);
  grouped=grouped.filter(g=>(!ctx.query.source||g.source===ctx.query.source)&&(!ctx.query.kind||g.kind===ctx.query.kind)&&(!ctx.query.storeId||g.stores.some(s=>s.storeId===ctx.query.storeId))&&(!ctx.query.allocationStatus||g.stores.length));
  result(ctx, { stores, staff, roles, indicators:indicators.filter(r=>r.status>=0), assignments, distributors,customerSources,plans:plans.filter(p=>definitions.some(d=>d.definition_id===p.definition_id&&definitionStores(d,stores).length)),overview,groupedOverview:grouped,
    definitions: definitions.map(definition => ({
      ...definition, publishStoreIds: definitionStores(definition, stores).map(store => store.store_id)
    })).filter(definition => definition.publishStoreIds.length) });
}

async function create(ctx) {
  const body = ctx.request.body || {};
  if (!body.definitionId) return createTargets(ctx, body);
  await M.sequelize.transaction(async transaction => {
    const definition = await M.MonthlyIndicatorDefinition.findByPk(body.definitionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!definition?.status) ctx.throw(404, '指标定义不存在或已停用');
    const stores = (await storesFor(ctx.state.user)).map(store => ({ ...store, ...permissions(ctx.state.user, store) }));
    const allowedStores = new Set(definitionStores(definition, stores).map(store => key(store.store_id)));
    const storeTargets = Array.isArray(body.storeTargets) ? body.storeTargets : [];
    if (!storeTargets.length || storeTargets.some(row => !allowedStores.has(key(row?.storeId)))) ctx.throw(403, '请选择指标允许下发的门店');
    const monthKey = month(ctx, body.monthKey);
    const duplicate = await M.MonthlyIndicator.findOne({ where: { month_key: monthKey, definition_id: definition.definition_id,
      store_id: storeTargets.map(row => row.storeId), status: 1 }, transaction });
    if (duplicate) ctx.throw(409, '所选门店本月已有此指标，请在总览查看');
    const published=await M.MonthlyIndicator.findAll({where:{month_key:monthKey,definition_id:definition.definition_id,status:1},transaction});
    const sorted=values=>JSON.stringify([...(values||[])].sort());
    if(published.some(r=>sorted(r.category_ids)!==sorted(definition.config.categoryIds)||
      sorted(r.role_codes||[r.role_code])!==sorted(definition.config.roleCodes)||
      (r.scope_config?.kind||(r.metric==='management'?'management':'operating'))!==definition.config.kind||
      (r.scope_config?.abilityType||null)!==(definition.config.abilityType||null)||
      sorted(r.scope_config?.customerSources)!==sorted(definition.config.customerSources)))ctx.throw(409,'本月指标口径已冻结，新增门店须沿用原口径，或新建指标定义');
    const plan=await M.MonthlyIndicatorPlan.findOne({where:{definition_id:definition.definition_id,month_key:monthKey},transaction,lock:transaction.LOCK.UPDATE});
    if(!plan||!plan.status){
      const companyTargets={};
      for(const metric of definition.config.metrics){
        const fallback=storeTargets.reduce((n,p)=>n+Number(p[metric]||0),0);
        if(body.companyTargets?.[metric]!==undefined||fallback>0)companyTargets[metric]=target(ctx,body.companyTargets?.[metric]??fallback,metric,'公司总目标');
      }
      if(plan)await plan.update({company_targets:companyTargets,status:1},{transaction});
      else await M.MonthlyIndicatorPlan.create({plan_id:randomUUID(),month_key:monthKey,definition_id:definition.definition_id,company_targets:companyTargets},{transaction});
    }
    await createTargets(ctx, { ...definition.config, monthKey, storeTargets, source: definition.source,
      name: definition.name, definitionId: definition.definition_id }, transaction, stores);
  });
}

async function createTargets(ctx, body, transaction, availableStores) {
  const user = ctx.state.user;
  const monthKey = month(ctx, body.monthKey);
  const bundled = Array.isArray(body.storeTargets);
  const plans = bundled ? body.storeTargets : idsFrom(body.storeIds).map(storeId => ({ storeId, [body.metric]: body.target }));
  const ids = idsFrom(plans.map(plan => plan?.storeId));
  const stores = (availableStores || await storesFor(user)).filter(store => ids.includes(key(store.store_id)));
  const name = key(body.name).trim();
  const requirements = key(body.requirements).trim();
  const roleCodes = idsFrom(bundled ? body.roleCodes : [body.roleCode]);
  const categoryIds = bundled && body.kind === 'operating' ? idsFrom(body.categoryIds) : null;
  const checkMethod = bundled && body.kind === 'management' ? body.checkMethod : null;
  const allowedMetrics = body.definitionId ? body.metrics : bundled
    ? ['operating','ability'].includes(body.kind) ? metrics.slice(0, 3) : body.kind === 'management' ? ['management'] : []
    : metrics.includes(body.metric) ? [body.metric] : [];
  if (monthKey < nowMonth()) ctx.throw(400, '历史月份不能新增指标，请选择当前月或之后的月份');
  if (!['company', 'store'].includes(body.source)) ctx.throw(400, '请选择指标来源');
  if (!name || name.length > 128) ctx.throw(400, '请填写指标名称，最多 128 字');
  if (!roleCodes.length) ctx.throw(400, '请选择至少一个适用岗位');
  if (roleCodes.some(code => code.length > 32)) ctx.throw(400, '适用岗位无效，请重新选择');
  if (!allowedMetrics.length) ctx.throw(400, '请选择指标类型');
  if(body.kind==='ability'&&!['overdue','special','source'].includes(body.abilityType))ctx.throw(400,'请选择销售能力范围');
  if(body.kind==='ability'&&body.abilityType==='source'){
    const selected=idsFrom(body.customerSources);
    if(!selected.length||await M.CustomerSource.count({where:{status:1,level:1,name:selected},transaction})!==selected.length)ctx.throw(400,'请选择有效客户来源');
  }
  if (!ids.length) ctx.throw(400, '请选择至少一家门店');
  if (ids.length !== plans.length) ctx.throw(400, '门店目标存在重复或空白门店，请重新选择');
  if (ids.length !== stores.length) ctx.throw(400, '部分门店已停用或超出授权范围，请重新选择');
  if (requirements.length > 1000) ctx.throw(400, '检查要求不能超过 1000 字');
  if (stores.some(store => !permissions(user, store)[body.source === 'company' ? 'company' : 'manager'])) ctx.throw(403, '无权在所选门店配置此指标');
  if (bundled && await M.Role.count({ where: { role_code: roleCodes, status: 1 } }) !== roleCodes.length) ctx.throw(400, '适用岗位无效');
  if (categoryIds && !body.allProducts && (!categoryIds.length || await M.ProductCategory.count({ where: { category_id: categoryIds, status: 1 } }) !== categoryIds.length)) {
    ctx.throw(400, '请选择有效的商品分类');
  }
  if (bundled && body.kind === 'management' && !['photo', 'text'].includes(checkMethod)) ctx.throw(400, '请选择检查方式');
  const productIds = bundled || body.metric === 'management' ? [] : idsFrom(body.productIds);
  if (productIds.length && await M.Product.count({ where: { product_id: productIds } }) !== productIds.length) ctx.throw(400, '商品范围无效');
  const releaseId = body.definitionId ? randomUUID() : null;
  const rows = plans.flatMap(plan => {
    const storeId = key(plan.storeId).trim();
    const storeName = stores.find(store => key(store.store_id) === storeId).name;
    const selected = allowedMetrics.filter(metric => plan[metric] !== null && plan[metric] !== undefined && plan[metric] !== '');
    if (!selected.length) ctx.throw(400, `请填写「${storeName}」的${body.kind === 'management' ? '目标次数' : '至少一项门店目标'}`);
    const labels = { sales: '销售额目标', profit: '毛利目标', quantity: '数量目标', management: '目标次数' };
    return selected.map(metric => ({
      indicator_id: randomUUID(), month_key: monthKey, store_id: storeId, source: body.source,
      definition_id: body.definitionId || null, release_id: releaseId,
      name, role_code: roleCodes[0], role_codes: bundled ? roleCodes : null, metric,
      target: target(ctx, plan[metric], metric, `「${storeName}」的${labels[metric]}`), product_ids: productIds, category_ids: categoryIds,
      scope_config:{kind:body.kind|| (metric==='management'?'management':'operating'),abilityType:body.abilityType||null,customerSources:idsFrom(body.customerSources)},
      check_method: checkMethod, requirements, created_by: user.staffId
    }));
  });
  if (transaction) await M.MonthlyIndicator.bulkCreate(rows, { transaction });
  else await M.sequelize.transaction(tx => M.MonthlyIndicator.bulkCreate(rows, { transaction: tx }));
  result(ctx, {});
}

async function update(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  await M.sequelize.transaction(async transaction => {
    const row = await M.MonthlyIndicator.findByPk(ctx.params.indicatorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.month_key < nowMonth() || (row.status<0&&body.deleteScope!=='indicator'&&!body.companyTargets)) ctx.throw(409, '指标不存在或已删除');
    if(row.status<0&&!await M.MonthlyIndicatorPlan.findOne({where:{definition_id:row.definition_id,month_key:row.month_key,status:1},transaction}))ctx.throw(409,'指标已删除');
    const store = await M.Store.findByPk(row.store_id, { transaction });
    if (!store || !canAccessDistributor(user, store.distributor_id)) ctx.throw(403, '无权操作该门店');
    const access = permissions(user, store);
    if(body.companyTargets){
      if(!row.definition_id||!access[row.source==='company'?'company':'manager'])ctx.throw(403,'无权调整总目标');
      const definition=await M.MonthlyIndicatorDefinition.findByPk(row.definition_id,{transaction});
      const companyTargets={};
      for(const metric of definition.config.metrics)if(body.companyTargets[metric]!==undefined)companyTargets[metric]=target(ctx,body.companyTargets[metric],metric,'总目标');
      if(!Object.keys(companyTargets).length)ctx.throw(400,'请填写总目标');
      const plan=await M.MonthlyIndicatorPlan.findOne({where:{definition_id:row.definition_id,month_key:row.month_key},transaction,lock:transaction.LOCK.UPDATE});
      if(plan)await plan.update({company_targets:{...plan.company_targets,...companyTargets}},{transaction});
      else await M.MonthlyIndicatorPlan.create({plan_id:randomUUID(),definition_id:row.definition_id,month_key:row.month_key,company_targets:companyTargets},{transaction});
      return;
    }
    if(body.target!==undefined){
      if(!access[row.source==='company'?'company':'manager'])ctx.throw(403,'无权调整门店目标');
      await row.update({target:target(ctx,body.target,row.metric,'门店目标')},{transaction});return;
    }
    if(body.deleteScope){
      if(!['indicator','store','metric'].includes(body.deleteScope))ctx.throw(400,'删除范围无效');
      const required=body.deleteScope==='indicator'&&row.source==='company'?'company':row.source==='store'?'manager':null;
      if(required?!access[required]:!access.company&&!access.manager)ctx.throw(403,'无权删除此范围');
      const candidates=await M.MonthlyIndicator.findAll({where:{month_key:row.month_key,source:row.source,status:{[Op.gte]:0}},transaction,lock:transaction.LOCK.UPDATE});
      const allowedStores=await storesFor(user);
      const selected=candidates.filter(r=>groupKey(r)===groupKey(row)&&
        (row.source!=='store'||r.store_id===row.store_id)&&
        (body.deleteScope==='indicator'||r.store_id===row.store_id)&&
        (body.deleteScope!=='metric'||r.metric===row.metric)&&
        allowedStores.some(s=>s.store_id===r.store_id&&s.distributor_id===store.distributor_id));
      for(const item of selected)await item.update({status:-1},{transaction});
      if(body.deleteScope==='indicator'&&row.definition_id)await M.MonthlyIndicatorPlan.update({status:0},{where:{definition_id:row.definition_id,month_key:row.month_key},transaction});
      await require('../../utils/businessActionLog').recordBusinessAction({businessType:'monthly_indicator',businessId:row.indicator_id,action:'delete_'+body.deleteScope,user,detail:{ids:selected.map(r=>r.indicator_id),preserveEvidence:true},transaction});
      return;
    }
    if(row.status!==1)ctx.throw(409,'指标已停用');
    if (body.disable === true) {
      if (!access[row.source === 'company' ? 'company' : 'manager']) ctx.throw(403, '无权停用此指标');
      await row.update({ status: 0 }, { transaction });
      return;
    }
    if (!access.manager) ctx.throw(403, '由本店店长分解目标');
    if (!Array.isArray(body.assignments)) ctx.throw(400, '请选择分解对象');
    const existing = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: row.indicator_id }, transaction });
    const submitted = new Set();
    for (const entry of body.assignments) {
      const id = key(entry.staffId);
      if (submitted.has(id)) ctx.throw(400, '同一员工只能分解一次');
      submitted.add(id);
      const staff = await M.Staff.findByPk(id, { transaction });
      if (!staff || !staff.status || staff.is_deleted || key(staff.distributor_id) !== key(store.distributor_id) ||
          (key(staff.store_id) !== key(store.store_id) && id !== key(store.manager_staff_id)) ||
          (!(row.role_codes || [row.role_code]).includes(staff.role_code) &&
            !(row.source === 'store' && id === key(store.manager_staff_id)))) ctx.throw(400, '员工不符合门店或岗位范围');
      const goal = target(ctx, entry.target, row.metric);
      const old = existing.find(item => key(item.staff_id) === id);
      if (old) await old.update({ target: goal }, { transaction });
      else await M.MonthlyIndicatorAssignment.create({ assignment_id: randomUUID(), indicator_id: row.indicator_id, staff_id: id, target: goal }, { transaction });
    }
    for (const old of existing.filter(item => !submitted.has(key(item.staff_id)))) {
      if (await M.MonthlyIndicatorEvidence.count({ where: { assignment_id: old.assignment_id }, transaction })) ctx.throw(409, '已有提交记录的人员不能移除');
      await old.destroy({ transaction });
    }
  });
  result(ctx, {});
}

async function submit(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  let file = ctx.file;
  if (body.photoBase64 !== undefined) {
    const encoded = body.photoBase64;
    if (file || typeof encoded !== 'string' || !encoded.length || encoded.length % 4 ||
        encoded.length > Math.ceil(2 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      ctx.throw(400, '照片格式无效或超过 2 MB，请重新选择');
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length > 2 * 1024 * 1024) ctx.throw(400, '照片超过 2 MB，请重新选择');
    const header = buffer.subarray(0, 8).toString('hex');
    const png = header === '89504e470d0a1a0a';
    if (!png && !header.startsWith('ffd8ff')) ctx.throw(400, '请上传有效的 JPG 或 PNG 照片');
    file = { buffer, mimetype: png ? 'image/png' : 'image/jpeg', originalname: png ? '检查照片.png' : '检查照片.jpg' };
  }
  const resultText = key(body.resultText).trim();
  const submissionKey = key(body.submissionKey);
  if (submissionKey && !/^[a-z0-9-]{12,64}$/.test(submissionKey)) ctx.throw(400, '提交标识无效，请重新选择照片');
  const id = submissionKey
    ? createHash('sha256').update(`${ctx.params.assignmentId}:${submissionKey}`).digest('hex').slice(0, 32) : randomUUID();
  await M.sequelize.transaction(async transaction => {
    const assignment = await M.MonthlyIndicatorAssignment.findByPk(ctx.params.assignmentId, { transaction });
    if (!assignment || key(assignment.staff_id) !== key(user.staffId)) ctx.throw(403, '只能提交自己的任务');
    const indicator = await M.MonthlyIndicator.findByPk(assignment.indicator_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (indicator?.status!==1 || indicator.metric !== 'management' || indicator.month_key !== nowMonth()) ctx.throw(409, '该任务当前不可提交');
    if (submissionKey && await M.MonthlyIndicatorEvidence.findByPk(id, { attributes: ['evidence_id'], transaction, lock: transaction.LOCK.UPDATE })) return;
    const textMode = indicator.check_method === 'text';
    if (textMode) {
      if (!resultText || resultText.length > 1000 || file) ctx.throw(400, '请填写 1 至 1000 字的检查结果');
    } else {
      const signature = { 'image/jpeg': 'ffd8ff', 'image/png': '89504e470d0a1a0a',
        ...(indicator.check_method === 'photo' ? {} : { 'application/pdf': '255044462d' }) }[file?.mimetype];
      if (!file?.buffer?.length || !signature || !file.buffer.subarray(0, 8).toString('hex').startsWith(signature)) {
        ctx.throw(400, indicator.check_method === 'photo' ? '请上传有效的 JPG 或 PNG 照片' : '请上传有效的 JPG、PNG 或 PDF 证明文件');
      }
    }
    if (!await M.MonthlyIndicatorAssignment.findByPk(assignment.assignment_id, { transaction, lock: transaction.LOCK.UPDATE })) ctx.throw(409, '任务分解已变更');
    const staff = await M.Staff.findByPk(user.staffId, { transaction, lock: transaction.LOCK.SHARE });
    const supervisor = staff?.supervisor_staff_id && await M.Staff.findByPk(staff.supervisor_staff_id, { transaction });
    if (!supervisor?.status || supervisor.is_deleted || key(supervisor.staff_id) === key(staff.staff_id)) ctx.throw(409, '请检查直属上级配置');
    const instance = await approval.startInstance({
      flowCode: 'monthly_indicator_evidence', businessType: 'monthly_indicator_evidence', businessId: id,
      subjectStaffId: staff.staff_id, storeId: null, distributorId: staff.distributor_id,
      title: indicator.name, summary: textMode ? resultText : indicator.requirements,
      payload: textMode ? { resultText } :
        { indicatorEvidenceId: id, original_name: key(file.originalname).slice(0, 255), mime_type: file.mimetype }
    }, user, transaction);
    const tasks = await M.ApprovalTask.findAll({ where: { instance_id: instance.instance_id }, transaction });
    if (tasks.length !== 1 || key(tasks[0].assignee_staff_id) !== key(supervisor.staff_id)) ctx.throw(409, '管理指标审批须由直属上级处理');
    await M.MonthlyIndicatorEvidence.create({ evidence_id: id, assignment_id: assignment.assignment_id,
      instance_id: instance.instance_id, applicant_staff_id: staff.staff_id, supervisor_staff_id: supervisor.staff_id,
      original_name: textMode ? '' : key(file.originalname).slice(0, 255), mime_type: textMode ? '' : file.mimetype,
      attachment: textMode ? Buffer.alloc(0) : file.buffer, result_text: textMode ? resultText : null }, { transaction });
  });
  result(ctx, { evidenceId: id });
}

async function download(ctx) {
  const row = await M.MonthlyIndicatorEvidence.findByPk(ctx.params.evidenceId);
  const id = key(ctx.state.user.staffId);
  if (!row || row.result_text || ![key(row.applicant_staff_id), key(row.supervisor_staff_id)].includes(id)) ctx.throw(404, '证明文件不存在');
  if (ctx.query?.format === 'base64' && /^image\/(jpeg|png)$/.test(row.mime_type)) {
    return result(ctx, { photoBase64: row.attachment.toString('base64'), mimeType: row.mime_type });
  }
  ctx.attachment(row.original_name);
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.type = row.mime_type;
  ctx.body = row.attachment;
}

async function categoryProductScopes(indicators) {
  const scopes = new Map();
  const categorized = indicators.filter(row => row.category_ids?.length);
  if (!categorized.length) return scopes;
  const categories = await M.ProductCategory.findAll({ attributes: ['category_id', 'parent_id'], raw: true });
  const children = new Map();
  for (const category of categories) {
    if (!children.has(category.parent_id)) children.set(category.parent_id, []);
    children.get(category.parent_id).push(category.category_id);
  }
  const allIds = new Set();
  for (const row of categorized) {
    const ids = new Set(row.category_ids);
    for (const id of ids) for (const child of children.get(id) || []) ids.add(child);
    for (const id of ids) allIds.add(id);
    scopes.set(row.indicator_id, ids);
  }
  const products = await M.Product.findAll({
    where: { category_id: [...allIds] }, attributes: ['product_id', 'category_id'], raw: true
  });
  for (const [id, categories] of scopes) {
    scopes.set(id, products.filter(product => categories.has(product.category_id)).map(product => product.product_id));
  }
  return scopes;
}

async function report(ctx) {
  const user = ctx.state.user;
  const monthKey = month(ctx, ctx.query.monthKey);
  const own = ctx.query.view === 'mine';
  const managed = ctx.query.view === 'managed';
  const stores = (await storesFor(user)).filter(store =>
    (!ctx.query.storeId || key(store.store_id) === key(ctx.query.storeId)) && (!managed || permissions(user, store).manager));
  if (managed) {
    if (!ctx.query.storeId || !ctx.query.staffId) ctx.throw(400, '请选择门店和员工');
    if (!stores.length) ctx.throw(403, '仅正式店长可以查看所负责门店的员工达成');
    const member = await M.Staff.findOne({ where: { ...active, staff_id: ctx.query.staffId, store_id: stores[0].store_id,
      distributor_id: stores[0].distributor_id }, attributes: ['staff_id'], raw: true });
    if (!member) ctx.throw(403, '只能查看本店在职员工');
  }
  let team = [];
  if (own && ctx.query.includeTeam === '1') {
    const managedStores = stores.filter(store => permissions(user, store).manager);
    if (managedStores.length) {
      const staff = await M.Staff.findAll({ where: { ...active, store_id: managedStores.map(store => store.store_id),
        staff_id: { [Op.ne]: user.staffId } }, attributes: ['staff_id', 'store_id', 'distributor_id', 'name'],
      order: [['name', 'ASC'], ['staff_id', 'ASC']], raw: true });
      team = managedStores.map(store => ({
        id: store.store_id, name: store.name,
        employees: staff.filter(person => key(person.store_id) === key(store.store_id) && key(person.distributor_id) === key(store.distributor_id))
          .map(person => ({ id: key(person.staff_id), name: person.name }))
      }));
    }
  }
  const indicators = await M.MonthlyIndicator.findAll({ where: { month_key: monthKey, store_id: stores.map(store => store.store_id),status:{[Op.gte]:0},
    ...(ctx.query.definitionId?{definition_id:ctx.query.definitionId}:{}),
    ...(managed ? { metric: 'management' } : {}),
    ...(ctx.query.releaseId ? { release_id: ctx.query.releaseId } : ctx.query.indicatorId ? { indicator_id: ctx.query.indicatorId } : {}),
    ...(['company', 'store'].includes(ctx.query.source) ? { source: ctx.query.source } : {}) }, raw: true });
  const assignments = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: indicators.map(row => row.indicator_id) }, raw: true });
  const visible = indicators.filter(row => assignments.some(item => item.indicator_id === row.indicator_id && key(item.staff_id) === key(user.staffId)) ||
    (!own && Object.values(permissions(user, stores.find(store => store.store_id === row.store_id))).some(Boolean)));
  const visibleIds = new Set(visible.map(row => row.indicator_id));
  const related = assignments.filter(row => visibleIds.has(row.indicator_id));
  const evidence = await M.MonthlyIndicatorEvidence.findAll({ where: { assignment_id: related.map(row => row.assignment_id) },
    attributes: ['assignment_id', 'instance_id', 'evidence_id', 'original_name', 'mime_type', 'result_text', 'create_time'],
    order: [['create_time', 'ASC'], ['evidence_id', 'ASC']], raw: true });
  const instances = await M.ApprovalFlowInstance.findAll({ where: { instance_id: evidence.map(row => row.instance_id) }, attributes: ['instance_id', 'status'], raw: true });
  const statusById = new Map(instances.map(row => [row.instance_id, row.status]));
  const staff = await M.Staff.findAll({ where: { staff_id: related.map(row => row.staff_id) }, attributes: ['staff_id', 'name'], raw: true });
  const staffNames = new Map(staff.map(row => [key(row.staff_id), row.name]));
  const performance = require('../report/monthlyTaskAchievement');
  const start = new Date(monthKey + '-01T00:00:00+08:00');
  const endAt = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 1) - 8 * 3600000);
  const canProfit = require('../report/dashboardService').canViewProfit(user);
  const operatingStoreIds = [...new Set(visible.filter(row => !own && row.metric !== 'management').map(row => row.store_id))];
  const [actuals, categoryScopes] = await Promise.all([
    performance.loadActuals(operatingStoreIds, start, endAt, 'archived', true),
    categoryProductScopes(own ? [] : visible)
  ]);
  const scopedActuals=new Map();
  for(const row of visible.filter(r=>!own&&r.scope_config?.kind==='ability')){
    const scopeKey=JSON.stringify(row.scope_config);
    if(!scopedActuals.has(scopeKey))scopedActuals.set(scopeKey,await performance.loadActuals(operatingStoreIds,start,endAt,'archived',true,row.scope_config));
  }
  const rows = [];
  for (const store of stores) {
    const indicators = visible.filter(row => row.store_id === store.store_id && (!own || row.metric === 'management'));
    if (!indicators.length) continue;
    for (const row of indicators) {
      const managerial = !own && Object.values(permissions(user, store)).some(Boolean);
      const people = related.filter(item => item.indicator_id === row.indicator_id);
      const actualFor = item => {
        if (row.metric === 'management') return evidence.filter(ev => (item ? ev.assignment_id === item.assignment_id :
          people.some(person => person.assignment_id === ev.assignment_id)) && statusById.get(ev.instance_id) === 'approved').length;
        if (row.metric === 'profit' && !canProfit) return null;
        const selectedActuals=row.scope_config?.kind==='ability'?scopedActuals.get(JSON.stringify(row.scope_config)):actuals;
        const actual = item ? selectedActuals.employeeActuals.get(`${store.store_id}:id:${item.staff_id}`) : selectedActuals.storeActuals.get(key(store.store_id));
        const categoryProducts = categoryScopes.get(row.indicator_id);
        if (categoryProducts && !categoryProducts.length) return 0;
        return performance.indicatorActual(actual, row.metric, categoryProducts ?? row.product_ids);
      };
      const response = (item, goal) => {
        const actual = actualFor(item);
        const showGoal = row.metric !== 'profit' || canProfit;
        const mine = item && key(item.staff_id) === key(user.staffId);
        const submissions = item ? evidence.filter(ev => ev.assignment_id === item.assignment_id) :
          evidence.filter(ev => people.some(person => person.assignment_id === ev.assignment_id));
        const scopeLabel=row.scope_config?.abilityType==='overdue'?`超龄库存（至少${require('../../utils/inventoryAgePolicy').OVERDUE_MIN_DAYS}天）`:row.scope_config?.abilityType==='special'?'销售时采用SN特价':row.scope_config?.abilityType==='source'?(row.scope_config.customerSources||[]).join('、'):row.category_ids?.length?'指定商品分类及下级':'全部商品';
        return { id: item?.assignment_id || row.indicator_id, name: row.name, metric: row.metric, source: row.source,kind:row.scope_config?.kind||(row.metric==='management'?'management':'operating'),scopeLabel:row.metric==='management'?'管理次数':scopeLabel,
          store: store.name, employee: item ? staffNames.get(key(item.staff_id)) : '', requirements: row.requirements,
          checkMethod: row.check_method || 'attachment',
          target: showGoal ? Number(goal) : null, actual, rate: actual === null ? null : Number((actual / Number(goal) * 100).toFixed(2)),
          actualStatus: !showGoal ? 'hidden' : actual === null ? 'pending' : 'available',
          allocated: item || !showGoal ? null : people.reduce((sum, person) => sum + Number(person.target), 0),
          pendingCount: submissions.filter(ev => statusById.get(ev.instance_id) === 'pending').length,
          active: !!row.status, canSubmit: !managed && !!mine && !!row.status && row.metric === 'management' && monthKey === nowMonth(),
          submissions: item && own ? submissions.map(ev => ({
            id: ev.evidence_id, name: ev.original_name, mimeType: ev.mime_type, resultText: ev.result_text,
            status: statusById.get(ev.instance_id), createdAt: ev.create_time
          })) : [] };
      };
      if (managerial && row.source === 'company' && !ctx.query.staffId) rows.push(response(null, row.target));
      for (const item of people) {
        if ((managerial || key(item.staff_id) === key(user.staffId)) &&
            (!ctx.query.staffId || key(item.staff_id) === key(ctx.query.staffId))) rows.push(response(item, item.target));
      }
    }
  }
  if (ctx.query.format === 'xlsx') {
    const { sendExcel } = require('../../utils/excelExport');
    const labels = { sales: '销售额', profit: '销售毛利', quantity: '销售数量', management: '管理次数' };
    const headers = ['门店', '员工', '指标', '来源', '指标类型', '考核范围', '类型', '目标', '已分解', '实际', '达成率百分比', '待审次数'];
    return sendExcel(ctx, rows.map(row => ({
      门店: row.store, 员工: row.employee, 指标: row.name, 来源: row.source === 'company' ? '公司下发' : '门店自建',
      指标类型:row.kind==='ability'?'销售能力指标':row.kind==='management'?'管理指标':'经营指标',考核范围:row.scopeLabel,
      类型: labels[row.metric], 目标: row.target, 已分解: row.allocated,
      实际: row.actualStatus === 'pending' ? '待核算' : row.actual, 达成率百分比: row.rate,
      待审次数: row.metric === 'management' ? row.pendingCount : null
    })), headers, `月度指标达成_${monthKey}.xlsx`, '业务达成');
  }
  result(ctx, own && ctx.query.includeTeam === '1' ? { rows, team } : { rows });
}

module.exports = { setup, create, saveDefinition, update, report, submit, download };
