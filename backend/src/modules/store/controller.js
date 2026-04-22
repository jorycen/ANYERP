/**
 * 门店管理控制器
 */
const { Store, Region } = require('../../models');
const { Op } = require('sequelize');
const { paginate, formatPaginatedResult } = require('../../utils');

/**
 * 门店列表
 */
async function getStoreList(ctx) {
  const { regionCode, keyword, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    where.region_id = user.regionCodes;
  }
  if (regionCode) where.region_id = regionCode;
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { address: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Store.findAndCountAll({
    where,
    include: [
      { model: Region, attributes: ['region_code', 'name'] }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

module.exports = { getStoreList };
