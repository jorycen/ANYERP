// 库存增加必须落到本门店的有效库位；旧流程未传库位时使用对应标准仓。
async function resolveInventoryWriteLocation(Location, { storeId, field, locationId, transaction }) {
  const id = String(locationId || '').trim();
  const type = ['regular_qty', 'subsidy_qty', 'second_qty'].includes(field) ? 'normal_qty' : field;
  const where = { store_id: storeId, status: 1, ...(id ? { location_id: id } : { type }) };
  const location = await Location.findOne({ where, transaction });
  if (!location) {
    throw Object.assign(new Error('库存增加失败：必须指定本门店的有效库位，请检查仓位配置'), { status: 400 });
  }
  return location.location_id;
}

module.exports = { resolveInventoryWriteLocation };
