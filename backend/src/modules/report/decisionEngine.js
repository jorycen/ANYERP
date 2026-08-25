const DEFAULT_THRESHOLDS = {
  salesDeclineRate: -10,
  grossMarginWarning: 8,
  staleProductCount: 1,
  storeDeclineRate: -15
};

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function buildDecisionInsights(snapshot = {}, thresholds = {}) {
  const limit = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const insights = [];
  const kpis = snapshot.kpis || {};
  const inventory = snapshot.inventory || {};
  const sales = kpis.salesAmount || {};
  const margin = kpis.grossMargin || {};

  if (sales.periodCompare !== null && sales.periodCompare !== undefined
    && sales.periodCompare <= limit.salesDeclineRate) {
    insights.push({
      code: 'SALES_DECLINE',
      level: sales.periodCompare <= -20 ? 'critical' : 'warning',
      title: '销售额环比下降',
      message: `当前销售额较上一周期下降 ${Math.abs(round(sales.periodCompare))}%，建议优先检查门店、产品线和员工排名。`,
      metric: { value: round(sales.value), rate: round(sales.periodCompare) },
      action: '查看门店与产品线排名，定位下降来源'
    });
  }

  if (margin.value !== null && margin.value !== undefined && margin.value < limit.grossMarginWarning) {
    insights.push({
      code: 'GROSS_MARGIN_LOW',
      level: margin.value < 0 ? 'critical' : 'warning',
      title: '毛利率偏低',
      message: `当前毛利率为 ${round(margin.value)}%，低于预警线 ${round(limit.grossMarginWarning)}%。`,
      metric: { value: round(margin.value), threshold: round(limit.grossMarginWarning) },
      action: '检查低毛利商品、销售折扣和毛利调整记录'
    });
  }

  const staleProducts = Array.isArray(inventory.staleProducts) ? inventory.staleProducts : [];
  if (staleProducts.length >= limit.staleProductCount) {
    const staleQuantity = staleProducts.reduce((sum, row) => sum + toNumber(row.quantity), 0);
    insights.push({
      code: 'STALE_INVENTORY',
      level: staleProducts.length >= 10 ? 'critical' : 'warning',
      title: '存在滞销或高库龄库存',
      message: `发现 ${staleProducts.length} 个商品共 ${staleQuantity} 台库存进入滞销/高库龄清单。`,
      metric: { productCount: staleProducts.length, quantity: staleQuantity },
      action: '查看高库龄商品，制定促销、调拨或采购暂停方案'
    });
  }

  const decliningStores = (Array.isArray(snapshot.storeRanking) ? snapshot.storeRanking : [])
    .filter(row => row.periodCompare !== null && row.periodCompare !== undefined
      && row.periodCompare <= limit.storeDeclineRate);
  if (decliningStores.length) {
    insights.push({
      code: 'STORE_DECLINE',
      level: 'warning',
      title: '部分门店销售下降',
      message: `${decliningStores.length} 家门店较上一周期下降超过 ${Math.abs(round(limit.storeDeclineRate))}%。`,
      metric: { storeCount: decliningStores.length },
      action: '按门店查看销售趋势和员工业绩，安排经营复盘'
    });
  }

  if (!insights.length) {
    insights.push({
      code: 'NO_EXCEPTION',
      level: 'info',
      title: '当前未发现明显经营异常',
      message: '当前筛选范围内未触发预设经营预警规则，可继续关注趋势和库存结构。',
      metric: {},
      action: '保持日常经营监控'
    });
  }

  const levelRank = { critical: 0, warning: 1, info: 2 };
  return insights.sort((left, right) => levelRank[left.level] - levelRank[right.level]);
}

function buildAiAdvisor(snapshot = {}, options = {}) {
  const insights = buildDecisionInsights(snapshot, options.thresholds);
  return {
    provider: 'rule_engine_fallback',
    aiAvailable: false,
    status: 'fallback',
    notice: '当前使用可解释规则生成建议；真实 AI 模型接入待确认。',
    summary: insights[0]?.message || '当前没有可输出的经营建议。',
    recommendations: insights.map(insight => ({
      code: insight.code,
      priority: insight.level,
      title: insight.title,
      reason: insight.message,
      action: insight.action,
      metric: insight.metric
    }))
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  buildDecisionInsights,
  buildAiAdvisor,
  _test: { round }
};
