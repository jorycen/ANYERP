const path = require('node:path');
const { Op } = require('sequelize');
const { Order } = require('../src/models');
const { sequelize } = require('../src/config/database');
const { subsidyPhotoDownloadName } = require('../src/modules/sales/controller')._test;

function parsePhotos(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function photoOriginalName(photo, index) {
  if (typeof photo === 'string') return path.basename(photo) || `国补照片${index + 1}`;
  return String(photo?.name || photo?.originalName || `国补照片${index + 1}`).trim();
}

function standardizePhotos(order) {
  const data = order.toJSON ? order.toJSON() : order;
  const source = parsePhotos(data.subsidy_photos);
  let changedCount = 0;
  let missingPersonCount = 0;
  const photos = source.map((photo, index) => {
    const oldName = photoOriginalName(photo, index);
    const standardName = subsidyPhotoDownloadName(data, {
      name: oldName,
      mimeType: photo?.mime_type || photo?.mimeType || ''
    }, index);
    if (standardName === oldName && typeof photo !== 'string') return photo;

    changedCount += 1;
    if (!String(data.subsidy_person || data.customer_name || '').trim()) missingPersonCount += 1;
    if (typeof photo === 'string') {
      return {
        id: `legacy-${index}`,
        name: standardName,
        url: photo,
        storage: 'external',
        original_name: oldName
      };
    }
    return {
      ...photo,
      name: standardName,
      original_name: photo.original_name || photo.originalName || oldName
    };
  });
  return { photos, changedCount, missingPersonCount };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const orders = await Order.findAll({
    attributes: ['order_id', 'order_no', 'customer_name', 'subsidy_person', 'subsidy_photos'],
    where: { subsidy_photos: { [Op.not]: null } },
    order: [['create_time', 'ASC'], ['order_id', 'ASC']]
  });
  let changedOrders = 0;
  let changedPhotos = 0;
  let missingPersonPhotos = 0;

  for (const order of orders) {
    const result = standardizePhotos(order);
    if (!result.changedCount) continue;
    changedOrders += 1;
    changedPhotos += result.changedCount;
    missingPersonPhotos += result.missingPersonCount;
    if (apply) {
      await sequelize.transaction(transaction => order.update({
        subsidy_photos: result.photos,
        update_time: new Date()
      }, { transaction }));
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    totalOrders: orders.length,
    changedOrders,
    changedPhotos,
    missingPersonPhotos
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
