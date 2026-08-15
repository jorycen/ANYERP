// utils/database.js
const api = require('./api.js');

/**
 * 数据库操作工具类
 * 使用微信云开发的数据库服务
 */
const Database = {
  // 调试模式开关
  _debug: true, // 设为false关闭详细日志
  
  // 本地缓存对象，用于存储最近查询的商品信息
  _cache: {
    snCache: {}, // SN码缓存
    pnCache: {}, // PN码缓存
    maxCacheSize: 100 // 最大缓存数量
  },

  /**
   * 调试日志输出
   * @param {...any} args 日志参数
   */
  _log: function(...args) {
    if (this._debug) {
      console.log(...args);
    }
  },

  /**
   * 错误日志输出
   * @param {...any} args 错误参数
   */
  _error: function(...args) {
    if (this._debug) {
      console.error(...args);
    }
  },

  /**
   * 处理集合不存在的错误
   * @param {Object} err 错误对象
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   * @returns {boolean} 是否为集合不存在的错误
   */
  _handleCollectionError: function(err, success, fail) {
    if (err.errCode === -502005 || err.errMsg.includes('collection not exists')) {
      this._log('goods集合不存在，尝试创建...');
      // 创建一个测试商品来触发集合创建
      this.saveGoods({
        id: 'TEST_' + Date.now(),
        NAME: '测试商品',
        PN: 'TEST_PN',
        SN: 'TEST_SN',
        PRICE: 0
      }, (res) => {
        this._log('goods集合创建成功:', res);
        success && success(null);
      }, (err2) => {
        this._log('goods集合创建失败:', err2);
        success && success(null);
      });
      return true;
    }
    return false;
  },

  /**
   * 初始化数据库连接
   */
  init: function() {
    try {
      // 初始化云开发环境
      wx.cloud.init({
        env: 'cloud1-8glwjlnq4c74f7f1',
        traceUser: true
      });
      console.log('数据库初始化成功');
    } catch (error) {
      console.error('数据库初始化失败:', error);
    }
  },

  /**
   * 标准化查询键
   * @param {string} key 原始键
   * @returns {string} 标准化后的键
   */
  _normalizeKey: function(key) {
    return key.trim().toLowerCase();
  },

  /**
   * 添加商品到缓存
   * @param {string} type 缓存类型：'sn' 或 'pn'
   * @param {string} key 缓存键
   * @param {Object} goods 商品信息
   */
  _addToCache: function(type, key, goods) {
    const cache = type === 'sn' ? this._cache.snCache : this._cache.pnCache;
    const normalizedKey = this._normalizeKey(key);
    
    // 添加到缓存
    cache[normalizedKey] = goods;
    
    // 检查缓存大小，如果超过限制，删除最早的缓存
    const keys = Object.keys(cache);
    if (keys.length > this._cache.maxCacheSize) {
      // 简单实现：删除第一个缓存项
      delete cache[keys[0]];
    }
  },

  /**
   * 从缓存中获取商品
   * @param {string} type 缓存类型：'sn' 或 'pn'
   * @param {string} key 缓存键
   * @returns {Object|null} 商品信息或null
   */
  _getFromCache: function(type, key) {
    const cache = type === 'sn' ? this._cache.snCache : this._cache.pnCache;
    const normalizedKey = this._normalizeKey(key);
    return cache[normalizedKey] || null;
  },

  /**
   * 获取数据库实例
   * @returns {Object} 数据库实例
   */
  getDB: function() {
    return wx.cloud.database();
  },

  /**
   * 获取集合实例
   * @param {string} collectionName 集合名称
   * @returns {Object} 集合实例
   */
  getCollection: function(collectionName) {
    const db = this.getDB();
    return db.collection(collectionName);
  },

  /**
   * 保存订单数据
   * @param {Object} orderData 订单数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveOrder: function(orderData, success, fail) {
    try {
      const ordersCollection = this.getCollection('orders');
      
      ordersCollection.add({
        data: {
          ...orderData,
          createTime: new Date(),
          updateTime: new Date()
        },
        success: (res) => {
          console.log('订单保存成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('订单保存失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('保存订单异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 更新订单数据
   * @param {string} orderNo 订单编号
   * @param {Object} updateData 更新数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  updateOrder: function(orderNo, updateData, success, fail) {
    try {
      console.log('开始更新订单:', orderNo, updateData);
      const ordersCollection = this.getCollection('orders');
      
      // 先查询订单是否存在（使用正则忽略大小写）
      ordersCollection.where({
        orderNo: orderNo
      }).get({
        success: (queryRes) => {
          console.log('查询订单结果:', queryRes);
          if (queryRes.data && queryRes.data.length > 0) {
            const docId = queryRes.data[0]._id;
            console.log('找到订单，docId:', docId);
            // 使用 doc 更新单条记录
            ordersCollection.doc(docId).update({
              data: {
                ...updateData,
                updateTime: new Date()
              },
              success: (res) => {
                console.log('订单更新成功:', res);
                success && success(res);
              },
              fail: (err) => {
                console.error('订单更新失败:', err);
                fail && fail(err);
              }
            });
          } else {
            // 如果通过 orderNo 找不到，尝试直接作为 _id 查询
            console.log('通过orderNo未找到，尝试作为_id查询:', orderNo);
            ordersCollection.doc(orderNo).get({
              success: (docRes) => {
                if (docRes.data) {
                  console.log('通过_id找到订单:', orderNo);
                  ordersCollection.doc(orderNo).update({
                    data: {
                      ...updateData,
                      updateTime: new Date()
                    },
                    success: (res) => {
                      console.log('订单更新成功:', res);
                      success && success(res);
                    },
                    fail: (err) => {
                      console.error('订单更新失败:', err);
                      fail && fail(err);
                    }
                  });
                } else {
                  console.error('订单不存在:', orderNo);
                  fail && fail(new Error('订单不存在'));
                }
              },
              fail: (err) => {
                console.error('订单不存在:', orderNo, err);
                fail && fail(new Error('订单不存在'));
              }
            });
          }
        },
        fail: (err) => {
          console.error('查询订单失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('更新订单异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取订单列表（支持分页查询，突破20条限制）
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getOrders: function(success, fail) {
    try {
      console.log('开始获取订单列表...');
      const ordersCollection = this.getCollection('orders');
      
      if (!ordersCollection) {
        console.log('orders集合获取失败');
        success && success([]);
        return;
      }
      
      // 使用分页查询获取所有订单
      const getAllOrders = (offset = 0, allData = []) => {
        const limit = 100; // 每次查询100条
        
        ordersCollection.orderBy('createTime', 'desc').skip(offset).limit(limit).get({
          success: (res) => {
            const currentData = res.data;
            const newData = allData.concat(currentData);
            
            console.log('获取订单批次成功，当前批次', currentData.length, '条，累计', newData.length, '条');
            
            if (currentData.length === limit) {
              // 还有更多数据，继续查询
              getAllOrders(offset + limit, newData);
            } else {
              // 已获取所有数据
              console.log('获取所有订单成功，共', newData.length, '条记录');
              success && success(newData);
            }
          },
          fail: (err) => {
            console.error('获取订单失败:', err);
            fail && fail(err);
            success && success([]);
          }
        });
      };
      
      // 开始分页查询
      getAllOrders();
    } catch (error) {
      console.error('获取订单列表异常:', error);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 根据订单编号获取订单
   * @param {string} orderNo 订单编号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getOrderByNo: function(orderNo, success, fail) {
    try {
      const ordersCollection = this.getCollection('orders');
      
      ordersCollection.where({
        orderNo: orderNo
      }).get({
        success: (res) => {
          console.log('获取订单成功:', res);
          success && success(res.data[0]);
        },
        fail: (err) => {
          console.error('获取订单失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('获取订单异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 删除订单
   * @param {string} orderNo 订单编号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteOrder: function(orderNo, success, fail) {
    try {
      const ordersCollection = this.getCollection('orders');
      
      ordersCollection.where({
        orderNo: orderNo
      }).remove({
        success: (res) => {
          console.log('订单删除成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('订单删除失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('删除订单异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 保存门店数据
   * @param {Object} storeData 门店数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveStore: function(storeData, success, fail) {
    try {
      console.log('开始保存门店信息, 输入数据:', storeData);
      const storesCollection = this.getCollection('stores');

      // 删除云数据库保留字段，避免更新失败
      const cleanStoreData = { ...storeData };
      delete cleanStoreData._openid;
      delete cleanStoreData._id;
      delete cleanStoreData._createTime;
      delete cleanStoreData._updateTime;
      delete cleanStoreData.createTime;

      // 处理员工列表，为没有密码的员工添加默认密码（手机号后6位）
      if (cleanStoreData.staffList && cleanStoreData.staffList.length > 0) {
        cleanStoreData.staffList = cleanStoreData.staffList.map(staff => {
          if (!staff.password && staff.phone) {
            const defaultPassword = staff.phone.slice(-6);
            return {
              ...staff,
              password: defaultPassword
            };
          }
          return staff;
        });
      }

      // 处理店长密码
      if (cleanStoreData.managerPhone && !cleanStoreData.managerPassword) {
        cleanStoreData.managerPassword = cleanStoreData.managerPhone.slice(-6);
      }

      // 准备更新数据
      const updateData = {
        ...cleanStoreData,
        updateTime: new Date()
      };

      // 尝试多种保存方式
      const trySave = (tryIndex = 0) => {
        console.log('尝试保存门店方式', tryIndex + 1);

        switch(tryIndex) {
          case 0:
            // 方式1: 使用 _id 字段作为 doc 更新
            if (storeData._id) {
              console.log('方式1: 使用 _id 更新门店:', storeData._id);
              storesCollection.doc(storeData._id).update({
                data: updateData,
                success: (res) => {
                  console.log('门店更新成功(方式1):', res);
                  success && success(res);
                },
                fail: (err) => {
                  console.log('门店更新失败(方式1):', err);
                  trySave(1);
                }
              });
              return;
            }
            trySave(1);
            break;

          case 1:
            // 方式2: 使用 storeId 字段查询并更新
            if (storeData.storeId) {
              console.log('方式2: 使用 storeId 查询并更新:', storeData.storeId);
              storesCollection.where({
                storeId: storeData.storeId
              }).get({
                success: (queryRes) => {
                  if (queryRes.data && queryRes.data.length > 0) {
                    const docId = queryRes.data[0]._id;
                    console.log('找到门店文档, 用 doc 更新:', docId);
                    storesCollection.doc(docId).update({
                      data: updateData,
                      success: (res) => {
                        console.log('门店更新成功(方式2):', res);
                        success && success(res);
                      },
                      fail: (err) => {
                        console.log('门店更新失败(方式2):', err);
                        trySave(2);
                      }
                    });
                  } else {
                    console.log('未找到匹配的门店, 尝试新增');
                    trySave(2);
                  }
                },
                fail: (err) => {
                  console.log('查询门店失败(方式2):', err);
                  trySave(2);
                }
              });
              return;
            }
            trySave(2);
            break;

          case 2:
            // 方式3: 如果用户有 storeId，尝试匹配
            const userInfo = wx.getStorageSync('userInfo');
            if (userInfo && userInfo.storeId) {
              console.log('方式3: 使用用户 storeId 查询并更新:', userInfo.storeId);
              storesCollection.where({
                storeId: userInfo.storeId
              }).get({
                success: (queryRes) => {
                  if (queryRes.data && queryRes.data.length > 0) {
                    const docId = queryRes.data[0]._id;
                    console.log('找到门店文档(方式3), 用 doc 更新:', docId);
                    storesCollection.doc(docId).update({
                      data: updateData,
                      success: (res) => {
                        console.log('门店更新成功(方式3):', res);
                        success && success(res);
                      },
                      fail: (err) => {
                        console.log('门店更新失败(方式3):', err);
                        trySave(3);
                      }
                    });
                  } else {
                    console.log('未找到匹配的门店(方式3), 尝试新增');
                    trySave(3);
                  }
                },
                fail: (err) => {
                  console.log('查询门店失败(方式3):', err);
                  trySave(3);
                }
              });
              return;
            }
            trySave(3);
            break;

          case 3:
            // 方式4: 获取所有门店, 如果有则更新第一个, 否则新增
            console.log('方式4: 获取所有门店');
            this.getStores((stores) => {
              if (stores && stores.length > 0) {
                // 如果有门店，尝试找到匹配的
                let targetStore = null;
                if (storeData.storeId) {
                  targetStore = stores.find(s => s.storeId === storeData.storeId);
                }
                if (!targetStore && userInfo && userInfo.storeId) {
                  targetStore = stores.find(s => s.storeId === userInfo.storeId);
                }
                if (!targetStore) {
                  targetStore = stores[0];
                }

                if (targetStore && targetStore._id) {
                  console.log('找到目标门店, 更新:', targetStore._id);
                  storesCollection.doc(targetStore._id).update({
                    data: updateData,
                    success: (res) => {
                      console.log('门店更新成功(方式4):', res);
                      success && success(res);
                    },
                    fail: (err) => {
                      console.log('门店更新失败(方式4):', err);
                      fail && fail(err);
                    }
                  });
                } else {
                  console.log('无合适门店, 新增');
                  addNewStore();
                }
              } else {
                console.log('无门店数据, 新增');
                addNewStore();
              }
            }, (err) => {
              console.log('获取门店失败, 尝试新增:', err);
              addNewStore();
            });

            const addNewStore = () => {
              const newStoreData = {
                ...updateData,
                storeId: storeData.storeId || (userInfo && userInfo.storeId) || 'STORE_' + Date.now(),
                createTime: new Date()
              };

              storesCollection.add({
                data: newStoreData,
                success: (res) => {
                  console.log('门店新增成功:', res);
                  success && success(res);
                },
                fail: (err) => {
                  console.error('门店新增失败:', err);
                  fail && fail(err);
                }
              });
            };
            break;

          default:
            fail && fail(new Error('所有门店保存方式都失败'));
        }
      };

      trySave(0);
    } catch (error) {
      console.error('保存门店异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取门店列表（支持分页查询，突破20条限制）
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStores: function(success, fail) {
    try {
      console.log('开始获取门店列表...');
      const storesCollection = this.getCollection('stores');
      
      if (!storesCollection) {
        console.log('stores集合获取失败');
        success && success([]);
        return;
      }
      
      // 使用分页查询获取所有门店
      const getAllStores = (offset = 0, allData = []) => {
        const limit = 100; // 每次查询100条
        
        storesCollection.skip(offset).limit(limit).get({
          success: (res) => {
            const currentData = res.data;
            const newData = allData.concat(currentData);
            
            console.log('获取门店批次成功，当前批次', currentData.length, '条，累计', newData.length, '条');
            
            if (currentData.length === limit) {
              // 还有更多数据，继续查询
              getAllStores(offset + limit, newData);
            } else {
              // 已获取所有数据
              console.log('获取所有门店成功，共', newData.length, '条记录');
              // 调试：打印所有门店的 distributorId
              console.log('所有门店 distributorId 分布:', newData.map(s => ({
                name: s.name,
                distributorId: s.distributorId,
                storeId: s.storeId
              })));
              success && success(newData);
            }
          },
          fail: (err) => {
            console.error('获取门店失败:', err);
            fail && fail(err);
            success && success([]);
          }
        });
      };
      
      // 开始分页查询
      getAllStores();
    } catch (error) {
      console.error('获取门店列表异常:', error);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 删除门店
   * @param {string} storeId 门店ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteStore: function(storeId, success, fail) {
    try {
      const storesCollection = this.getCollection('stores');
      
      storesCollection.where({
        storeId: storeId
      }).remove({
        success: (res) => {
          console.log('门店删除成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('门店删除失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('删除门店异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 根据经销商ID获取门店列表
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStoresByDistributor: function(distributorId, success, fail) {
    try {
      console.log('开始获取经销商下的门店列表，经销商ID:', distributorId);
      const storesCollection = this.getCollection('stores');

      if (!storesCollection) {
        console.log('stores集合获取失败');
        success && success([]);
        return;
      }

      // 使用分页查询获取所有门店
      const getAllStoresByDistributor = (offset = 0, allData = []) => {
        const limit = 100; // 每次查询100条

        // 使用正则表达式匹配 distributorId，去除前后空格影响
        storesCollection.where({
          distributorId: new db.RegExp({
            regexp: '^' + distributorId + '$',
            options: 'i'
          })
        }).skip(offset).limit(limit).get({
          success: (res) => {
            const currentData = res.data;
            const newData = allData.concat(currentData);

            console.log('获取经销商门店批次成功，当前批次', currentData.length, '条，累计', newData.length, '条');

            if (currentData.length === limit) {
              // 还有更多数据，继续查询
              getAllStoresByDistributor(offset + limit, newData);
            } else {
              // 已获取所有数据
              console.log('获取经销商所有门店成功，共', newData.length, '条记录');
              success && success(newData);
            }
          },
          fail: (err) => {
            console.error('获取经销商门店列表失败:', err);
            fail && fail(err);
            success && success([]);
          }
        });
      };

      // 开始分页查询
      getAllStoresByDistributor();
    } catch (error) {
      console.error('获取经销商门店列表异常:', error);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 获取经销商下所有人员（包括经销商人员和所有门店人员）
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getAllStaffByDistributor: function(distributorId, success, fail) {
    try {
      console.log('开始获取经销商下所有人员，经销商ID:', distributorId);
      
      // 先根据ID获取经销商信息
      this.getDistributorById(distributorId, (distributorInfo) => {
        if (!distributorInfo) {
          console.log('未找到经销商信息，尝试获取默认经销商');
          // 尝试获取第一个经销商作为降级
          this.getDistributorInfo((defaultDistributor) => {
            if (!defaultDistributor) {
              success && success([]);
              return;
            }
            this._processDistributorStaff(defaultDistributor.id || distributorId, defaultDistributor, success, fail);
          });
          return;
        }
        
        this._processDistributorStaff(distributorId, distributorInfo, success, fail);
      }, (err) => {
        console.error('获取经销商信息失败:', err);
        fail && fail(err);
        success && success([]);
      });
    } catch (error) {
      console.error('获取经销商所有人员异常:', error);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 处理经销商人员数据（内部方法）
   * @param {string} distributorId 经销商ID
   * @param {Object} distributorInfo 经销商信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  _processDistributorStaff: function(distributorId, distributorInfo, success, fail) {
    // 获取经销商人员列表
    const distributorStaff = distributorInfo.staffList || [];
    console.log('经销商直属人员:', distributorStaff.length, '人');
    
    // 获取该经销商下的所有门店
    this.getStoresByDistributor(distributorId, (stores) => {
      console.log('获取到门店数量:', stores.length);
      // 收集所有门店的人员
      let allStoreStaff = [];
      stores.forEach(store => {
        console.log('门店:', store.name, '人员:', store.staffList ? store.staffList.length : 0);
        if (store.staffList && store.staffList.length > 0) {
          // 为每个人员添加门店信息
          const storeStaffWithInfo = store.staffList.map(staff => ({
            ...staff,
            storeId: store.storeId,
            storeName: store.name,
            type: 'store'
          }));
          allStoreStaff = allStoreStaff.concat(storeStaffWithInfo);
        }
      });
      
      // 为经销商人员添加类型标识
      const distributorStaffWithInfo = distributorStaff.map(staff => ({
        ...staff,
        type: 'distributor'
      }));
      
      // 合并所有人员
      const allStaff = [...distributorStaffWithInfo, ...allStoreStaff];
      
      console.log('获取经销商下所有人员成功，共', allStaff.length, '人');
      
      // 如果没有找到任何人员，返回空数组，让调用方处理
      success && success(allStaff);
    }, (err) => {
      console.error('获取门店列表失败:', err);
      // 即使获取门店失败，也返回经销商人员
      const distributorStaffWithInfo = distributorStaff.map(staff => ({
        ...staff,
        type: 'distributor'
      }));
      success && success(distributorStaffWithInfo);
    });
  },

  /**
   * 保存用户数据
   * @param {Object} userData 用户数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveUser: function(userData, success, fail) {
    try {
      const usersCollection = this.getCollection('users');
      
      usersCollection.add({
        data: {
          ...userData,
          createTime: new Date(),
          updateTime: new Date()
        },
        success: (res) => {
          console.log('用户保存成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('用户保存失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('保存用户异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取用户数据
   * @param {string} userId 用户ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getUser: function(userId, success, fail) {
    try {
      const usersCollection = this.getCollection('users');
      
      usersCollection.where({
        userId: userId
      }).get({
        success: (res) => {
          console.log('获取用户成功:', res);
          success && success(res.data[0]);
        },
        fail: (err) => {
          console.error('获取用户失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('获取用户异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 保存打印机数据
   * @param {Object} printerData 打印机数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  savePrinter: function(printerData, success, fail) {
    try {
      const printersCollection = this.getCollection('printers');
      
      printersCollection.add({
        data: {
          ...printerData,
          createTime: new Date(),
          updateTime: new Date()
        },
        success: (res) => {
          console.log('打印机保存成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('打印机保存失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('保存打印机异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取打印机数据
   * @param {string} deviceId 设备ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getPrinter: function(deviceId, success, fail) {
    try {
      const printersCollection = this.getCollection('printers');
      
      printersCollection.where({
        deviceId: deviceId
      }).get({
        success: (res) => {
          console.log('获取打印机成功:', res);
          success && success(res.data[0]);
        },
        fail: (err) => {
          console.error('获取打印机失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('获取打印机异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 保存商品信息
   * @param {Object} goodsData 商品数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveGoods: function(goodsData, success, fail) {
    try {
      console.log('开始保存商品:', goodsData);
      const goodsCollection = this.getCollection('goods');
      
      goodsCollection.add({
        data: {
          ...goodsData,
          createTime: new Date(),
          updateTime: new Date()
        },
        success: (res) => {
          console.log('商品保存成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('商品保存失败:', err);
          
          // 如果是集合不存在的错误，尝试创建集合
          if (err.errCode === -502005 || err.errMsg.includes('collection not exists')) {
            console.log('goods集合不存在，尝试创建...');
            // 创建一个测试商品来触发集合创建
            this.saveGoods({
              id: 'TEST_' + Date.now(),
              NAME: '测试商品',
              pnCode: 'TEST_PN',
              SN: 'TEST_SN',
              PRICE: 0
            }, (res) => {
              console.log('goods集合创建成功:', res);
              // 再次尝试保存原商品
              this.saveGoods(goodsData, success, fail);
            }, (err2) => {
              console.log('goods集合创建失败:', err2);
              fail && fail(err2);
            });
          } else {
            fail && fail(err);
          }
        }
      });
    } catch (error) {
      console.error('保存商品异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 批量保存商品信息
   * @param {Array} goodsList 商品列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  batchSaveGoods: function(goodsList, success, fail) {
    try {
      console.log('开始批量保存商品，共', goodsList.length, '条记录');
      const goodsCollection = this.getCollection('goods');
      
      // 分批处理，每批100条
      const batchSize = 100;
      const batches = [];
      
      for (let i = 0; i < goodsList.length; i += batchSize) {
        batches.push(goodsList.slice(i, i + batchSize));
      }
      
      console.log('分成', batches.length, '批处理');
      
      // 递归处理每一批
      const processBatch = (batchIndex, results = []) => {
        if (batchIndex >= batches.length) {
          console.log('批量保存商品成功，共处理', results.length, '条记录');
          success && success(results);
          return;
        }
        
        const currentBatch = batches[batchIndex];
        console.log('处理第', batchIndex + 1, '批，共', currentBatch.length, '条记录');
        
        // 处理当前批次
        const batchPromises = currentBatch.map(goods => {
          return new Promise((resolve, reject) => {
            goodsCollection.add({
              data: {
                ...goods,
                createTime: new Date(),
                updateTime: new Date()
              },
              success: (addRes) => {
                console.log('商品添加成功:', addRes);
                resolve(addRes);
              },
              fail: (addErr) => {
                console.error('商品添加失败:', addErr);
                
                // 如果是集合不存在的错误，尝试创建集合
                if (addErr.errCode === -502005 || addErr.errMsg.includes('collection not exists')) {
                  console.log('goods集合不存在，尝试创建...');
                  // 创建一个测试商品来触发集合创建
                  this.saveGoods({
                    id: 'TEST_' + Date.now(),
                    NAME: '测试商品',
                    pnCode: 'TEST_PN',
                    SN: 'TEST_SN',
                    PRICE: 0
                  }, (res) => {
                    console.log('goods集合创建成功:', res);
                    // 再次尝试保存当前商品
                    goodsCollection.add({
                      data: {
                        ...goods,
                        createTime: new Date(),
                        updateTime: new Date()
                      },
                      success: (addRes2) => {
                        console.log('商品添加成功:', addRes2);
                        resolve(addRes2);
                      },
                      fail: (addErr2) => {
                        console.error('商品添加失败:', addErr2);
                        reject(addErr2);
                      }
                    });
                  }, (err2) => {
                    console.log('goods集合创建失败:', err2);
                    reject(err2);
                  });
                } else {
                  reject(addErr);
                }
              }
            });
          });
        });
        
        Promise.all(batchPromises)
          .then(batchResults => {
            const newResults = results.concat(batchResults);
            // 延迟100ms处理下一批，避免并发请求过多
            setTimeout(() => {
              processBatch(batchIndex + 1, newResults);
            }, 100);
          })
          .catch(err => {
            console.error('处理第', batchIndex + 1, '批失败:', err);
            fail && fail(err);
          });
      };
      
      // 开始处理第一批
      processBatch(0);
    } catch (error) {
      console.error('批量保存商品异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 根据SN码获取商品信息（使用云函数查询）
   * @param {string} sn SN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  // 是否使用云函数查询（调试阶段强制使用云函数）
  _useCloudFunction: true,
  
  getGoodsBySN: function(sn, success, fail) {
    try {
      // 标准化输入
      const trimmedInput = sn.trim();
      this._log('====================================');
      this._log('开始查询SN码:', sn);
      this._log('查询时间:', new Date().toLocaleString());
      
      // 先检查缓存
      const cachedGoods = this._getFromCache('sn', trimmedInput);
      if (cachedGoods) {
        this._log('从缓存中获取到商品信息:', cachedGoods);
        success && success(cachedGoods);
        return;
      }
      
      // 根据配置决定是否使用云函数
      if (this._useCloudFunction) {
        // 使用云函数查询
        this._log('使用云函数查询SN码...');
        wx.cloud.callFunction({
          name: 'queryGoods',
          data: {
            action: 'getGoodsBySN',
            data: {
              sn: trimmedInput
            }
          }
        }).then(res => {
          this._log('云函数查询SN码结果:', res);
          
          if (res.result && res.result.code === 0 && res.result.data) {
            const goods = res.result.data;
            this._log('找到匹配的商品:', goods);
            
            // 添加到缓存
            this._addToCache('sn', trimmedInput, goods);
            
            success && success(goods);
          } else {
            this._log('云函数未找到商品');
            // 云函数未找到商品，返回null，不再降级到本地查询
            success && success(null);
          }
        }).catch(err => {
          this._error('云函数查询SN码失败:', err);
          // 暂时屏蔽本地查询降级，只使用云函数
          fail && fail(err);
        });
      } else {
        // 暂时屏蔽本地查询，强制使用云函数
        this._log('本地查询已屏蔽，强制使用云函数查询SN码...');
        this.getGoodsBySN(sn, success, fail);
        return;
      }
      
    } catch (error) {
      this._error('根据SN获取商品异常:', error);
      // 暂时屏蔽本地查询降级
      fail && fail(error);
    }
  },
  
  /**
   * 本地SN码查询（降级方案）
   * @param {string} sn SN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  _getGoodsBySNLocal: function(sn, success, fail) {
    try {
      const trimmedInput = sn.trim();
      const db = this.getDB();
      
      if (!db) {
        this._log('数据库未初始化，使用本地查询');
        success && success(null);
        return;
      }
      
      const goodsCollection = this.getCollection('goods');
      if (!goodsCollection) {
        this._log('goods集合获取失败');
        success && success(null);
        return;
      }
      
      goodsCollection.where({
        SN: db.RegExp({
          regexp: trimmedInput,
          options: 'i'
        })
      }).limit(1).get({
        success: (res) => {
          if (res.data && res.data.length > 0) {
            const foundGoods = res.data[0];
            const normalizedGoods = {
              id: foundGoods._id || foundGoods.id || '',
              name: foundGoods.NAME || foundGoods.name || '',
              pnCode: foundGoods.pnCode || '',
              snCode: foundGoods.SN || foundGoods.snCode || '',
              price: parseFloat(foundGoods.PRICE || foundGoods.price || 0)
            };
            this._addToCache('sn', trimmedInput, normalizedGoods);
            success && success(normalizedGoods);
          } else {
            this.searchGoodsByField('SN', trimmedInput, success, fail);
          }
        },
        fail: (err) => {
          this._error('本地SN码查询失败:', err);
          this.searchGoodsByField('SN', trimmedInput, success, fail);
        }
      });
    } catch (error) {
      this._error('本地SN码查询异常:', error);
      success && success(null);
    }
  },

  /**
   * 根据字段名搜索商品（通用分页查询方法）
   * @param {string} field 字段名
   * @param {string} value 搜索值
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  searchGoodsByField: function(field, value, success, fail) {
    try {
      this._log('开始根据字段搜索商品:', field, '=', value);
      
      // 获取goods集合
      const goodsCollection = this.getCollection('goods');
      if (!goodsCollection) {
        this._log('goods集合获取失败');
        success && success(null);
        return;
      }
      
      // 标准化输入：转为小写
      const normalizedValue = value.toLowerCase();
      
      // 使用分页查询搜索所有商品
      const searchInAllRecords = (offset = 0, totalCount = 0) => {
        const limit = 100; // 每次查询100条
        
        goodsCollection.skip(offset).limit(limit).get({
          success: (res) => {
            const currentData = res.data || [];
            const currentCount = totalCount + currentData.length;
            
            this._log('查询商品批次，当前批次', currentData.length, '条，累计查询', currentCount, '条');
            
            // 在当前批次中查找匹配的商品
            let foundGoods = null;
            
            if (currentData.length > 0) {
              // 遍历当前批次数据，查找匹配项
              for (const item of currentData) {
                // 获取并标准化字段值
                const itemValue = (item[field] || '').toString().trim().toLowerCase();
                
                // 检查是否匹配：包含关系（模糊查找）
                if (itemValue.includes(normalizedValue)) {
                  foundGoods = item;
                  this._log('找到匹配的商品:', item);
                  break; // 找到第一个匹配项就返回
                }
              }
            }
            
            if (foundGoods) {
              this._log('找到匹配的商品:', foundGoods);
              // 转换字段名为小写，确保与前端代码兼容
              const normalizedGoods = {
                id: foundGoods._id || foundGoods.id || '',
                name: foundGoods.NAME || foundGoods.name || '',
                pnCode: foundGoods.pnCode || '',
                snCode: foundGoods.SN || foundGoods.snCode || '',
                price: parseFloat(foundGoods.PRICE || foundGoods.price || 0)
              };
              this._log('转换后的商品信息:', normalizedGoods);
              success && success(normalizedGoods);
            } else if (currentData.length > 0) {
              // 只要返回了数据，就继续查询，因为云开发可能限制每次最多返回20条
              this._log('当前批次未找到，继续查询下一批...');
              searchInAllRecords(offset + currentData.length, currentCount);
            } else {
              this._log('查询完成，共查询', currentCount, '条记录，未找到匹配的商品');
              success && success(null);
            }
          },
          fail: (err) => {
            this._error('查询goods数据失败:', err);
            
            // 处理集合不存在的错误
            if (!this._handleCollectionError(err, success, fail)) {
              success && success(null);
            }
          }
        });
      };
      
      // 开始分页查询
      searchInAllRecords();
    } catch (error) {
      this._error('搜索商品异常:', error);
      success && success(null);
    }
  },

  /**
   * 根据PN码获取商品信息（使用云函数查询）
   * @param {string} pn PN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getGoodsByPN: function(pn, success, fail) {
    try {
      // 标准化输入
      const trimmedInput = pn.trim();
      this._log('====================================');
      this._log('开始查询PN码:', pn);
      this._log('查询时间:', new Date().toLocaleString());
      
      // 先检查缓存
      const cachedGoods = this._getFromCache('pn', trimmedInput);
      if (cachedGoods) {
        this._log('从缓存中获取到商品信息:', cachedGoods);
        success && success(cachedGoods);
        return;
      }
      
      // 根据配置决定是否使用云函数
      if (this._useCloudFunction) {
        // 使用云函数查询
        this._log('使用云函数查询PN码...');
        wx.cloud.callFunction({
          name: 'queryGoods',
          data: {
            action: 'getGoodsByPN',
            data: {
              pnCode: trimmedInput
            }
          }
        }).then(res => {
          this._log('云函数查询PN码结果:', res);

          if (res.result && res.result.code === 0 && res.result.data) {
            const goods = res.result.data;
            this._log('找到匹配的商品:', goods);

            // 添加到缓存
            this._addToCache('pn', trimmedInput, goods);

            success && success(goods);
          } else {
            this._log('云函数未找到商品');
            // 云函数未找到商品，返回null，不再降级到本地查询
            success && success(null);
          }
        }).catch(err => {
          this._error('云函数查询PN码失败:', err);
          // 暂时屏蔽本地查询降级，只使用云函数
          fail && fail(err);
        });
      } else {
        // 暂时屏蔽本地查询，强制使用云函数
        this._log('本地查询已屏蔽，强制使用云函数查询PN码...');
        this.getGoodsByPN(pn, success, fail);
        return;
      }

    } catch (error) {
      this._error('根据PN获取商品异常:', error);
      // 暂时屏蔽本地查询降级
      fail && fail(error);
    }
  },
  
  /**
   * 本地PN码查询（降级方案）
   * @param {string} pn PN码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  _getGoodsByPNLocal: function(pn, success, fail) {
    try {
      const trimmedInput = pn.trim();
      const db = this.getDB();
      
      if (!db) {
        this._log('数据库未初始化，使用本地查询');
        success && success(null);
        return;
      }
      
      const goodsCollection = this.getCollection('goods');
      if (!goodsCollection) {
        this._log('goods集合获取失败');
        success && success(null);
        return;
      }
      
      goodsCollection.where({
        pnCode: db.RegExp({
          regexp: trimmedInput,
          options: 'i'
        })
      }).limit(1).get({
        success: (res) => {
          if (res.data && res.data.length > 0) {
            const foundGoods = res.data[0];
            const normalizedGoods = {
              id: foundGoods._id || foundGoods.id || '',
              name: foundGoods.NAME || foundGoods.name || '',
              pnCode: foundGoods.pnCode || '',
              snCode: foundGoods.SN || foundGoods.snCode || '',
              price: parseFloat(foundGoods.PRICE || foundGoods.price || 0)
            };
            this._addToCache('pn', trimmedInput, normalizedGoods);
            success && success(normalizedGoods);
          } else {
            this.searchGoodsByField('pnCode', trimmedInput, success, fail);
          }
        },
        fail: (err) => {
          this._error('本地PN码查询失败:', err);
          this.searchGoodsByField('pnCode', trimmedInput, success, fail);
        }
      });
    } catch (error) {
      this._error('本地PN码查询异常:', error);
      success && success(null);
    }
  },

  /**
   * 获取所有商品信息（支持分页查询，突破20条限制）
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getAllGoods: function(success, fail) {
    try {
      console.log('====================================');
      console.log('开始获取所有商品...');
      console.log('查询时间:', new Date().toLocaleString());
      
      const goodsCollection = this.getCollection('goods');
      
      if (!goodsCollection) {
        console.log('goods集合获取失败');
        success && success([]);
        return;
      }
      
      // 测试集合是否存在
      goodsCollection.get({
        success: (res) => {
          console.log('goods集合测试成功，开始查询...');
          // 集合存在，继续查询
          getAllRecords();
        },
        fail: (err) => {
          console.error('goods集合测试失败:', err);
          
          // 如果是集合不存在的错误，尝试创建集合
          if (err.errCode === -502005 || err.errMsg.includes('collection not exists')) {
            console.log('goods集合不存在，尝试创建...');
            // 创建一个测试商品来触发集合创建
            this.saveGoods({
              id: 'TEST_' + Date.now(),
              NAME: '测试商品',
              pnCode: 'TEST_PN',
              SN: 'TEST_SN',
              PRICE: 0
            }, (res) => {
              console.log('goods集合创建成功:', res);
              // 集合创建成功，开始查询
              getAllRecords();
            }, (err2) => {
              console.log('goods集合创建失败:', err2);
              success && success([]);
            });
          } else {
            success && success([]);
          }
        }
      });
      
      console.log('goods集合获取成功，开始分页查询...');
      
      // 微信云开发默认限制20条，需要使用分页查询获取所有记录
      const getAllRecords = (offset = 0, allData = []) => {
        const limit = 100; // 每次查询100条
        
        console.log('执行商品分页查询，偏移量:', offset, '，限制:', limit);
        
        goodsCollection.skip(offset).limit(limit).get({
          success: (res) => {
            console.log('查询结果:', res);
            const currentData = res.data || [];
            const newData = allData.concat(currentData);
            
            console.log('获取商品批次成功，当前批次', currentData.length, '条，累计', newData.length, '条');
            
            // 打印前几条数据的结构，便于调试
            if (currentData.length > 0) {
              console.log('前3条数据结构:', currentData.slice(0, 3));
            }
            
            if (currentData.length > 0) {
              // 只要返回了数据，就继续查询，因为云开发可能限制每次最多返回20条
              console.log('当前批次获取了', currentData.length, '条数据，继续查询下一批...');
              getAllRecords(offset + currentData.length, newData);
            } else {
              // 没有更多数据了
              console.log('获取所有商品成功，共', newData.length, '条记录');
              console.log('数据样本:', newData.slice(0, 2));
              success && success(newData);
            }
          },
          fail: (err) => {
            console.error('获取商品失败:', err);
            console.log('错误代码:', err.errCode);
            console.log('错误信息:', err.errMsg);
            fail && fail(err);
            success && success([]);
          }
        });
      };
      
      // 开始分页查询
      getAllRecords();
    } catch (error) {
      console.error('获取所有商品异常:', error);
      console.log('异常堆栈:', error.stack);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 测试函数：验证指定PN码是否存在于数据库中（支持分页查询）
   * @param {string} pn PN码
   * @param {function} callback 回调函数
   */
  testGoodsExists: function(pn, callback) {
    try {
      console.log('====================================');
      console.log('开始测试PN码是否存在:', pn);
      console.log('测试时间:', new Date().toLocaleString());
      
      // 获取goods集合
      const goodsCollection = this.getCollection('goods');
      
      if (!goodsCollection) {
        console.log('数据库集合不可用');
        callback && callback({ exists: false, message: '数据库集合不可用' });
        return;
      }
      
      console.log('goods集合获取成功，开始分页查询...');
      
      // 使用分页查询获取所有商品数据
      const searchInAllRecords = (offset = 0, totalCount = 0) => {
        const limit = 100; // 每次查询100条
        
        console.log('执行分页查询，偏移量:', offset, '，限制:', limit);
        
        goodsCollection.skip(offset).limit(limit).get({
          success: (res) => {
            console.log('查询结果:', res);
            const currentData = res.data || [];
            const currentCount = totalCount + currentData.length;
            
            console.log('搜索商品批次，当前批次', currentData.length, '条，累计搜索', currentCount, '条');
            
            // 在当前批次中查找匹配的PN码
            let foundGoods = null;
            
            // 尝试多种匹配方式
            if (currentData.length > 0) {
              console.log('在当前批次中尝试匹配PN码:', pn);
              console.log('当前批次数据结构:', currentData.slice(0, 2));
              
              // 标准化查询的PN码
              const normalizedPN = pn.trim().toUpperCase();
              console.log('标准化后的PN码:', normalizedPN);
              
              // 方式1: 严格相等匹配 - 使用正确的大写字段名PN
              foundGoods = currentData.find(item => item.pnCode === pn);
              if (foundGoods) {
                console.log('方式1 - 严格相等匹配成功:', foundGoods);
              } else {
                console.log('方式1 - 严格相等匹配失败');
                
                // 方式2: 不区分大小写匹配 - 使用正确的大写字段名PN
                foundGoods = currentData.find(item => {
                  const itemPN = item.pnCode || '';
                  return itemPN && pn && itemPN.toLowerCase() === pn.toLowerCase();
                });
                if (foundGoods) {
                  console.log('方式2 - 不区分大小写匹配成功:', foundGoods);
                } else {
                  console.log('方式2 - 不区分大小写匹配失败');
                  
                  // 方式3: 标准化后匹配（去除空格，转为大写）- 使用正确的大写字段名PN
                  foundGoods = currentData.find(item => {
                    const itemPN = (item.pnCode || '').trim().toUpperCase();
                    return itemPN === normalizedPN;
                  });
                  if (foundGoods) {
                    console.log('方式3 - 标准化后匹配成功:', foundGoods);
                  } else {
                    console.log('方式3 - 标准化后匹配失败');
                    
                    // 方式4: 包含匹配 - 使用正确的大写字段名PN
                    foundGoods = currentData.find(item => {
                      const itemPN = (item.pnCode || '').trim().toUpperCase();
                      return itemPN && normalizedPN && itemPN.includes(normalizedPN);
                    });
                    if (foundGoods) {
                      console.log('方式4 - 包含匹配成功:', foundGoods);
                    } else {
                      console.log('方式4 - 包含匹配失败');
                      
                      // 方式5: 打印当前批次的PN字段值，便于调试
                      console.log('调试信息 - 当前批次的PN字段值:');
                      currentData.forEach((item, index) => {
                        if (index < 10) { // 打印前10条
                          console.log('  第', index + 1, '条 - PN:', item.pnCode, 'NAME:', item.NAME);
                        }
                      });
                    }
                  }
                }
              }
            }
            
            if (foundGoods) {
              console.log('找到匹配的商品:', foundGoods);
              // 转换字段名为小写，确保与前端代码兼容
              const normalizedGoods = {
                id: foundGoods._id || foundGoods.id || '',
                name: foundGoods.NAME || foundGoods.name || '',
                pnCode: foundGoods.pnCode || '',
                snCode: foundGoods.SN || foundGoods.snCode || '',
                price: parseFloat(foundGoods.PRICE || foundGoods.price || 0)
              };
              console.log('转换后的商品信息:', normalizedGoods);
              callback && callback({ exists: true, goods: normalizedGoods });
            } else if (currentData.length > 0) {
              // 只要返回了数据，就继续查询，因为云开发可能限制每次最多返回20条
              console.log('当前批次未找到，继续查询下一批...');
              searchInAllRecords(offset + currentData.length, currentCount);
            } else {
              console.log('搜索完成，共搜索', currentCount, '条记录，未找到匹配的商品');
              callback && callback({ exists: false, message: '未找到匹配的商品，共搜索 ' + currentCount + ' 条记录' });
            }
          },
          fail: (err) => {
            console.error('搜索商品失败:', err);
            console.log('错误代码:', err.errCode);
            console.log('错误信息:', err.errMsg);
            callback && callback({ exists: false, message: '搜索商品失败: ' + err.errMsg });
          }
        });
      };
      
      // 开始搜索
      searchInAllRecords();
    } catch (error) {
      console.error('测试过程异常:', error);
      console.log('异常堆栈:', error.stack);
      callback && callback({ exists: false, message: '测试过程异常: ' + error.message });
    }
  },

  /**
   * 保存经销商信息
   * @param {Object} distributorInfo 经销商信息
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveDistributorInfo: function(distributorInfo, success, fail) {
    try {
      console.log('开始保存经销商信息, 输入数据:', distributorInfo);
      const distributorCollection = this.getCollection('distributors');

      // 处理员工列表，为没有密码的员工添加默认密码（手机号后6位）
      if (distributorInfo.staffList && distributorInfo.staffList.length > 0) {
        distributorInfo.staffList = distributorInfo.staffList.map(staff => {
          if (!staff.password && staff.phone) {
            const defaultPassword = staff.phone.slice(-6);
            return {
              ...staff,
              password: defaultPassword
            };
          }
          return staff;
        });
      }

      // 处理经销商负责人密码
      if (distributorInfo.phone && !distributorInfo.password) {
        distributorInfo.password = distributorInfo.phone.slice(-6);
      }

      // 清理系统字段
      const cleanData = { ...distributorInfo };
      delete cleanData._openid;
      delete cleanData._id;
      delete cleanData._createTime;
      delete cleanData._updateTime;
      delete cleanData.createTime;

      // 准备更新数据
      const updateData = {
        ...cleanData,
        updateTime: new Date()
      };

      // 如果有 id 或 _id，先尝试查找并更新
      const trySave = (tryIndex = 0) => {
        console.log('尝试保存方式', tryIndex + 1);

        switch(tryIndex) {
          case 0:
            // 方式1: 使用 _id 字段作为 doc 更新
            if (distributorInfo._id) {
              console.log('方式1: 使用 _id 更新:', distributorInfo._id);
              distributorCollection.doc(distributorInfo._id).update({
                data: updateData,
                success: (res) => {
                  console.log('经销商更新成功(方式1):', res);
                  success && success(res);
                },
                fail: (err) => {
                  console.log('经销商更新失败(方式1):', err);
                  trySave(1);
                }
              });
              return;
            }
            trySave(1);
            break;

          case 1:
            // 方式2: 使用 id 字段查询并更新
            if (distributorInfo.id) {
              console.log('方式2: 使用 id 查询并更新:', distributorInfo.id);
              distributorCollection.where({
                id: distributorInfo.id
              }).get({
                success: (queryRes) => {
                  if (queryRes.data && queryRes.data.length > 0) {
                    const docId = queryRes.data[0]._id;
                    console.log('找到经销商文档, 用 doc 更新:', docId);
                    distributorCollection.doc(docId).update({
                      data: updateData,
                      success: (res) => {
                        console.log('经销商更新成功(方式2):', res);
                        success && success(res);
                      },
                      fail: (err) => {
                        console.log('经销商更新失败(方式2):', err);
                        trySave(2);
                      }
                    });
                  } else {
                    console.log('未找到匹配的经销商, 尝试新增');
                    trySave(2);
                  }
                },
                fail: (err) => {
                  console.log('查询经销商失败(方式2):', err);
                  trySave(2);
                }
              });
              return;
            }
            trySave(2);
            break;

          case 2:
            // 方式3: 获取所有经销商, 如果有则更新第一个, 否则新增
            console.log('方式3: 获取所有经销商');
            this.getDistributorInfo((existingInfo) => {
              if (existingInfo && existingInfo._id) {
                console.log('找到现有经销商, 更新:', existingInfo._id);
                distributorCollection.doc(existingInfo._id).update({
                  data: updateData,
                  success: (res) => {
                    console.log('经销商更新成功(方式3):', res);
                    success && success(res);
                  },
                  fail: (err) => {
                    console.log('经销商更新失败(方式3):', err);
                    fail && fail(err);
                  }
                });
              } else {
                console.log('无现有经销商, 新增');
                const newDistributorInfo = {
                  ...updateData,
                  id: distributorInfo.id || 'DISTRIBUTOR_' + Date.now(),
                  createTime: new Date()
                };

                distributorCollection.add({
                  data: newDistributorInfo,
                  success: (res) => {
                    console.log('经销商新增成功:', res);
                    success && success(res);
                  },
                  fail: (err) => {
                    console.error('经销商新增失败:', err);
                    fail && fail(err);
                  }
                });
              }
            }, (err) => {
              console.log('获取现有经销商失败, 尝试新增:', err);
              const newDistributorInfo = {
                ...updateData,
                id: distributorInfo.id || 'DISTRIBUTOR_' + Date.now(),
                createTime: new Date()
              };

              distributorCollection.add({
                data: newDistributorInfo,
                success: (res) => {
                  console.log('经销商新增成功:', res);
                  success && success(res);
                },
                fail: (err) => {
                  console.error('经销商新增失败:', err);
                  fail && fail(err);
                }
              });
            });
            break;

          default:
            fail && fail(new Error('所有保存方式都失败'));
        }
      };

      trySave(0);
    } catch (error) {
      console.error('保存经销商信息异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取经销商信息（返回第一个）
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getDistributorInfo: function(success, fail) {
    try {
      const distributorCollection = this.getCollection('distributors');
      
      distributorCollection.get({
        success: (res) => {
          console.log('获取经销商信息成功:', res);
          if (res.data && res.data.length > 0) {
            // 返回第一个经销商信息
            success && success(res.data[0]);
          } else {
            // 没有找到经销商信息，返回null
            success && success(null);
          }
        },
        fail: (err) => {
          console.error('获取经销商信息失败:', err);
          fail && fail(err);
          // 失败时返回null
          success && success(null);
        }
      });
    } catch (error) {
      console.error('获取经销商信息异常:', error);
      fail && fail(error);
      // 失败时返回null
      success && success(null);
    }
  },

  /**
   * 根据ID获取经销商信息
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getDistributorById: function(distributorId, success, fail) {
    try {
      console.log('根据ID获取经销商信息:', distributorId);
      const distributorCollection = this.getCollection('distributors');
      
      // 尝试多种查询方式
      const tryQuery = (queryIndex = 0) => {
        let queryCondition;
        switch(queryIndex) {
          case 0:
            // 方式1: 用 id 字段查询
            queryCondition = { id: distributorId };
            console.log('尝试查询方式1: id =', distributorId);
            break;
          case 1:
            // 方式2: 用 _id 字段查询
            console.log('尝试查询方式2: _id =', distributorId);
            distributorCollection.doc(distributorId).get({
              success: (docRes) => {
                console.log('用doc获取经销商信息成功:', docRes);
                if (docRes.data) {
                  success && success(docRes.data);
                } else {
                  tryQuery(2);
                }
              },
              fail: (docErr) => {
                console.log('用doc获取经销商信息失败:', docErr);
                tryQuery(2);
              }
            });
            return;
          case 2:
            // 方式3: 获取所有经销商，返回第一个
            console.log('尝试查询方式3: 获取所有经销商');
            this.getDistributorInfo((distributorInfo) => {
              if (distributorInfo) {
                console.log('获取默认经销商成功:', distributorInfo);
                success && success(distributorInfo);
              } else {
                console.log('所有查询方式都失败，返回null');
                success && success(null);
              }
            }, (err) => {
              console.log('获取默认经销商失败:', err);
              success && success(null);
            });
            return;
          default:
            console.log('所有查询方式都尝试完毕，返回null');
            success && success(null);
            return;
        }
        
        if (queryCondition) {
          distributorCollection.where(queryCondition).get({
            success: (res) => {
              console.log('查询方式' + (queryIndex + 1) + '结果:', res);
              if (res.data && res.data.length > 0) {
                success && success(res.data[0]);
              } else {
                tryQuery(queryIndex + 1);
              }
            },
            fail: (err) => {
              console.error('查询方式' + (queryIndex + 1) + '失败:', err);
              tryQuery(queryIndex + 1);
            }
          });
        }
      };
      
      tryQuery(0);
    } catch (error) {
      console.error('根据ID获取经销商信息异常:', error);
      fail && fail(error);
      success && success(null);
    }
  },

  /**
   * 根据经销商ID获取门店列表
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getStoresByDistributor: function(distributorId, success, fail) {
    try {
      console.log('开始获取经销商下的门店列表，经销商ID:', distributorId);
      const storesCollection = this.getCollection('stores');
      
      if (!storesCollection) {
        console.log('stores集合获取失败');
        success && success([]);
        return;
      }
      
      // 尝试多种查询方式
      const tryQuery = (queryIndex = 0) => {
        let queryCondition;
        switch(queryIndex) {
          case 0:
            // 方式1: 用 distributorId 字段查询
            queryCondition = { distributorId: distributorId };
            console.log('尝试门店查询方式1: distributorId =', distributorId);
            break;
          case 1:
            // 方式2: 获取所有门店
            console.log('尝试门店查询方式2: 获取所有门店');
            storesCollection.get({
              success: (res) => {
                console.log('获取所有门店成功:', res.data);
                success && success(res.data || []);
              },
              fail: (err) => {
                console.error('获取所有门店失败:', err);
                success && success([]);
              }
            });
            return;
          default:
            console.log('所有门店查询方式都尝试完毕，返回空数组');
            success && success([]);
            return;
        }
        
        if (queryCondition) {
          storesCollection.where(queryCondition).get({
            success: (res) => {
              console.log('门店查询方式' + (queryIndex + 1) + '结果:', res.data);
              if (res.data && res.data.length > 0) {
                success && success(res.data);
              } else {
                tryQuery(queryIndex + 1);
              }
            },
            fail: (err) => {
              console.error('门店查询方式' + (queryIndex + 1) + '失败:', err);
              tryQuery(queryIndex + 1);
            }
          });
        }
      };
      
      tryQuery(0);
    } catch (error) {
      console.error('获取经销商门店列表异常:', error);
      fail && fail(error);
      success && success([]);
    }
  },

  /**
   * 根据手机号获取用户信息
   * @param {string} phoneNumber 手机号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getUserByPhone: function(phoneNumber, success, fail) {
    try {
      console.log('根据手机号查询用户:', phoneNumber);
      const usersCollection = this.getCollection('users');
      
      if (!usersCollection) {
        console.log('users集合获取失败');
        success && success(null);
        return;
      }
      
      usersCollection.where({
        phone: phoneNumber
      }).get({
        success: (res) => {
          console.log('手机号查询结果:', res);
          if (res.data && res.data.length > 0) {
            const user = res.data[0];
            console.log('找到用户:', user);
            success && success(user);
          } else {
            console.log('未找到用户，尝试从门店和经销商中查找');
            this.findUserInStoresAndDistributor(phoneNumber, success, fail);
          }
        },
        fail: (err) => {
          console.error('手机号查询失败:', err);
          this.findUserInStoresAndDistributor(phoneNumber, success, fail);
        }
      });
    } catch (error) {
      console.error('根据手机号获取用户异常:', error);
      fail && fail(error);
      success && success(null);
    }
  },

  /**
   * 从门店和经销商中查找用户
   * @param {string} phoneNumber 手机号
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  findUserInStoresAndDistributor: function(phoneNumber, success, fail) {
    console.log('从门店和经销商中查找用户:', phoneNumber);
    
    let foundUser = null;
    
    this.getStores((stores) => {
      for (const store of stores) {
        if (store.staffList && store.staffList.length > 0) {
          const staff = store.staffList.find(s => s.phone === phoneNumber);
          if (staff) {
            foundUser = {
              name: staff.name,
              phone: staff.phone,
              position: staff.position,
              password: staff.password || '',
              role: this._getRoleFromPosition(staff.position),
              storeId: store.storeId,
              storeName: store.name,
              distributorId: store.distributorId || ''
            };
            break;
          }
        }
        
        if (store.managerPhone === phoneNumber) {
          foundUser = {
            name: store.managerName,
            phone: store.managerPhone,
            position: '店长',
            password: store.managerPassword || '',
            role: 'store_admin',
            storeId: store.storeId,
            storeName: store.name,
            distributorId: store.distributorId || ''
          };
          break;
        }
      }
      
      if (foundUser) {
        console.log('在门店中找到用户:', foundUser);
        success && success(foundUser);
        return;
      }
      
      this.getDistributorInfo((distributorInfo) => {
        if (distributorInfo && distributorInfo.staffList && distributorInfo.staffList.length > 0) {
          const staff = distributorInfo.staffList.find(s => s.phone === phoneNumber);
          if (staff) {
            foundUser = {
              name: staff.name,
              phone: staff.phone,
              position: staff.position,
              password: staff.password || '',
              role: 'distributor', // 经销商员工直接设为经销商角色
              distributorId: distributorInfo.id || distributorInfo._id,
              distributorName: distributorInfo.name
            };
          }
        }
        
        if (!foundUser && distributorInfo && distributorInfo.phone === phoneNumber) {
          foundUser = {
            name: distributorInfo.name,
            phone: distributorInfo.phone,
            position: '经销商',
            password: distributorInfo.password || '',
            role: 'distributor',
            distributorId: distributorInfo.id || distributorInfo._id,
            distributorName: distributorInfo.name
          };
        }
        
        if (foundUser) {
          console.log('在经销商中找到用户:', foundUser);
          success && success(foundUser);
        } else {
          console.log('未找到用户');
          success && success(null);
        }
      }, (err) => {
        console.error('获取经销商信息失败:', err);
        success && success(null);
      });
    }, (err) => {
      console.error('获取门店列表失败:', err);
      success && success(null);
    });
  },

  /**
   * 根据职位获取角色
   * @param {string} position 职位
   * @returns {string} 角色
   */
  _getRoleFromPosition: function(position) {
    if (!position) return 'staff';
    const pos = position.toString().trim();
    console.log('判断角色，职位:', pos);
    if (pos.includes('经销商') || pos.includes('分销') || pos.includes('总') || pos.includes('老板') || pos.includes('法人')) {
      console.log('判断为经销商');
      return 'distributor';
    } else if (pos.includes('店长') || pos.includes('经理') || pos.includes('主管')) {
      return 'store_admin';
    }
    console.log('判断为店员');
    return 'staff';
  },

  /**
   * 保存用户到users集合
   * @param {Object} userData 用户数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveUser: function(userData, success, fail) {
    try {
      const usersCollection = this.getCollection('users');
      
      if (userData._id) {
        usersCollection.doc(userData._id).update({
          data: {
            ...userData,
            updateTime: new Date()
          },
          success: (res) => {
            console.log('用户更新成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('用户更新失败:', err);
            fail && fail(err);
          }
        });
      } else {
        usersCollection.add({
          data: {
            ...userData,
            createTime: new Date(),
            updateTime: new Date()
          },
          success: (res) => {
            console.log('用户保存成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('用户保存失败:', err);
            fail && fail(err);
          }
        });
      }
    } catch (error) {
      console.error('保存用户异常:', error);
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
  verifyUserPassword: function(phoneNumber, password, success, fail) {
    console.log('验证用户密码:', phoneNumber);
    
    this.verifyUserPasswordFromStores(phoneNumber, password, success, fail);
  },

  /**
   * 从门店和经销商中验证用户密码
   * @param {string} phoneNumber 手机号
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  verifyUserPasswordFromStores: function(phoneNumber, password, success, fail) {
    console.log('从门店和经销商中验证用户密码:', phoneNumber);
    
    this.findUserInStoresAndDistributor(phoneNumber, (userInfo) => {
      if (!userInfo) {
        console.log('用户不存在');
        success && success(null);
        return;
      }
      
      const defaultPassword = phoneNumber.slice(-6);
      const storedPassword = userInfo.password || defaultPassword;
      
      if (storedPassword === password) {
        console.log('密码验证成功（从门店/经销商）:', userInfo);
        success && success(userInfo);
      } else {
        console.log('密码验证失败');
        success && success(null);
      }
    }, (err) => {
      console.error('查找用户失败:', err);
      success && success(null);
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
  changeUserPassword: function(userId, oldPassword, newPassword, success, fail) {
    const userInfo = wx.getStorageSync('userInfo') || {};
    const phoneNumber = userInfo.phoneNumber || '';
    const userRole = userInfo.userRole || 'staff';
    const storeId = userInfo.storeId || '';
    const distributorId = userInfo.distributorId || '';
    
    console.log('修改用户密码:', phoneNumber, userRole, distributorId);
    
    if (!phoneNumber) {
      fail && fail({ errMsg: '用户信息不完整' });
      return;
    }
    
    const defaultPassword = phoneNumber.slice(-6);
    
    if (oldPassword !== defaultPassword && oldPassword !== userInfo.password) {
      fail && fail({ errMsg: '旧密码错误' });
      return;
    }
    
    if (userRole === 'distributor') {
      this._updateDistributorPassword(distributorId, phoneNumber, newPassword, success, fail);
    } else if (userRole === 'store_admin') {
      this._updateStorePassword(storeId, phoneNumber, newPassword, true, success, fail);
    } else if (userRole === 'staff') {
      this._updateStorePassword(storeId, phoneNumber, newPassword, false, success, fail);
    } else {
      fail && fail({ errMsg: '无法修改密码' });
    }
  },

  _updateDistributorPassword: function(distributorId, phoneNumber, newPassword, success, fail) {
    const distributorsCollection = this.getCollection('distributors');
    
    if (!distributorsCollection) {
      fail && fail({ errMsg: '数据库连接失败' });
      return;
    }
    
    if (!distributorId) {
      fail && fail({ errMsg: '经销商信息不完整' });
      return;
    }
    
    console.log('更新经销商密码, distributorId:', distributorId);
    
    // 使用 where 查询，支持 id 或 _id
    distributorsCollection.where({
      $or: [
        { id: distributorId },
        { _id: distributorId }
      ]
    }).get({
      success: (res) => {
        if (res.data && res.data.length > 0) {
          const distributor = res.data[0];
          const docId = distributor._id;
          
          let updateData = {};
          
          if (distributor.phone === phoneNumber) {
            updateData.password = newPassword;
          }
          
          if (distributor.staffList && distributor.staffList.length > 0) {
            const staffIndex = distributor.staffList.findIndex(s => s.phone === phoneNumber);
            if (staffIndex >= 0) {
              updateData['staffList.' + staffIndex + '.password'] = newPassword;
            }
          }
          
          if (Object.keys(updateData).length === 0) {
            fail && fail({ errMsg: '未找到用户信息' });
            return;
          }
          
          distributorsCollection.doc(docId).update({
            data: updateData,
            success: (updateRes) => {
              console.log('经销商密码修改成功');
              success && success(updateRes);
            },
            fail: (err) => {
              console.error('经销商密码修改失败:', err);
              fail && fail(err);
            }
          });
        } else {
          fail && fail({ errMsg: '未找到经销商信息' });
        }
      },
      fail: (err) => {
        console.error('查询经销商失败:', err);
        fail && fail(err);
      }
    });
  },

  _updateStorePassword: function(storeId, phoneNumber, newPassword, isManager, success, fail) {
    const storesCollection = this.getCollection('stores');
    
    if (!storesCollection) {
      fail && fail({ errMsg: '数据库连接失败' });
      return;
    }
    
    if (!storeId) {
      fail && fail({ errMsg: '门店信息不完整' });
      return;
    }
    
    console.log('更新门店密码, storeId:', storeId);
    
    // 使用 where 查询，支持 storeId 或 _id
    storesCollection.where({
      $or: [
        { storeId: storeId },
        { _id: storeId }
      ]
    }).get({
      success: (res) => {
        if (res.data && res.data.length > 0) {
          const store = res.data[0];
          const docId = store._id;
          
          let updateData = {};
          
          if (isManager) {
            updateData.managerPassword = newPassword;
          } else if (store.staffList && store.staffList.length > 0) {
            const staffIndex = store.staffList.findIndex(s => s.phone === phoneNumber);
            if (staffIndex >= 0) {
              updateData['staffList.' + staffIndex + '.password'] = newPassword;
            } else {
              fail && fail({ errMsg: '未找到员工信息' });
              return;
            }
          } else {
            fail && fail({ errMsg: '未找到员工信息' });
            return;
          }
          
          storesCollection.doc(docId).update({
            data: updateData,
            success: (updateRes) => {
              console.log('门店密码修改成功');
              success && success(updateRes);
            },
            fail: (err) => {
              console.error('门店密码修改失败:', err);
              fail && fail(err);
            }
          });
        } else {
          fail && fail({ errMsg: '未找到门店信息' });
        }
      },
      fail: (err) => {
        console.error('查询门店失败:', err);
        fail && fail(err);
      }
    });
  },

  /**
   * 重置用户密码（经销商使用）
   * 优先在 distributors 和 stores 集合中查找并更新密码
   * @param {string} phoneNumber 手机号
   * @param {string} newPassword 新密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  resetUserPassword: function(phoneNumber, newPassword, success, fail) {
    try {
      console.log('重置用户密码:', phoneNumber);
      
      // 先在 distributors 集合中查找
      this._resetPasswordInDistributors(phoneNumber, newPassword, (distributorRes) => {
        if (distributorRes) {
          console.log('在 distributors 中重置密码成功');
          success && success(distributorRes);
          return;
        }
        
        // 再在 stores 集合中查找
        this._resetPasswordInStores(phoneNumber, newPassword, (storeRes) => {
          if (storeRes) {
            console.log('在 stores 中重置密码成功');
            success && success(storeRes);
            return;
          }
          
          // 都没找到，返回错误
          console.error('未找到用户:', phoneNumber);
          fail && fail({ errMsg: '未找到该手机号的用户' });
        }, fail);
      }, fail);
    } catch (error) {
      console.error('重置密码异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 在 distributors 集合中重置密码
   * @param {string} phoneNumber 手机号
   * @param {string} newPassword 新密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  _resetPasswordInDistributors: function(phoneNumber, newPassword, success, fail) {
    const distributorsCollection = this.getCollection('distributors');
    
    if (!distributorsCollection) {
      console.log('distributors集合获取失败');
      success && success(null);
      return;
    }
    
    distributorsCollection.get({
      success: (res) => {
        if (res.data && res.data.length > 0) {
          // 遍历所有经销商查找匹配的手机号
          for (const distributor of res.data) {
            let updateData = {};
            let found = false;
            
            // 检查经销商主账号
            if (distributor.phone === phoneNumber) {
              updateData.password = newPassword;
              found = true;
            }
            
            // 检查经销商员工列表
            if (distributor.staffList && distributor.staffList.length > 0) {
              const staffIndex = distributor.staffList.findIndex(s => s.phone === phoneNumber);
              if (staffIndex >= 0) {
                updateData['staffList.' + staffIndex + '.password'] = newPassword;
                found = true;
              }
            }
            
            if (found) {
              // 找到匹配的用户，更新密码
              distributorsCollection.doc(distributor._id).update({
                data: {
                  ...updateData,
                  updateTime: new Date()
                },
                success: (updateRes) => {
                  console.log('经销商密码重置成功:', updateRes);
                  success && success(updateRes);
                },
                fail: (updateErr) => {
                  console.error('经销商密码重置失败:', updateErr);
                  fail && fail(updateErr);
                }
              });
              return;
            }
          }
          // 遍历完所有经销商都没找到
          success && success(null);
        } else {
          success && success(null);
        }
      },
      fail: (err) => {
        console.error('查询 distributors 失败:', err);
        success && success(null);
      }
    });
  },

  /**
   * 在 stores 集合中重置密码
   * @param {string} phoneNumber 手机号
   * @param {string} newPassword 新密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  _resetPasswordInStores: function(phoneNumber, newPassword, success, fail) {
    const storesCollection = this.getCollection('stores');
    
    if (!storesCollection) {
      console.log('stores集合获取失败');
      success && success(null);
      return;
    }
    
    storesCollection.get({
      success: (res) => {
        if (res.data && res.data.length > 0) {
          // 遍历所有门店查找匹配的手机号
          for (const store of res.data) {
            let updateData = {};
            let found = false;
            
            // 检查门店主账号
            if (store.phone === phoneNumber) {
              updateData.password = newPassword;
              found = true;
            }
            
            // 检查店长
            if (store.managerPhone === phoneNumber) {
              updateData.managerPassword = newPassword;
              found = true;
            }
            
            // 检查店员列表
            if (store.staffList && store.staffList.length > 0) {
              const staffIndex = store.staffList.findIndex(s => s.phone === phoneNumber);
              if (staffIndex >= 0) {
                updateData['staffList.' + staffIndex + '.password'] = newPassword;
                found = true;
              }
            }
            
            if (found) {
              // 找到匹配的用户，更新密码
              storesCollection.doc(store._id).update({
                data: {
                  ...updateData,
                  updateTime: new Date()
                },
                success: (updateRes) => {
                  console.log('门店密码重置成功:', updateRes);
                  success && success(updateRes);
                },
                fail: (updateErr) => {
                  console.error('门店密码重置失败:', updateErr);
                  fail && fail(updateErr);
                }
              });
              return;
            }
          }
          // 遍历完所有门店都没找到
          success && success(null);
        } else {
          success && success(null);
        }
      },
      fail: (err) => {
        console.error('查询 stores 失败:', err);
        success && success(null);
      }
    });
  },

  /**
   * 创建用户并设置密码
   * @param {string} phoneNumber 手机号
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  createUserWithPassword: function(phoneNumber, password, success, fail) {
    try {
      console.log('创建用户并设置密码:', phoneNumber);
      const usersCollection = this.getCollection('users');
      
      usersCollection.add({
        data: {
          phone: phoneNumber,
          password: password,
          name: '新用户',
          role: 'staff',
          createTime: new Date(),
          updateTime: new Date()
        },
        success: (res) => {
          console.log('用户创建成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('用户创建失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('创建用户异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取经销商下所有用户
   * @param {string} distributorId 经销商ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getUsersByDistributor: function(distributorId, success, fail) {
    try {
      console.log('获取经销商下所有用户:', distributorId);
      const usersCollection = this.getCollection('users');
      
      usersCollection.where({
        distributorId: distributorId
      }).get({
        success: (res) => {
          console.log('获取用户列表成功:', res.data);
          success && success(res.data || []);
        },
        fail: (err) => {
          console.error('获取用户列表失败:', err);
          success && success([]);
        }
      });
    } catch (error) {
      console.error('获取用户列表异常:', error);
      success && success([]);
    }
  },

  /**
   * 保存用户密码到 users 集合
   * @param {Object} userData 用户数据
   * @param {string} password 密码
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveUserPassword: function(userData, password, success, fail) {
    try {
      console.log('保存用户密码:', userData.phoneNumber);
      const usersCollection = this.getCollection('users');
      
      if (!usersCollection) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }
      
      usersCollection.where({
        phone: userData.phoneNumber
      }).get({
        success: (res) => {
          if (res.data && res.data.length > 0) {
            // 更新现有用户
            const docId = res.data[0]._id;
            usersCollection.doc(docId).update({
              data: {
                password: password,
                name: userData.userName,
                role: userData.userRole,
                distributorId: userData.distributorId,
                storeId: userData.storeId,
                updateTime: new Date()
              },
              success: (updateRes) => {
                console.log('用户密码更新成功:', updateRes);
                success && success(updateRes);
              },
              fail: (err) => {
                console.error('用户密码更新失败:', err);
                fail && fail(err);
              }
            });
          } else {
            // 创建新用户
            usersCollection.add({
              data: {
                phone: userData.phoneNumber,
                password: password,
                name: userData.userName,
                role: userData.userRole,
                distributorId: userData.distributorId,
                storeId: userData.storeId,
                createTime: new Date(),
                updateTime: new Date()
              },
              success: (addRes) => {
                console.log('用户创建成功:', addRes);
                success && success(addRes);
              },
              fail: (err) => {
                console.error('用户创建失败:', err);
                fail && fail(err);
              }
            });
          }
        },
        fail: (err) => {
          console.error('查询用户失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('保存用户密码异常:', error);
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
  updateDistributorPassword: function(distributorId, phoneNumber, password, success, fail) {
    try {
      console.log('更新经销商密码:', distributorId, phoneNumber);
      const distributorsCollection = this.getCollection('distributors');
      
      if (!distributorsCollection) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }
      
      distributorsCollection.doc(distributorId).get({
        success: (res) => {
          if (res.data) {
            const distributor = res.data;
            let updateData = {};
            
            // 如果是经销商主账号
            if (distributor.phone === phoneNumber) {
              updateData.password = password;
            }
            
            // 如果是经销商员工
            if (distributor.staffList && distributor.staffList.length > 0) {
              const staffIndex = distributor.staffList.findIndex(s => s.phone === phoneNumber);
              if (staffIndex >= 0) {
                updateData['staffList.' + staffIndex + '.password'] = password;
              }
            }
            
            if (Object.keys(updateData).length > 0) {
              distributorsCollection.doc(distributorId).update({
                data: updateData,
                success: (updateRes) => {
                  console.log('经销商密码更新成功');
                  success && success(updateRes);
                },
                fail: (err) => {
                  console.error('经销商密码更新失败:', err);
                  fail && fail(err);
                }
              });
            } else {
              success && success({ message: '无需更新' });
            }
          } else {
            fail && fail({ errMsg: '未找到经销商信息' });
          }
        },
        fail: (err) => {
          console.error('查询经销商失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('更新经销商密码异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取客户来源列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getCustomerSources: function(success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      const allData = [];
      const batchSize = 20;
      let skipCount = 0;

      const fetchNext = () => {
        db.collection('customerSources')
          .orderBy('level', 'asc')
          .orderBy('sortOrder', 'asc')
          .skip(skipCount)
          .limit(batchSize)
          .get({
            success: (res) => {
              if (res.data && res.data.length > 0) {
                allData.push(...res.data);
                skipCount += batchSize;
                if (res.data.length === batchSize && allData.length < 100) {
                  fetchNext();
                } else {
                  success && success(allData);
                }
              } else {
                success && success(allData);
              }
            },
            fail: (err) => {
              success && success(allData.length > 0 ? allData : []);
            }
          });
      };

      fetchNext();
    } catch (error) {
      fail && fail(error);
    }
  },

  getCustomerSourcesByLevel: function(level, success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      db.collection('customerSources')
        .where({ level: level })
        .orderBy('sortOrder', 'asc')
        .get({
          success: (res) => {
            console.log('获取' + (level === 1 ? '一级' : '二级') + '客户来源成功:', res.data);
            success && success(res.data || []);
          },
          fail: (err) => {
            console.error('获取客户来源列表失败:', err);
            fail && fail(err);
          }
        });
    } catch (error) {
      console.error('获取客户来源列表异常:', error);
      fail && fail(error);
    }
  },

  getCustomerSourcesByParent: function(parentId, success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      db.collection('customerSources')
        .where({ parentId: parentId })
        .orderBy('sortOrder', 'asc')
        .get({
          success: (res) => {
            console.log('获取二级客户来源成功:', res.data);
            success && success(res.data || []);
          },
          fail: (err) => {
            console.error('获取二级客户来源失败:', err);
            fail && fail(err);
          }
        });
    } catch (error) {
      console.error('获取二级客户来源异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 保存客户来源
   * @param {Object} sourceData 客户来源数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  saveCustomerSource: function(sourceData, success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      const collection = db.collection('customerSources');

      const saveData = {
        name: sourceData.name,
        level: sourceData.level || 1,
        parentId: sourceData.parentId || null,
        parentName: sourceData.parentName || null,
        sortOrder: sourceData.sortOrder || 0,
        updateTime: db.serverDate()
      };

      if (sourceData.id) {
        // 更新现有记录
        collection.doc(sourceData.id).update({
          data: saveData,
          success: (res) => {
            console.log('客户来源更新成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('客户来源更新失败:', err);
            fail && fail(err);
          }
        });
      } else {
        console.log('执行新增操作');
        // 新增记录
        collection.add({
          data: {
            ...saveData,
            createTime: db.serverDate()
          },
          success: (res) => {
            console.log('客户来源添加成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('客户来源添加失败:', err);
            fail && fail(err);
          }
        });
      }
    } catch (error) {
      console.error('保存客户来源异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 删除客户来源
   * @param {string} sourceId 客户来源ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deleteCustomerSource: function(sourceId, success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      db.collection('customerSources').doc(sourceId).get({
        success: (res) => {
          const source = res.data;
          if (!source) {
            fail && fail({ errMsg: '记录不存在' });
            return;
          }

          if (source.level === 1) {
            db.collection('customerSources')
              .where({ parentId: sourceId })
              .remove({
                success: () => {
                  db.collection('customerSources').doc(sourceId).remove({
                    success: (delRes) => {
                      console.log('一级客户来源及其二级来源删除成功');
                      success && success(delRes);
                    },
                    fail: (err) => {
                      fail && fail(err);
                    }
                  });
                },
                fail: (err) => {
                  fail && fail(err);
                }
              });
          } else {
            db.collection('customerSources').doc(sourceId).remove({
              success: (delRes) => {
                console.log('客户来源删除成功');
                success && success(delRes);
              },
              fail: (err) => {
                fail && fail(err);
              }
            });
          }
        },
        fail: (err) => {
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('删除客户来源异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 获取收款方式列表
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  getPaymentMethods: function(success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      db.collection('paymentMethods')
        .orderBy('sortOrder', 'asc')
        .orderBy('createTime', 'desc')
        .get({
          success: (res) => {
            console.log('获取收款方式列表成功:', res.data);
            success && success(res.data || []);
          },
          fail: (err) => {
            console.error('获取收款方式列表失败:', err);
            // 如果是集合不存在错误，返回空数组
            if (err.errCode === -502005 || err.errMsg.includes('collection not exists')) {
              success && success([]);
            } else {
              fail && fail(err);
            }
          }
        });
    } catch (error) {
      console.error('获取收款方式列表异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 保存收款方式
   * @param {Object} methodData 收款方式数据
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  savePaymentMethod: function(methodData, success, fail) {
    try {
      console.log('Database.savePaymentMethod 接收到的数据:', methodData, 'id:', methodData.id);
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }

      const collection = db.collection('paymentMethods');

      // 构建保存数据，包含排序号
      const saveData = {
        name: methodData.name,
        sortOrder: methodData.sortOrder || 0,
        updateTime: db.serverDate()
      };

      if (methodData.id) {
        console.log('执行更新操作，文档ID:', methodData.id);
        // 更新现有记录
        collection.doc(methodData.id).update({
          data: saveData,
          success: (res) => {
            console.log('收款方式更新成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('收款方式更新失败:', err);
            fail && fail(err);
          }
        });
      } else {
        // 新增记录
        collection.add({
          data: {
            ...saveData,
            createTime: db.serverDate()
          },
          success: (res) => {
            console.log('收款方式添加成功:', res);
            success && success(res);
          },
          fail: (err) => {
            console.error('收款方式添加失败:', err);
            fail && fail(err);
          }
        });
      }
    } catch (error) {
      console.error('保存收款方式异常:', error);
      fail && fail(error);
    }
  },

  /**
   * 删除收款方式
   * @param {string} methodId 收款方式ID
   * @param {function} success 成功回调
   * @param {function} fail 失败回调
   */
  deletePaymentMethod: function(methodId, success, fail) {
    try {
      const db = this.getDB();
      if (!db) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }
      
      db.collection('paymentMethods').doc(methodId).remove({
        success: (res) => {
          console.log('收款方式删除成功:', res);
          success && success(res);
        },
        fail: (err) => {
          console.error('收款方式删除失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('删除收款方式异常:', error);
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
  updateStorePassword: function(storeId, phoneNumber, password, success, fail) {
    try {
      console.log('更新门店密码:', storeId, phoneNumber);
      const storesCollection = this.getCollection('stores');
      
      if (!storesCollection) {
        fail && fail({ errMsg: '数据库连接失败' });
        return;
      }
      
      storesCollection.doc(storeId).get({
        success: (res) => {
          if (res.data) {
            const store = res.data;
            let updateData = {};
            
            // 如果是门店主账号
            if (store.phone === phoneNumber) {
              updateData.password = password;
            }
            
            // 如果是店长
            if (store.managerPhone === phoneNumber) {
              updateData.managerPassword = password;
            }
            
            // 如果是店员
            if (store.staffList && store.staffList.length > 0) {
              const staffIndex = store.staffList.findIndex(s => s.phone === phoneNumber);
              if (staffIndex >= 0) {
                updateData['staffList.' + staffIndex + '.password'] = password;
              }
            }
            
            if (Object.keys(updateData).length > 0) {
              storesCollection.doc(storeId).update({
                data: updateData,
                success: (updateRes) => {
                  console.log('门店密码更新成功');
                  success && success(updateRes);
                },
                fail: (err) => {
                  console.error('门店密码更新失败:', err);
                  fail && fail(err);
                }
              });
            } else {
              success && success({ message: '无需更新' });
            }
          } else {
            fail && fail({ errMsg: '未找到门店信息' });
          }
        },
        fail: (err) => {
          console.error('查询门店失败:', err);
          fail && fail(err);
        }
      });
    } catch (error) {
      console.error('更新门店密码异常:', error);
      fail && fail(error);
    }
  }
};

function resolveOrderId(orderNo) {
  return api.order.queryList({ orderNo, page: 1, pageSize: 1 })
    .then(res => {
      const order = res && res.data && res.data[0];
      if (!order) throw new Error('订单不存在');
      return order.orderId || order._id;
    });
}

Database.getOrders = function (success, fail) {
  api.order.queryList({ page: 1, pageSize: 100 })
    .then(res => success && success(res.data || []))
    .catch(err => {
      console.error('get orders failed:', err);
      fail && fail(err);
      success && success([]);
    });
};

Database.getOrderByNo = function (orderNo, success, fail) {
  api.order.queryList({ orderNo, page: 1, pageSize: 1 })
    .then(res => success && success((res.data || [])[0]))
    .catch(err => {
      console.error('get order failed:', err);
      fail && fail(err);
    });
};

Database.updateOrder = function (orderNo, updateData, success, fail) {
  resolveOrderId(orderNo)
    .then(orderId => api.order.update(orderId, Object.assign({}, updateData, { update_time: new Date() })))
    .then(res => success && success(res))
    .catch(err => {
      console.error('update order failed:', err);
      fail && fail(err);
    });
};

function pipe(promise, success, fail, fallback) {
  return promise.then(res => {
    success && success(res);
    return res;
  }).catch(err => {
    console.error('mysql api failed:', err);
    fail && fail(err);
    if (fallback !== undefined) {
      success && success(fallback);
      return fallback;
    }
    throw err;
  });
}

function firstUserByPhone(phoneNumber) {
  return api.system.getUsers({ phone: phoneNumber, page: 1, pageSize: 100 }).then(res => {
    const list = res.data || [];
    return list.find(user => String(user.phoneNumber || user.phone || '') === String(phoneNumber)) || list[0] || null;
  });
}

Database.init = function (success) {
  success && success({ code: 200, message: 'MySQL API ready' });
};

Database.getDB = function () {
  return wx && wx.cloud && wx.cloud.database ? wx.cloud.database() : null;
};

Database.getCollection = function (name) {
  const db = this.getDB();
  return db ? db.collection(name) : null;
};

Database.saveOrder = function (orderData, success, fail) {
  return pipe(api.order.create(orderData), success, fail);
};

Database.deleteOrder = function (orderNo, success, fail) {
  return pipe(api.order.updateByOrderNo(orderNo, { status: 'deleted', isDeleted: true, is_deleted: 1 }), success, fail);
};

Database.saveStore = function (storeData, success, fail) {
  const storeId = storeData.storeId || storeData.store_id || storeData.id || storeData._id;
  const task = storeId ? api.store.update(storeId, storeData) : api.store.create(storeData);
  return pipe(task, success, fail);
};

Database.getStores = function (success, fail) {
  return pipe(api.store.getStores().then(res => res.data || []), success, fail, []);
};

Database.getStoresByDistributor = function (distributorId, success, fail) {
  return pipe(api.store.getStores(distributorId).then(res => res.data || []), success, fail, []);
};

Database.deleteStore = function (storeId, success, fail) {
  return pipe(api.store.delete(storeId), success, fail);
};

Database.getAllStaffByDistributor = function (distributorId, success, fail) {
  return pipe(api.system.getUsers({ distributorId, page: 1, pageSize: 200 }).then(res => res.data || []), success, fail, []);
};

Database.saveUser = function (userData, success, fail) {
  const staffId = userData.staffId || userData.staff_id || userData.id || userData._id;
  const task = staffId ? api.system.updateUser(staffId, userData) : api.system.createUser(userData);
  return pipe(task, success, fail);
};

Database.getUserByPhone = function (phoneNumber, success, fail) {
  return pipe(firstUserByPhone(phoneNumber), success, fail, null);
};

Database.findUserInStoresAndDistributor = function (phoneNumber, success, fail) {
  return pipe(firstUserByPhone(phoneNumber), success, fail, null);
};

Database.verifyUserPassword = function (phoneNumber, password, success, fail) {
  return pipe(api.auth.login(phoneNumber, password), success, fail);
};

Database.verifyUserPasswordFromStores = Database.verifyUserPassword;

Database.changeUserPassword = function (oldPassword, newPassword, success, fail) {
  return pipe(api.auth.changePassword(oldPassword, newPassword), success, fail);
};

Database.resetUserPassword = function (phoneNumber, password, success, fail) {
  return firstUserByPhone(phoneNumber)
    .then(user => {
      if (!user) throw new Error('User not found');
      return api.system.updateUser(user.staffId || user.id || user._id, { password });
    })
    .then(res => success && success(res))
    .catch(err => {
      console.error('reset user password failed:', err);
      fail && fail(err);
    });
};

Database.getUsersByDistributor = function (distributorId, success, fail) {
  return Database.getAllStaffByDistributor(distributorId, success, fail);
};

Database.saveUserPassword = function (userData, password, success, fail) {
  const staffId = userData.staffId || userData.id || userData._id;
  if (!staffId) return Database.resetUserPassword(userData.phoneNumber || userData.phone, password, success, fail);
  return pipe(api.system.updateUser(staffId, { password }), success, fail);
};

Database.updateDistributorPassword = function (phoneNumber, password, success, fail) {
  return Database.resetUserPassword(phoneNumber, password, success, fail);
};

Database.updateStorePassword = function (storeId, phoneNumber, password, success, fail) {
  return Database.resetUserPassword(phoneNumber, password, success, fail);
};

Database.saveGoods = function (goodsData, success, fail) {
  return pipe(api.product.saveLegacyGoods(goodsData), success, fail);
};

Database.batchSaveGoods = function (goodsList, success, fail) {
  return pipe(Promise.all((goodsList || []).map(item => api.product.saveLegacyGoods(item))), success, fail);
};

Database.getGoodsBySN = function (sn, success, fail) {
  return pipe(api.inventory.getGoodsBySN(sn), success, fail, null);
};

Database.getGoodsByPN = function (pn, success, fail) {
  return pipe(api.inventory.getGoodsByPN(pn), success, fail, null);
};

Database.searchGoodsByField = function (field, value, success, fail) {
  const task = field === 'SN' || field === 'sn' || field === 'snCode'
    ? api.inventory.getGoodsBySN(value).then(item => item ? [item] : [])
    : api.product.search(value || '', { page: 1, pageSize: 100 });
  return pipe(task, success, fail, []);
};

Database.getAllGoods = function (success, fail) {
  return pipe(api.product.list({ page: 1, pageSize: 500 }), success, fail, []);
};

Database.saveDistributorInfo = function (distributorInfo, success, fail) {
  return pipe(Promise.resolve({ code: 200, data: distributorInfo }), success, fail);
};

Database.getDistributorInfo = function (success, fail) {
  return pipe(api.store.getDistributor().then(res => res.data), success, fail, null);
};

Database.getDistributorById = function (distributorId, success, fail) {
  return pipe(api.store.getDistributor(distributorId).then(res => res.data), success, fail, null);
};

Database.getCustomerSources = function (success, fail) {
  return pipe(api.dict.getCustomerSources(), success, fail, []);
};

Database.getCustomerSourcesByLevel = function (level, success, fail) {
  return pipe(api.dict.getCustomerSources().then(rows => rows.filter(row => Number(row.level) === Number(level))), success, fail, []);
};

Database.getCustomerSourcesByParent = function (parentId, success, fail) {
  return pipe(api.dict.getCustomerSources().then(rows => rows.filter(row => String(row.parentId || '') === String(parentId || ''))), success, fail, []);
};

Database.saveCustomerSource = function (sourceData, success, fail) {
  return pipe(api.dict.saveCustomerSource(sourceData), success, fail);
};

Database.deleteCustomerSource = function (sourceId, success, fail) {
  return pipe(api.dict.deleteCustomerSource(sourceId), success, fail);
};

Database.getPaymentMethods = function (success, fail) {
  return pipe(api.dict.getPaymentMethods(), success, fail, []);
};

Database.savePaymentMethod = function (methodData, success, fail) {
  return pipe(api.dict.savePaymentMethod(methodData), success, fail);
};

Database.deletePaymentMethod = function (methodId, success, fail) {
  return pipe(api.dict.deletePaymentMethod(methodId), success, fail);
};

Database.getSupplementItems = function (success, fail) {
  return pipe(api.dict.getSupplementItems(), success, fail, []);
};

Database.saveSupplementItem = function (itemData, success, fail) {
  return pipe(api.dict.saveSupplementItem(itemData), success, fail);
};

Database.deleteSupplementItem = function (itemId, success, fail) {
  return pipe(api.dict.deleteSupplementItem(itemId), success, fail);
};

Database.createTransfer = function (transferData, success, fail) {
  return pipe(api.inventory.transfer(transferData), success, fail);
};

Database.getTransfers = function (params, success, fail) {
  return pipe(api.inventory.transferList(params).then(res => res.data || []), success, fail, []);
};

Database.confirmTransferOut = function (transferId, success, fail) {
  return pipe(api.inventory.confirmTransferOut(transferId), success, fail);
};

Database.confirmTransferIn = function (transferId, success, fail) {
  return pipe(api.inventory.confirmTransferIn(transferId), success, fail);
};

Database.revokeTransfer = function (transferId, success, fail) {
  return pipe(api.inventory.revokeTransfer(transferId), success, fail);
};

Database.rejectTransfer = function (transferId, reason, success, fail) {
  return pipe(api.inventory.rejectTransfer(transferId, { reason: reason || '' }), success, fail);
};

module.exports = Database;
