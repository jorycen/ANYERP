// 云函数入口文件
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

// 使用数据库记录来查询文件列表
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { folder, startDate, endDate } = event;

  try {
    console.log('开始查询文件夹:', folder, '日期范围:', startDate, '到', endDate);

    let fileIDs = [];

    // 构建日期查询条件（使用本地时间，避免UTC时区问题）
    let dateCondition = {};
    if (startDate && endDate) {
      const startParts = startDate.split('-');
      const endParts = endDate.split('-');
      const start = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
      const end = new Date(parseInt(endParts[0]), parseInt(endParts[1]) - 1, parseInt(endParts[2]), 23, 59, 59, 999);

      dateCondition = {
        createTime: _.gte(start).and(_.lte(end))
      };
      console.log('日期条件（本地时间）:', start, '到', end);
    }

    // 优化：限制查询的订单数量，只查询最近1000条
    const MAX_ORDERS = 1000;
    const limit = 200; // 每批查询200条

    // 通用函数：获取订单数据（带日期筛选和数量限制）
    const getOrders = async () => {
      let allOrders = [];
      let hasMore = true;
      let offset = 0;

      while (hasMore && allOrders.length < MAX_ORDERS) {
        const batchLimit = Math.min(limit, MAX_ORDERS - allOrders.length);
        const query = db.collection('orders')
          .orderBy('createTime', 'desc')
          .skip(offset)
          .limit(batchLimit);

        // 如果有日期条件，添加where
        const res = Object.keys(dateCondition).length > 0
          ? await query.where(dateCondition).get()
          : await query.get();

        const orders = res.data || [];
        allOrders = allOrders.concat(orders);
        hasMore = orders.length === batchLimit;
        offset += batchLimit;

        console.log(`已查询订单: ${allOrders.length} 条`);
      }

      return allOrders;
    };

    // 获取订单数据
    const allOrders = await getOrders();
    console.log('获取到订单总数:', allOrders.length);

    if (folder === 'subsidy_photos/') {
      // 从订单数据中获取国补照片
      allOrders.forEach(order => {
        const subsidyPhotos = order.subsidyPhotos || [];
        subsidyPhotos.forEach(photo => {
          if (photo.url && photo.url.includes('cloud://')) {
            fileIDs.push(photo.url);
          }
        });
      });

    } else if (folder === 'personal-info-photos/') {
      // 从订单数据中获取个人资料照片和国补商品图片
      allOrders.forEach(order => {
        // 个人资料照片
        const personalInfoPhoto = order.personalInfoPhoto;
        if (personalInfoPhoto && personalInfoPhoto.fileID) {
          fileIDs.push(personalInfoPhoto.fileID);
        } else if (personalInfoPhoto && personalInfoPhoto.url && personalInfoPhoto.url.includes('cloud://')) {
          fileIDs.push(personalInfoPhoto.url);
        }

        // 国补订单的商品图片（也保存在personal-info-photos文件夹）
        const productPhotoUrls = order.productPhotoUrls || [];
        productPhotoUrls.forEach(url => {
          if (url && url.includes('cloud://') && url.includes('personal-info-photos')) {
            fileIDs.push(url);
          }
        });
      });

    } else if (folder === 'orders/') {
      // 从订单数据中获取订单相关图片
      allOrders.forEach(order => {
        // 商品照片
        const productPhotoUrls = order.productPhotoUrls || [];
        productPhotoUrls.forEach(url => {
          if (url && url.includes('cloud://')) {
            fileIDs.push(url);
          }
        });

        // 国补照片（从订单详请页面使用orders/路径上传的）
        const subsidyPhotos = order.subsidyPhotos || [];
        subsidyPhotos.forEach(photo => {
          if (photo.url && photo.url.includes('cloud://') && photo.url.includes('orders/')) {
            fileIDs.push(photo.url);
          }
        });

        // 教育补贴凭证
        if (order.educationSubsidyPhotoUrl && order.educationSubsidyPhotoUrl.includes('cloud://')) {
          fileIDs.push(order.educationSubsidyPhotoUrl);
        }
      });

    } else if (folder === 'supplement-proofs/') {
      // 从订单数据中获取补录凭证
      allOrders.forEach(order => {
        // 从补录记录中获取凭证图片
        const supplements = order.supplements || [];
        supplements.forEach(supplement => {
          if (supplement.proofPhotoUrl && supplement.proofPhotoUrl.includes('cloud://')) {
            fileIDs.push(supplement.proofPhotoUrl);
          }
        });
      });
    }

    console.log('获取到文件ID数:', fileIDs.length);

    // 去重
    fileIDs = [...new Set(fileIDs)];

    // 过滤只保留指定文件夹下的文件
    const filteredFileIDs = fileIDs.filter(fileID => {
      const folderName = folder.replace('/', '');
      return fileID.includes(folderName);
    });

    console.log('过滤后文件数:', filteredFileIDs.length);

    // 限制返回的文件数量，避免超时（提升至500以支持更多照片）
    const MAX_FILES = 500;
    const limitedFileIDs = filteredFileIDs.slice(0, MAX_FILES);

    if (filteredFileIDs.length > MAX_FILES) {
      console.log(`⚠️ 文件数量超过${MAX_FILES}个限制（共${filteredFileIDs.length}个），只返回前${MAX_FILES}个。建议缩小日期范围查询。`);
    }

    // 获取临时访问链接
    let tempURLs = [];
    if (limitedFileIDs.length > 0) {
      try {
        // 分批获取，每次最多50个
        const batchSize = 50;
        for (let i = 0; i < limitedFileIDs.length; i += batchSize) {
          const batch = limitedFileIDs.slice(i, i + batchSize);
          const tempResult = await cloud.getTempFileURL({
            fileList: batch
          });
          if (tempResult.fileList) {
            tempURLs.push(...tempResult.fileList);
          }
        }
      } catch (err) {
        console.error('获取临时链接失败:', err);
      }
    }

    // 格式化返回数据
    const formattedFiles = limitedFileIDs.map((fileID, index) => ({
      fileID: fileID,
      tempFileURL: tempURLs[index] ? tempURLs[index].tempFileURL : ''
    }));

    return {
      success: true,
      files: formattedFiles,
      count: formattedFiles.length,
      totalCount: filteredFileIDs.length,
      hasMore: filteredFileIDs.length > MAX_FILES
    };

  } catch (err) {
    console.error('云函数执行失败:', err);
    return {
      success: false,
      error: err.message,
      files: []
    };
  }
};
