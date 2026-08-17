// utils/storage.js

/**
 * 数据存储工具类
 * 使用微信云开发的数据库服务
 */
const Database = require('./database.js');
const api = require('./api.js');
const http = require('./request.js');
const { normalizeOrderItem, normalizeSnCode } = require('./model.js');

function getCurrentStoreInfo() {
  const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
  const userInfo = wx.getStorageSync('userInfo') || {};
  const roleValues = [userInfo.userRole, userInfo.role, userInfo.roleCode]
    .concat(Array.isArray(userInfo.roles) ? userInfo.roles : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const isStoreScoped = roleValues.length > 0 && roleValues.every(role => ['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role));
  if (!isStoreScoped) return { storeId: '', storeName: '', userInfo };
  const storeId = tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || userInfo.storeId || '';
  const storeName = tempStoreInfo.storeName || tempStoreInfo.store_name || tempStoreInfo.name || userInfo.storeName || '';
  return { storeId, storeName, userInfo };
}

function toMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function normalizeNeedSn(value) {
  return value === true || value === 1 || ['1', 'true', 'yes'].indexOf(String(value || '').trim().toLowerCase()) >= 0;
}

/**
 * 国补 POS 在开单页录入的是参与补贴的商品金额，后端 payments.amount
 * 要求的是实际收款金额。其他收款方式直接使用录入金额。
 */
function getCollectedPaymentAmount(payment) {
  const amountInCents = Math.round(toMoney(payment && payment.amount) * 100);
  const paymentType = String(payment && payment.type || '').trim();
  let discountLimitInCents = 0;

  if (paymentType === '国补POS（手机平板）') {
    discountLimitInCents = 500 * 100;
  } else if (paymentType === '国补POS（电脑）') {
    discountLimitInCents = 1500 * 100;
  } else {
    return amountInCents / 100;
  }

  const discountInCents = Math.min(
    Math.round(amountInCents * 0.15),
    discountLimitInCents
  );
  return (amountInCents - discountInCents) / 100;
}

function isGuobuPosPaymentType(type) {
  return type === '国补POS（手机平板）' || type === '国补POS（电脑）';
}

function isPolicySubsidyReceivable(type) {
  return String(type || '').indexOf('政策补贴应收') >= 0;
}

function splitGuobuPayment(payment) {
  const paymentType = String(payment && payment.type || '').trim();
  if (!isGuobuPosPaymentType(paymentType)) {
    return [{
      paymentType,
      amount: toMoney(payment && payment.amount),
      depositId: payment && payment.depositId || '',
      depositNo: payment && payment.depositNo || ''
    }];
  }

  const grossAmount = toMoney(payment && payment.amount);
  const customerReceived = getCollectedPaymentAmount(payment);
  const subsidyReceivable = toMoney(grossAmount - customerReceived);
  return [
    {
      paymentType: `${paymentType}-客户实收`,
      amount: customerReceived,
      settlementCategory: 'customer_received'
    },
    {
      paymentType: `${paymentType}-政策补贴应收`,
      amount: subsidyReceivable,
      settlementCategory: 'policy_subsidy_receivable'
    }
  ];
}

function reconcilePaymentsToActual(payments, actualAmount) {
  const expectedInCents = Math.round(toMoney(actualAmount) * 100);
  const receivedInCents = payments.reduce((total, payment) => {
    if (isPolicySubsidyReceivable(payment.paymentType)) return total;
    return total + Math.round(toMoney(payment.amount) * 100);
  }, 0);
  const differenceInCents = expectedInCents - receivedInCents;

  // 两种国补金额分别取整时可能产生 1 分钱尾差，将其归入最后一笔国补 POS。
  if (Math.abs(differenceInCents) <= 1 && differenceInCents !== 0) {
    let index = -1;
    for (let i = payments.length - 1; i >= 0; i--) {
      const type = payments[i].paymentType;
      if (String(type || '').indexOf('国补POS') === 0 && String(type || '').indexOf('客户实收') >= 0) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      payments[index].amount = (
        Math.round(toMoney(payments[index].amount) * 100) + differenceInCents
      ) / 100;
    }
  }

  return payments;
}

const DataStorage = {
  /**
   * 初始化数据库
   */
  init: function () {
    Database.init();
  },

  /**
   * 保存订单数据
   * @param {Object} orderData 订单数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveOrder: function (orderData, success, fail) {
    // Adapter logic: Map old NoSQL format to new Relational format
    const now = new Date();
    const sourceItems = orderData.items && orderData.items.length ? orderData.items : (orderData.goods || []);
    const mappedPayments = reconcilePaymentsToActual(
      (orderData.paymentMethods || []).reduce((list, payment) => {
        return list.concat(splitGuobuPayment(payment));
      }, []),
      orderData.actualAmount
    );
    const mappedPaymentTotal = mappedPayments.reduce((total, payment) => {
      if (isPolicySubsidyReceivable(payment.paymentType)) return total;
      return total + Math.round(toMoney(payment.amount) * 100);
    }, 0) / 100;
    const mappedData = {
      orderNo: orderData.orderNo,
      storeId: orderData.storeId,
      storeName: orderData.storeName,
      createUser: orderData.createUser,
      createTime: orderData.createTime || now,
      createDate: orderData.createDate || `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`,
      customerId: orderData.customerId || '',
      customerName: orderData.contactName || '',
      customerPhone: orderData.contactMethod || '',
      customerSource: orderData.customerSource || '',
      customerSourceDetail: orderData.customerSourceDetail || '',
      totalAmount: orderData.totalAmount,
      discountAmount: parseFloat(orderData.discount) || 0,
      nationalSubsidy: orderData.nationalSubsidy || 0,
      computerAmount: orderData.computerAmount || '',
      mobileAmount: orderData.mobileAmount || '',
      educationSubsidy: orderData.educationSubsidy || 0,
      actualPayment: toMoney(orderData.actualAmount),
      paymentTotal: mappedPaymentTotal,
      depositItems: orderData.depositItems || orderData.deposits || [],
      depositDeductionTotal: orderData.depositDeductionTotal || 0,
      status: orderData.status || '未归档',
      // 新建订单阶段不占用库存，PN/SN 的存在性、匹配及可售状态统一在归档时校验。
      snStatusAction: orderData.snStatusAction || '',
      targetSnStatus: orderData.targetSnStatus || '',
      inventoryStatusAction: orderData.inventoryStatusAction || '',
      targetInventoryStatus: orderData.targetInventoryStatus || '',
      items: sourceItems.map(g => {
        const quantity = Number(g.quantity || 1);
        const price = Number(g.price || g.unitPrice || g.salePrice || 0);
        const productName = g.productName || g.product_name || g.name || '';
        const inventoryId = g.inventoryId || g.inventory_id || g.snId || g.sn_id || '';
        const previousSnStatus = g.previousSnStatus || g.previous_sn_status || g.inventoryStatus || g.inventory_status || g.status || '在库';
        return {
          productId: g.productId || g.product_id || '',
          pnCode: g.pnCode || '',
          inventoryId: inventoryId,
          snCode: g.snCode || g.sn_code || g.sn || '',
          previousSnStatus: previousSnStatus,
          previousInventoryStatus: previousSnStatus,
          mtmCode: g.mtmCode || g.mtm_code || '',
          productName: productName,
          name: productName,
          quantity,
           unitPrice: price,
           salePrice: price,
           standardPrice: Number(g.standardPrice || g.standard_price || g.productStandardPrice || g.product_standard_price || 0),
           standard_price: Number(g.standardPrice || g.standard_price || g.productStandardPrice || g.product_standard_price || 0),
           minSalePrice: Number(g.minSalePrice || g.min_sale_price || g.minimumSalePrice || g.minimum_sale_price || g.minPrice || g.min_price || g.lowestSalePrice || g.lowest_sale_price || g.lowPrice || g.low_price || g.floorPrice || g.floor_price || 0),
           min_sale_price: Number(g.minSalePrice || g.min_sale_price || g.minimumSalePrice || g.minimum_sale_price || g.minPrice || g.min_price || g.lowestSalePrice || g.lowest_sale_price || g.lowPrice || g.low_price || g.floorPrice || g.floor_price || 0),
           subtotal: g.subtotal !== undefined ? Number(g.subtotal || 0) : price * quantity,
          costPrice: Number(g.costPrice || g.cost_price || g.purchasePrice || g.purchase_price || g.importPrice || g.import_price || g.cost || g.settlementPrice || g.settlement_price || 0),
          cost_price: Number(g.costPrice || g.cost_price || g.purchasePrice || g.purchase_price || g.importPrice || g.import_price || g.cost || g.settlementPrice || g.settlement_price || 0),
          imei1: g.imei1 || '',
          imei2: g.imei2 || '',
          customerSource: g.customerSource || '',
          customerSourceDetail: g.customerSourceDetail || ''
        };
      }),
      payments: mappedPayments,
      // 保留照片数据
      subsidyPhotos: orderData.subsidyPhotos || [],
      productPhotoUrls: orderData.productPhotoUrls || [],
      educationSubsidyPhotoUrl: orderData.educationSubsidyPhotoUrl || '',
      educationSubsidyCouponCode: orderData.educationSubsidyCouponCode || '',
      educationSubsidyOcrText: orderData.educationSubsidyOcrText || '',
      personalInfoPhoto: orderData.personalInfoPhoto || '',
      // 保留其他重要字段
      subsidyStatus: orderData.subsidyStatus || '',
      subsidyPerson: orderData.subsidyPerson || '',
      subsidyId: orderData.subsidyId || '',
      invoiceStatus: orderData.invoiceStatus || '',
      invoiceInfo: orderData.invoiceInfo || '',
      invoiceAmount: orderData.invoiceAmount || '',
      freightAmount: orderData.freightAmount || '',
      supplements: orderData.supplements || [],
      supplementTotal: orderData.supplementTotal || 0,
      auxiliarySalesList: orderData.auxiliarySalesList || [],
      createUserPhone: orderData.createUserPhone || '',
      imei1: orderData.imei1 || '',
      imei2: orderData.imei2 || ''
    };

    // 创建未归档订单时只保存 PN/SN 文本，不校验商品或绑定库存记录。
    api.order.create(mappedData)
      .then(res => {
        console.log('订单保存成功', res);
        success && success(res);
      })
      .catch(err => {
        console.error('订单保存失败', err);
        fail && fail(err);
      });
  },

  /**
   * 更新订单状态
   * @param {string} orderNo 订单编号
   * @param {string} status 新状态
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  updateOrderStatus: function (orderNo, status, success, fail) {
    try {
      // 直接更新数据库
      Database.updateOrder(orderNo, { status: status }, (res) => {
        console.log('订单状态更新成功', res);
        success && success(res);
      }, (err) => {
        console.error('订单状态更新失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('更新订单状态失败', error);
      fail && fail(error);
    }
  },

  /**
   * 更新订单数据
   * @param {string} orderNo 订单编号
   * @param {Object} updateData 更新的数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  updateOrder: function (orderNo, updateData, success, fail) {
    try {
      Database.updateOrder(orderNo, updateData, (res) => {
        console.log('订单更新成功', res);
        success && success(res);
      }, (err) => {
        console.error('订单更新失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('更新订单失败', error);
      fail && fail(error);
    }
  },

  /**
   * 获取订单列表
   * @param {function} success 成功回调
   */
  getOrders: function (success, fail) {
    api.order.queryList({ page: 1, pageSize: 100 })
      .then(result => {
        const orders = (result && result.data) || result || [];
        success && success(orders);
      })
      .catch(err => {
        console.error('API 获取订单列表失败', err);
        fail && fail(err);
        success && success([]);
      });
  },

  /**
   * 删除订单
   * @param {string} orderNo 订单编号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteOrder: function (orderNo, success, fail) {
    try {
      // 直接从数据库删除
      Database.deleteOrder(orderNo, (res) => {
        console.log('订单删除成功', res);
        success && success(res);
      }, (err) => {
        console.error('订单删除失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('删除订单失败', error);
      fail && fail(error);
    }
  },

  /**
   * 获取所有门店列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStores: function (success, fail) {
    const userInfo = wx.getStorageSync('userInfo');
    if (!userInfo || !userInfo.phoneNumber || !http.getToken()) {
      success && success([]);
      return;
    }
    const distributorId = userInfo ? userInfo.distributorId : '';
    api.store.getStores(distributorId)
      .then(result => {
        const stores = (result && result.data) || result || [];
        success && success(stores);
      })
      .catch(err => {
        console.error('API 获取门店列表失败:', err);
        fail && fail(err);
        success && success([]);
      });
  },

  /**
   * 根据门店ID获取门店信息
   * @param {string} storeId 门店ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStoreById: function (storeId, success, fail) {
    this.getStores((stores) => {
      const store = stores.find(store => store.storeId === storeId || store.id === storeId);
      success && success(store);
    }, fail);
  },

  /**
   * 保存门店信息（新增或更新）
   * @param {Object} storeInfo 门店信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveStore: function (storeInfo, success, fail) {
    try {
      // 确保staffList存在
      if (!storeInfo.staffList) {
        storeInfo.staffList = [];
      }

      // 如果没有distributorId，尝试从经销商信息中获取
      if (!storeInfo.distributorId) {
        const distributorInfo = wx.getStorageSync('distributorInfo');
        if (distributorInfo && distributorInfo.id) {
          storeInfo.distributorId = distributorInfo.id;
        }
      }

      // 直接保存到数据库
      Database.saveStore(storeInfo, (res) => {
        console.log('门店保存成功', res);
        success && success(res);
      }, (err) => {
        console.error('门店保存失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('保存门店信息失败', error);
      fail && fail(error);
    }
  },

  /**
   * 删除门店信息
   * @param {string} storeId 门店ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteStore: function (storeId, success, fail) {
    try {
      // 直接从数据库删除
      Database.deleteStore(storeId, (res) => {
        console.log('门店删除成功', res);
        success && success(res);
      }, (err) => {
        console.error('门店删除失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('删除门店信息失败', error);
      fail && fail(error);
    }
  },

  /**
   * 获取门店信息（保持向后兼容）
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStoreInfo: function (success, fail) {
    const currentStoreInfo = getCurrentStoreInfo();
    const userInfo = currentStoreInfo.userInfo || {};
    const roleValues = [userInfo.userRole, userInfo.role, userInfo.roleCode]
      .concat(Array.isArray(userInfo.roles) ? userInfo.roles : [])
      .map(role => String(role || '').trim().toLowerCase())
      .filter(Boolean);
    const isStoreScoped = roleValues.length > 0
      && roleValues.every(role => ['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role));
    const currentStoreId = currentStoreInfo.storeId || userInfo.storeId || '';
    const currentStoreName = currentStoreInfo.storeName || userInfo.storeName || '';
    if (!isStoreScoped) {
      success && success({
        storeId: '',
        name: userInfo.distributorName || '经销商门店范围',
        address: '',
        phone: '',
        managerName: '',
        managerPhone: '',
        staffList: []
      });
      return;
    }
    this.getStores((stores) => {
      const store = stores.find(item => String(item.storeId || item.store_id || item.id || item._id || '') === String(currentStoreId)) || stores[0];
      success && success(store || {
        storeId: currentStoreId || 'STORE_DEFAULT',
        name: currentStoreName || '联想授权经销商',
        address: '',
        phone: '',
        managerName: '',
        managerPhone: '',
        staffList: []
      });
    }, (err) => {
      fail && fail(err);
      success && success({
        storeId: currentStoreId || 'STORE_DEFAULT',
        name: currentStoreName || '联想授权经销商',
        address: '',
        phone: '',
        managerName: '',
        managerPhone: '',
        staffList: []
      });
    });
  },

  /**
   * 保存门店信息（保持向后兼容）
   * @param {Object} storeInfo 门店信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveStoreInfo: function (storeInfo, success, fail) {
    // 确保storeInfo有storeId
    if (!storeInfo.storeId) {
      storeInfo.storeId = 'STORE_1';
    }

    // 使用新的saveStore函数保存
    this.saveStore(storeInfo, success, fail);
  },

  /**
   * 根据经销商ID获取门店列表
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStoresByDistributor: function (distributorId, success, fail) {
    try {
      Database.getStoresByDistributor(distributorId, (stores) => {
        console.log('获取经销商门店列表成功', stores);
        success && success(stores);
      }, (err) => {
        console.error('获取经销商门店列表失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('获取经销商门店列表失败', error);
      fail && fail(error);
    }
  },

  /**
   * 获取经销商下所有人员（包括经销商人员和所有门店人员）
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getAllStaffByDistributor: function (distributorId, success, fail) {
    const currentUser = wx.getStorageSync('userInfo') || {};
    const currentRole = String(currentUser.roleCode || currentUser.role || currentUser.userRole || '').toLowerCase();
    const canAccessSystemUsers = ['admin', 'boss', 'distributor', 'system_admin'].indexOf(currentRole) >= 0;
    const normalizeStaff = (item = {}) => {
      const name = item.name || item.userName || item.managerName || item.nickName || item.phone || item.phoneNumber || '';
      return name ? {
        staffId: item.staffId || item.staff_id || item.id || item._id || '',
        name: String(name).trim(),
        phone: item.phone || item.phoneNumber || item.managerPhone || '',
        role: item.role || item.userRole || item.roleCode || '',
        storeId: item.storeId || item.store_id || '',
        storeName: item.storeName || item.store_name || '',
        regionId: item.regionId || item.region_id || '',
        regionName: item.regionName || item.region_name || '',
        regionCodes: item.regionCodes || item.region_codes || [],
        distributorId: item.distributorId || item.distributor_id || distributorId || ''
      } : null;
    };
    const addStaff = (target, item) => {
      const staff = normalizeStaff(item);
      if (!staff) return false;
      const existing = target.find(current => {
        if (staff.staffId && current.staffId && String(staff.staffId) === String(current.staffId)) return true;
        if (staff.phone && current.phone && String(staff.phone) === String(current.phone)) return true;
        return (
          staff.name === current.name &&
          String(staff.storeId || staff.storeName || '') === String(current.storeId || current.storeName || '')
        );
      });
      if (!existing) {
        target.push(staff);
        return true;
      }
      Object.keys(staff).forEach(field => {
        if (
          (
            existing[field] === undefined ||
            existing[field] === null ||
            existing[field] === '' ||
            (Array.isArray(existing[field]) && existing[field].length === 0)
          ) &&
          staff[field] !== undefined && staff[field] !== null && staff[field] !== ''
        ) {
          existing[field] = staff[field];
        }
      });
      return false;
    };

    const loadAllUsers = (page = 1, accumulated = []) => {
      const pageSize = 200;
      return api.system.getUsers({ distributorId, page, pageSize }).then(result => {
        const rows = Array.isArray(result) ? result : ((result && result.data) || []);
        let addedCount = 0;
        rows.forEach(row => {
          if (addStaff(accumulated, row)) addedCount += 1;
        });
        // 继续请求直到空页；若后端忽略 page，addedCount 为 0 时会立即停止。
        if (rows.length > 0 && addedCount > 0 && page < 50) {
          return loadAllUsers(page + 1, accumulated);
        }
        return accumulated;
      });
    };

    const loadFallbackStaff = () => {
      const tasks = [
        api.store.getStores(distributorId).catch(() => []),
        Promise.resolve(wx.getStorageSync('distributorInfo') || null),
        canAccessSystemUsers ? loadAllUsers().catch(() => []) : Promise.resolve([])
      ];

      return Promise.all(tasks)
        .then(([storesResult, distributorInfo, usersResult]) => {
          const staffList = [];
          const stores = Array.isArray(storesResult) ? storesResult : ((storesResult && storesResult.data) || []);
          const storesById = {};
          stores.forEach(store => {
            const storeId = store.storeId || store.store_id || store.id || store._id || '';
            if (storeId) storesById[String(storeId)] = store;
            addStaff(staffList, {
              name: store.managerName,
              phone: store.managerPhone,
              role: 'store_admin',
              storeId,
              storeName: store.name || store.storeName || store.store_name || '',
              regionId: store.regionId || store.region_id || '',
              regionName: store.regionName || store.region_name || ''
            });
            (store.staffList || []).forEach(staff => addStaff(staffList, Object.assign({}, staff, {
              storeId,
              storeName: store.name || store.storeName || store.store_name || '',
              regionId: store.regionId || store.region_id || '',
              regionName: store.regionName || store.region_name || ''
            })));
          });

          ((distributorInfo && distributorInfo.staffList) || []).forEach(staff => addStaff(staffList, staff));
          const users = Array.isArray(usersResult) ? usersResult : ((usersResult && usersResult.data) || []);
          users.forEach(user => {
            const storeId = user.storeId || user.store_id || '';
            const store = storesById[String(storeId)] || {};
            addStaff(staffList, Object.assign({}, user, {
              storeId,
              storeName: user.storeName || user.store_name || store.name || store.storeName || store.store_name || '',
              regionId: user.regionId || user.region_id || store.regionId || store.region_id || '',
              regionName: user.regionName || user.region_name || store.regionName || store.region_name || ''
            }));
          });

          return staffList;
        });
    };

    const loadRemoteStaff = api.order && api.order.getAuxiliaryStaff
      ? api.order.getAuxiliaryStaff({
        distributorId: distributorId || currentUser.distributorId || '',
        storeId: currentUser.storeId || '',
        regionId: currentUser.regionId || ''
      }).then(result => {
        const rows = Array.isArray(result) ? result : ((result && result.data) || []);
        const staffList = [];
        rows.forEach(row => addStaff(staffList, row));
        return staffList;
      })
      : Promise.reject(new Error('辅助销售人接口未配置'));

    loadRemoteStaff
      .catch(error => {
        console.warn('load auxiliary staff from remote failed, merging fallback only:', error);
        return [];
      })
      .then(remoteStaffList => {
        return loadFallbackStaff()
          .catch(error => {
            console.warn('load auxiliary staff fallback failed, using remote result only:', error);
            return [];
          })
          .then(fallbackStaffList => {
            const staffList = [];
            (fallbackStaffList || []).forEach(staff => addStaff(staffList, staff));
            (remoteStaffList || []).forEach(staff => addStaff(staffList, staff));
            success && success(staffList);
            return null;
          });
      })
      .catch(error => {
        console.error('获取经销商所有人员失败', error);
        fail && fail(error);
      });
  },

  /**
   * 获取客户来源列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getCustomerSources: function (success, fail) {
    api.dict.getCustomerSources()
      .then(sources => {
        wx.setStorageSync('customerSources', sources);
        success && success(sources);
      })
      .catch(err => {
        console.error('API 获取客户来源列表失败', err);
        fail && fail(err);
        success && success(this.getCustomerSourcesFromLocal());
      });
  },

  /**
   * 从本地存储获取客户来源列表（降级方案）
   * @returns {Array} 客户来源列表
   */
  getCustomerSourcesFromLocal: function () {
    try {
      const sources = wx.getStorageSync('customerSources') || [];
      console.log('从本地存储获取客户来源列表成功', sources);
      return sources;
    } catch (error) {
      console.error('从本地存储获取客户来源列表失败', error);
      return [];
    }
  },

  getCustomerSourcesByLevel: function (level, success, fail) {
    this.getCustomerSources((sources) => {
      success && success((sources || []).filter(s => Number(s.level) === Number(level)));
    }, fail);
  },

  getCustomerSourcesByParent: function (parentId, success, fail) {
    this.getCustomerSources((sources) => {
      success && success((sources || []).filter(s => s.parentId === parentId));
    }, fail);
  },

  /**
   * 保存客户来源
   * @param {Object} sourceData 客户来源数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveCustomerSource: function (sourceData, success, fail) {
    api.dict.saveCustomerSource(sourceData)
      .then(res => {
        success && success(res);
      })
      .catch(err => {
        console.error('API 保存客户来源失败', err);
        fail && fail(err);
      });
  },

  /**
   * 保存客户来源到本地存储（降级方案）
   * @param {Object} sourceData 客户来源数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveCustomerSourceToLocal: function (sourceData, success, fail) {
    try {
      // 从本地存储获取现有客户来源
      const existingSources = wx.getStorageSync('customerSources') || [];

      if (sourceData.id) {
        // 更新现有客户来源
        const index = existingSources.findIndex(source => source.id === sourceData.id);
        if (index !== -1) {
          existingSources[index] = {
            ...sourceData,
            updateTime: new Date().toISOString()
          };
        } else {
          existingSources.push({
            ...sourceData,
            updateTime: new Date().toISOString()
          });
        }
      } else {
        // 新增客户来源
        const newSourceData = {
          ...sourceData,
          id: 'SOURCE_' + Date.now(),
          createTime: new Date().toISOString(),
          updateTime: new Date().toISOString()
        };
        existingSources.push(newSourceData);
      }

      // 保存到本地存储
      wx.setStorageSync('customerSources', existingSources);
      console.log('客户来源保存到本地成功', existingSources);
      success && success({ local: true, data: existingSources });
    } catch (error) {
      console.error('保存客户来源到本地失败', error);
      fail && fail(error);
    }
  },

  /**
   * 删除客户来源
   * @param {string} sourceId 客户来源ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteCustomerSource: function (sourceId, success, fail) {
    api.dict.deleteCustomerSource(sourceId).then(success).catch(err => {
      console.error('API 删除客户来源失败', err);
      fail && fail(err);
    });
  },

  /**
   * 获取收款方式列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getPaymentMethods: function (success, fail) {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const currentStoreInfo = getCurrentStoreInfo();
    api.dict.getPaymentMethods(currentStoreInfo.storeId || userInfo.storeId)
      .then(methods => {
        wx.setStorageSync('paymentMethods', methods);
        success && success(methods);
      })
      .catch(err => {
        console.error('API 获取收款方式列表失败', err);
        fail && fail(err);
        success && success(this.getPaymentMethodsFromLocal());
      });
  },

  /**
   * 从本地存储获取收款方式列表（降级方案）
   * @returns {Array} 收款方式列表
   */
  getPaymentMethodsFromLocal: function () {
    try {
      const methods = wx.getStorageSync('paymentMethods') || [];
      console.log('从本地存储获取收款方式列表成功', methods);
      return methods;
    } catch (error) {
      console.error('从本地存储获取收款方式列表失败', error);
      return [];
    }
  },

  /**
   * 保存收款方式
   * @param {Object} methodData 收款方式数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  savePaymentMethod: function (methodData, success, fail) {
    api.dict.savePaymentMethod(methodData)
      .then(res => {
        success && success(res);
      })
      .catch(err => {
        console.error('API 保存收款方式失败', err);
        fail && fail(err);
      });
  },

  /**
   * 保存收款方式到本地存储（降级方案）
   * @param {Object} methodData 收款方式数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  savePaymentMethodToLocal: function (methodData, success, fail) {
    try {
      // 从本地存储获取现有收款方式
      const existingMethods = wx.getStorageSync('paymentMethods') || [];

      if (methodData.id) {
        // 更新现有收款方式
        const index = existingMethods.findIndex(method => method.id === methodData.id);
        if (index !== -1) {
          existingMethods[index] = {
            ...methodData,
            updateTime: new Date().toISOString()
          };
        } else {
          existingMethods.push({
            ...methodData,
            updateTime: new Date().toISOString()
          });
        }
      } else {
        // 新增收款方式
        const newMethodData = {
          ...methodData,
          id: 'PAYMENT_' + Date.now(),
          createTime: new Date().toISOString(),
          updateTime: new Date().toISOString()
        };
        existingMethods.push(newMethodData);
      }

      // 保存到本地存储
      wx.setStorageSync('paymentMethods', existingMethods);
      console.log('收款方式保存到本地成功', existingMethods);
      success && success({ local: true, data: existingMethods });
    } catch (error) {
      console.error('保存收款方式到本地失败', error);
      fail && fail(error);
    }
  },

  /**
   * 删除收款方式
   * @param {string} methodId 收款方式ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deletePaymentMethod: function (methodId, success, fail) {
    api.dict.deletePaymentMethod(methodId).then(success).catch(err => {
      console.error('API 删除收款方式失败', err);
      fail && fail(err);
    });
  },

  /**
   * 保存经销商信息
   * @param {Object} distributorInfo 经销商信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveDistributorInfo: function (distributorInfo, success, fail) {
    try {
      console.log('开始保存经销商信息:', distributorInfo);

      // 清理系统管理字段
      const cleanDistributorInfo = { ...distributorInfo };
      delete cleanDistributorInfo._openid;
      delete cleanDistributorInfo._id;
      delete cleanDistributorInfo._createTime;
      delete cleanDistributorInfo._updateTime;
      console.log('清理后的经销商信息:', cleanDistributorInfo);

      // 检查云开发环境是否可用
      const app = getApp();
      const cloudAvailable = app.isCloudAvailable();
      console.log('云开发环境状态:', cloudAvailable);
      console.log('云开发详细状态:', app.getCloudStatus());

      if (cloudAvailable) {
        // 直接保存到数据库
        console.log('使用云开发保存经销商信息');
        Database.saveDistributorInfo(cleanDistributorInfo, (res) => {
          console.log('经销商信息保存成功', res);
          // 同时保存到本地存储作为备份
          try {
            wx.setStorageSync('distributorInfo', cleanDistributorInfo);
            console.log('经销商信息保存到本地成功');
          } catch (localError) {
            console.error('备份到本地存储失败', localError);
          }
          success && success(res);
        }, (err) => {
          console.error('经销商信息保存失败', err);
          // 数据库保存失败，使用本地存储作为降级方案
          try {
            wx.setStorageSync('distributorInfo', cleanDistributorInfo);
            console.log('经销商信息保存到本地成功（降级方案）');
            success && success({ local: true });
          } catch (localError) {
            console.error('保存到本地存储失败', localError);
            fail && fail(localError);
          }
        });
      } else {
        // 云开发环境不可用，使用本地存储
        console.log('云开发环境不可用，使用本地存储');
        try {
          wx.setStorageSync('distributorInfo', cleanDistributorInfo);
          console.log('经销商信息保存到本地成功');
          success && success({ local: true });
        } catch (error) {
          console.error('保存到本地存储失败', error);
          fail && fail(error);
        }
      }
    } catch (error) {
      console.error('保存经销商信息失败', error);
      fail && fail(error);
    }
  },

  /**
   * 获取经销商信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getDistributorInfo: function (success, fail) {
    // 从 userInfo 获取 distributorId
    const userInfo = wx.getStorageSync('userInfo');
    const distributorId = userInfo ? userInfo.distributorId : '';
    
    console.log('getDistributorInfo - 从 userInfo 获取 distributorId:', distributorId);
    
    if (!distributorId) {
      success && success(null);
      return;
    }

    api.store.getDistributor(distributorId)
      .then(result => {
        // api 返回的是 { code: 200, data: {...} }
        const info = (result && result.data) || result || null;
        if (info) wx.setStorageSync('distributorInfo', info);
        success && success(info);
      })
      .catch(err => {
        console.error('获取经销商信息失败', err);
        success && success(null);
      });
  },

  /**
   * 根据ID获取经销商信息
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getDistributorById: function (distributorId, success, fail) {
    try {
      // 检查云开发环境是否可用
      const app = getApp();
      const cloudAvailable = app.isCloudAvailable();

      if (cloudAvailable) {
        // 从数据库根据ID获取
        Database.getDistributorById(distributorId, (distributorInfo) => {
          if (distributorInfo) {
            console.log('根据ID获取经销商信息成功', distributorInfo);
            success && success(distributorInfo);
          } else {
            console.log('数据库中没有该经销商信息，尝试获取默认经销商');
            // 尝试获取默认经销商
            this.getDistributorInfo((defaultInfo) => {
              success && success(defaultInfo);
            });
          }
        }, (err) => {
          console.error('根据ID获取经销商信息失败', err);
          fail && fail(err);
        });
      } else {
        // 云开发环境不可用，使用本地存储
        const localDistributorInfo = this.getDistributorInfoFromLocal();
        // 检查ID是否匹配
        if (localDistributorInfo && (localDistributorInfo.id === distributorId || localDistributorInfo._id === distributorId)) {
          success && success(localDistributorInfo);
        } else {
          success && success(null);
        }
      }
    } catch (error) {
      console.error('根据ID获取经销商信息失败', error);
      fail && fail(error);
    }
  },

  /**
   * 从本地存储获取经销商信息（降级方案）
   * @returns {Object} 经销商信息
   */
  getDistributorInfoFromLocal: function () {
    try {
      const distributorInfo = wx.getStorageSync('distributorInfo');
      if (distributorInfo) {
        console.log('从本地存储获取经销商信息成功', distributorInfo);
        return distributorInfo;
      } else {
        // 返回默认经销商信息
        const defaultDistributorInfo = {
          id: 'DISTRIBUTOR_1',
          name: '成都艾诺云科技有限公司',
          address: '四川省成都市力宝大厦南楼1013',
          phone: '',
          staffList: []
        };
        // 保存默认值到本地存储
        wx.setStorageSync('distributorInfo', defaultDistributorInfo);
        return defaultDistributorInfo;
      }
    } catch (error) {
      console.error('从本地存储获取经销商信息失败', error);
      // 返回默认经销商信息
      return {
        id: 'DISTRIBUTOR_1',
        name: '成都艾诺云科技有限公司',
        address: '四川省成都市力宝大厦南楼1013',
        phone: '',
        staffList: []
      };
    }
  },

  /**
   * 保存商品信息
   * @param {Object} goodsData 商品数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveGoods: function (goodsData, success, fail) {
    try {
      // 检查云开发环境是否可用
      const app = getApp();
      const cloudAvailable = app.isCloudAvailable();

      if (cloudAvailable) {
        // 直接保存到数据库
        Database.saveGoods(goodsData, (res) => {
          console.log('商品保存成功', res);
          success && success(res);
        }, (err) => {
          console.error('商品保存失败', err);
          // 数据库保存失败，使用本地存储作为降级方案
          this.saveGoodsToLocal(goodsData, success, fail);
        });
      } else {
        // 云开发环境不可用，使用本地存储
        this.saveGoodsToLocal(goodsData, success, fail);
      }
    } catch (error) {
      console.error('保存商品失败', error);
      // 异常时使用本地存储作为降级方案
      this.saveGoodsToLocal(goodsData, success, fail);
    }
  },

  /**
   * 批量保存商品信息
   * @param {Array} goodsList 商品列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  batchSaveGoods: function (goodsList, success, fail) {
    try {
      console.log('开始批量保存商品到数据库，共', goodsList.length, '条记录');

      // 只保存到数据库，不使用本地存储
      Database.batchSaveGoods(goodsList, (res) => {
        console.log('批量保存商品到数据库成功', res);
        success && success(res);
      }, (err) => {
        console.error('批量保存商品到数据库失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('批量保存商品失败', error);
      fail && fail(error);
    }
  },



  /**
   * 根据SN码获取商品信息
   * @param {string} sn SN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getGoodsBySN: function (sn, success, fail) {
    const storeId = getCurrentStoreInfo().storeId || '';
    api.inventory.getGoodsBySN(sn, storeId)
      .then(inv => {
        console.log('getGoodsBySN 返回:', inv);
        if (inv) {
          success && success({
            productId: inv.productId || '',
            inventoryId: inv.inventoryId || '',
            name: inv.product_name || inv.productName || inv.name || '',
             price: inv.price || 0,
             standardPrice: inv.standardPrice || inv.standard_price || inv.price || 0,
             minSalePrice: inv.minSalePrice || inv.min_sale_price || inv.minimumSalePrice || inv.minimum_sale_price || inv.minPrice || inv.min_price || inv.lowestSalePrice || inv.lowest_sale_price || inv.lowPrice || inv.low_price || inv.floorPrice || inv.floor_price || 0,
             settlementPrice: inv.settlementPrice || inv.settlement_price || inv.min_sale_price || inv.price || 0,
            costPrice: inv.costPrice || inv.cost_price || inv.purchasePrice || inv.purchase_price || inv.importPrice || inv.import_price || inv.cost || inv.settlementPrice || inv.settlement_price || inv.min_sale_price || inv.price || 0,
            currentStoreStockQty: Number(inv.currentStoreStockQty || inv.current_store_stock_qty || 0),
            otherStoreStockQty: Number(inv.otherStoreStockQty || inv.other_store_stock_qty || 0),
            totalStockQty: Number(inv.totalStockQty || inv.total_stock_qty || 0),
            pnCode: inv.pnCode || '',
            snCode: normalizeSnCode(inv.snCode || sn),
            needSn: normalizeNeedSn(inv.needSn)
          });
        } else {
          success && success(null);
        }
      })
      .catch(err => {
        console.error('获取SN商品信息失败', err);
        fail && fail(err);
      });
  },

  /**
   * 根据PN码获取商品信息
   * @param {string} pn PN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getGoodsByPN: function (pn, success, fail) {
    const storeId = getCurrentStoreInfo().storeId || '';
    api.inventory.getGoodsByPN(pn, storeId)
      .then(product => {
        console.log('getGoodsByPN 返回:', product);
        if (product) {
          success && success({
            productId: product.productId || '',
            name: product.name || '',
            price: product.price || 0,
            standardPrice: product.standardPrice || product.standard_price || product.price || 0,
            minSalePrice: product.minSalePrice || product.min_sale_price || product.minimumSalePrice || product.minimum_sale_price || product.minPrice || product.min_price || product.lowestSalePrice || product.lowest_sale_price || product.lowPrice || product.low_price || product.floorPrice || product.floor_price || 0,
            settlementPrice: product.settlementPrice || product.settlement_price || product.min_sale_price || product.price || 0,
            costPrice: product.costPrice || product.cost_price || product.purchasePrice || product.purchase_price || product.importPrice || product.import_price || product.cost || product.settlementPrice || product.settlement_price || product.min_sale_price || product.price || 0,
            currentStoreStockQty: Number(product.currentStoreStockQty || product.current_store_stock_qty || 0),
            otherStoreStockQty: Number(product.otherStoreStockQty || product.other_store_stock_qty || 0),
            totalStockQty: Number(product.totalStockQty || product.total_stock_qty || 0),
            pnCode: product.pnCode || pn,
            needSn: normalizeNeedSn(product.needSn)
          });
        } else {
          success && success(null);
        }
      })
      .catch(err => {
        console.error('获取PN商品信息失败', err);
        fail && fail(err);
      });
  },

  /**
   * 根据商品名称搜索商品
   * @param {Array} keywords 关键词数组
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  searchGoodsByName: function (keywords, success, fail) {
    if (!keywords || keywords.length === 0) {
      success && success([]);
      return;
    }

    // 使用第一个关键词进行搜索
    const searchKeyword = keywords[0];
    console.log('searchGoodsByName - 搜索关键词:', searchKeyword);

    api.inventory.searchByName(searchKeyword)
      .then(goods => {
        console.log('searchGoodsByName 返回:', goods);
        if (goods && Array.isArray(goods)) {
          const formattedGoods = goods.map(item => ({
            productId: item.productId || '',
            pnCode: item.pnCode || '',
            name: item.name || item.NAME || '',
           price: item.price || item.PRICE || 0,
            standardPrice: item.standardPrice || item.standard_price || item.PRICE || item.price || 0,
            minSalePrice: item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0,
            settlementPrice: item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || 0,
            costPrice: item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || 0,
            currentStoreStockQty: Number(item.currentStoreStockQty || item.current_store_stock_qty || 0),
            otherStoreStockQty: Number(item.otherStoreStockQty || item.other_store_stock_qty || 0),
            totalStockQty: Number(item.totalStockQty || item.total_stock_qty || 0),
            needSn: normalizeNeedSn(item.needSn)
          }));
          success && success(formattedGoods);
        } else {
          success && success([]);
        }
      })
      .catch(err => {
        console.error('搜索商品失败', err);
        fail && fail(err);
        success && success([]);
      });
  },



  /**
   * 获取最近的订单记录，用于当扫描无结果时的 fallback 机制
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getRecentOrder: function (success, fail) {
    try {
      // 直接从数据库获取最近的订单
      Database.getOrders((orders) => {
        if (orders && orders.length > 0) {
          // 按创建时间排序，取最近的一条
          const recentOrder = orders[0];
          console.log('获取最近订单成功', recentOrder);
          success && success(recentOrder);
        } else {
          success && success(null);
        }
      }, (err) => {
        console.error('获取最近订单失败', err);
        // 数据库获取失败，返回null
        success && success(null);
      });
    } catch (error) {
      console.error('获取最近订单失败', error);
      // 异常时返回null
      success && success(null);
    }
  },

  /**
   * 根据手机号获取用户信息
   * @param {string} phoneNumber 手机号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getUserByPhone: function (phoneNumber, success, fail) {
    try {
      Database.getUserByPhone(phoneNumber, (user) => {
        console.log('根据手机号获取用户成功', user);
        success && success(user);
      }, (err) => {
        console.error('根据手机号获取用户失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('根据手机号获取用户异常', error);
      fail && fail(error);
    }
  },

  /**
   * 保存用户信息
   * @param {Object} userData 用户数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveUser: function (userData, success, fail) {
    try {
      Database.saveUser(userData, (res) => {
        console.log('保存用户成功', res);
        success && success(res);
      }, (err) => {
        console.error('保存用户失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('保存用户异常', error);
      fail && fail(error);
    }
  },

  /**
   * 验证用户密码
   * @param {string} phoneNumber 手机号
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  verifyUserPassword: function (phoneNumber, password, success, fail) {
    api.auth.login(phoneNumber, password)
      .then(user => {
        console.log('验证用户登录成功', user);
        success && success(user);
      })
      .catch(err => {
        console.error('验证用户登录失败', err);
        // 保留 statusCode、错误类型等信息，页面才能区分密码错误和服务冷启动。
        fail && fail(err);
      });
  },

  /**
   * 修改用户密码
   * @param {string} userId 用户ID
   * @param {string} oldPassword 旧密码
   * @param {string} newPassword 新密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  changeUserPassword: function (userId, oldPassword, newPassword, success, fail) {
    try {
      Database.changeUserPassword(userId, oldPassword, newPassword, (res) => {
        console.log('修改密码成功', res);
        success && success(res);
      }, (err) => {
        console.error('修改密码失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('修改密码异常', error);
      fail && fail(error);
    }
  },

  /**
   * 重置用户密码（经销商使用）
   * @param {string} phoneNumber 手机号
   * @param {string} newPassword 新密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  resetUserPassword: function (phoneNumber, newPassword, success, fail) {
    try {
      Database.resetUserPassword(phoneNumber, newPassword, (res) => {
        console.log('重置密码成功', res);
        success && success(res);
      }, (err) => {
        console.error('重置密码失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('重置密码异常', error);
      fail && fail(error);
    }
  },

  /**
   * 获取经销商下所有用户
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getUsersByDistributor: function (distributorId, success, fail) {
    try {
      Database.getUsersByDistributor(distributorId, (users) => {
        console.log('获取用户列表成功', users);
        success && success(users);
      }, (err) => {
        console.error('获取用户列表失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('获取用户列表异常', error);
      fail && fail(error);
    }
  },

  /**
   * 保存用户密码到 users 集合
   * @param {Object} userData 用户数据
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveUserPassword: function (userData, password, success, fail) {
    try {
      Database.saveUserPassword(userData, password, (res) => {
        console.log('保存用户密码成功', res);
        success && success(res);
      }, (err) => {
        console.error('保存用户密码失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('保存用户密码异常', error);
      fail && fail(error);
    }
  },

  /**
   * 更新经销商密码
   * @param {string} distributorId 经销商ID
   * @param {string} phoneNumber 手机号
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  updateDistributorPassword: function (distributorId, phoneNumber, password, success, fail) {
    try {
      Database.updateDistributorPassword(distributorId, phoneNumber, password, (res) => {
        console.log('更新经销商密码成功', res);
        success && success(res);
      }, (err) => {
        console.error('更新经销商密码失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('更新经销商密码异常', error);
      fail && fail(error);
    }
  },

  /**
   * 更新门店密码
   * @param {string} storeId 门店ID
   * @param {string} phoneNumber 手机号
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  updateStorePassword: function (storeId, phoneNumber, password, success, fail) {
    try {
      Database.updateStorePassword(storeId, phoneNumber, password, (res) => {
        console.log('更新门店密码成功', res);
        success && success(res);
      }, (err) => {
        console.error('更新门店密码失败', err);
        fail && fail(err);
      });
    } catch (error) {
      console.error('更新门店密码异常', error);
      fail && fail(error);
    }
  }
};

module.exports = DataStorage;
