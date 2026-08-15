// pages/printer/printer.js
// 日志工具函数
const log = {
  info: (msg, data) => {
    console.log(`[Printer][INFO] ${msg}`, data || '');
  },
  error: (msg, err) => {
    console.error(`[Printer][ERROR] ${msg}`, err || '');
  },
  warn: (msg, data) => {
    console.warn(`[Printer][WARN] ${msg}`, data || '');
  }
};

// 调试配置 - 设置为 true 可以模拟正式版的权限检查
const DEBUG_CONFIG = {
  // 强制检查权限模式 - 开启后会模拟正式版的权限申请流程
  FORCE_PERMISSION_CHECK: false,
  // 模拟权限被拒绝
  MOCK_PERMISSION_DENIED: false
};

Page({
  /**
   * 页面的初始数据
   */
  data: {
    isBluetoothEnabled: false,
    isSearching: false,
    bluetoothDevices: [],
    connectedPrinter: null,
    bluetoothAdapter: null,
    debugInfo: '' // 调试信息
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    log.info('页面加载');
    // 获取运行环境信息
    const systemInfo = wx.getSystemInfoSync();
    log.info('运行环境:', {
      platform: systemInfo.platform,
      version: systemInfo.version,
      environment: systemInfo.environment
    });
    this.updateDebugInfo(`环境: ${systemInfo.platform}`);
    
    // 页面加载时不自动初始化蓝牙，等待用户点击"开启蓝牙"按钮
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    log.info('页面显示');
    // 检查蓝牙适配器状态并更新UI
    this.checkAndUpdateBluetoothState();
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {
    log.info('页面隐藏');
    // 停止搜索
    this.stopSearch();
  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload: function () {
    log.info('页面卸载');
    // 停止搜索
    this.stopSearch();
    // 注意：不要关闭蓝牙适配器，保持打印机连接
    // this.closeBluetoothAdapter();
  },

  /**
   * 更新调试信息
   */
  updateDebugInfo: function (info) {
    const timestamp = new Date().toLocaleTimeString();
    const debugInfo = `[${timestamp}] ${info}`;
    log.info(debugInfo);
    this.setData({
      debugInfo: debugInfo
    });
  },

  /**
   * 初始化蓝牙适配器
   */
  initBluetooth: function () {
    log.info('开始初始化蓝牙适配器');
    this.updateDebugInfo('开始初始化蓝牙适配器');

    // 正式版：先检查权限，再打开蓝牙适配器
    this.checkAndRequestPermission(() => {
      this.doInitBluetooth();
    });
  },

  /**
   * 检查并申请权限
   */
  checkAndRequestPermission: function (callback) {
    wx.getSetting({
      success: (res) => {
        const authSetting = res.authSetting;
        log.info('当前权限状态:', authSetting);
        
        if (authSetting['scope.bluetoothDevices'] === true) {
          // 已有权限，直接执行
          this.updateDebugInfo('已有蓝牙权限');
          callback && callback();
        } else if (authSetting['scope.bluetoothDevices'] === false) {
          // 用户之前拒绝过，引导去设置
          this.updateDebugInfo('权限被拒绝，引导去设置');
          wx.showModal({
            title: '需要蓝牙权限',
            content: '蓝牙打印需要您授权使用蓝牙功能，是否前往设置开启？',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.bluetoothDevices']) {
                      callback && callback();
                    } else {
                      this.updateDebugInfo('用户未开启权限');
                      wx.showToast({ title: '未获得蓝牙权限', icon: 'none' });
                    }
                  }
                });
              }
            }
          });
        } else {
          // 未申请过权限，显示授权按钮让用户主动点击（正式版要求）
          this.updateDebugInfo('需要用户授权蓝牙权限');
          wx.showModal({
            title: '需要蓝牙权限',
            content: '蓝牙打印功能需要使用蓝牙，请点击确定授权',
            showCancel: false,
            success: () => {
              // 用户点击后尝试打开蓝牙（触发权限申请）
              callback && callback();
            }
          });
        }
      },
      fail: () => {
        // 获取设置失败，直接尝试
        callback && callback();
      }
    });
  },

  /**
   * 执行蓝牙初始化
   */
  doInitBluetooth: function () {
    wx.openBluetoothAdapter({
      success: (res) => {
        log.info('蓝牙适配器初始化成功', res);
        this.updateDebugInfo('蓝牙适配器初始化成功');
        this.setData({
          isBluetoothEnabled: true
        });
        // 开始监听蓝牙状态变化
        this.startBluetoothStateMonitor();
        // 尝试获取已连接的设备
        this.checkConnectedDevices();
      },
      fail: (err) => {
        log.error('蓝牙适配器初始化失败', err);
        this.updateDebugInfo(`初始化失败: ${err.errCode} - ${err.errMsg || err.message}`);

        // 处理不同错误码
        if (err.errCode === 10001) {
          // 蓝牙未开启
          this.setData({
            isBluetoothEnabled: false
          });
          wx.showModal({
            title: '蓝牙未开启',
            content: '请前往手机设置开启蓝牙功能',
            showCancel: false
          });
        } else if (err.errCode === 10008 || err.errCode === 10009) {
          // 权限相关错误
          this.updateDebugInfo('需要蓝牙权限，尝试申请...');
          this.handleBluetoothPermissionError();
        } else if (err.errMsg && err.errMsg.includes('fail')) {
          // 接口未授权（小程序后台未开启蓝牙权限）
          wx.showModal({
            title: '蓝牙功能未开启',
            content: '请在小程序后台「设置-接口设置」中开启蓝牙权限，并确保用户隐私保护指引已审核通过',
            showCancel: false
          });
        } else {
          // 其他错误
          wx.showToast({
            title: '蓝牙初始化失败: ' + (err.errMsg || '未知错误'),
            icon: 'none',
            duration: 3000
          });
        }
      }
    });
  },

  /**
   * 处理蓝牙权限错误
   */
  handleBluetoothPermissionError: function () {
    wx.getSetting({
      success: (res) => {
        const authSetting = res.authSetting;
        if (authSetting['scope.bluetoothDevices'] === false) {
          // 用户之前拒绝过权限
          wx.showModal({
            title: '需要蓝牙权限',
            content: '蓝牙打印功能需要蓝牙权限，是否前往设置页面开启？',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.bluetoothDevices']) {
                      this.retryInitBluetooth();
                    } else {
                      this.updateDebugInfo('用户未开启蓝牙权限');
                      wx.showToast({
                        title: '未获得蓝牙权限',
                        icon: 'none'
                      });
                    }
                  }
                });
              }
            }
          });
        } else {
          // 从未申请过权限，直接引导去设置
          wx.showModal({
            title: '需要蓝牙权限',
            content: '请允许小程序使用蓝牙功能，是否前往设置？',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.bluetoothDevices']) {
                      this.retryInitBluetooth();
                    }
                  }
                });
              }
            }
          });
        }
      }
    });
  },

  /**
   * 重试初始化蓝牙
   */
  retryInitBluetooth: function () {
    setTimeout(() => {
      this.initBluetooth();
    }, 500);
  },

  /**
   * 检查已保存的打印机（不自动连接，仅显示绑定状态）
   */
  checkConnectedDevices: function () {
    this.updateDebugInfo('检查已绑定的打印机...');

    // 检查是否有已保存的打印机
    const savedPrinter = wx.getStorageSync('connectedPrinter');
    if (savedPrinter) {
      this.updateDebugInfo(`已绑定打印机: ${savedPrinter.name}`);
      this.setData({
        connectedPrinter: savedPrinter
      });
    } else {
      this.updateDebugInfo('没有已绑定的打印机');
    }
  },

  /**
   * 自动连接打印机
   */
  autoConnectPrinter: function (device) {
    this.updateDebugInfo(`尝试自动连接: ${device.name}`);

    const BluetoothPrinter = require('../../utils/bluetooth.js');

    BluetoothPrinter.connectDevice(device.deviceId,
      (info) => {
        this.updateDebugInfo('自动连接成功');
        this.setData({
          connectedPrinter: device
        });
        wx.setStorageSync('connectedPrinter', device);
      },
      (err) => {
        this.updateDebugInfo(`自动连接失败: ${err}`);
        // 连接失败，显示搜索界面让用户手动连接
        wx.showModal({
          title: '连接失败',
          content: '无法连接到已保存的打印机，请重新搜索并绑定',
          showCancel: false
        });
      }
    );
  },

  /**
   * 申请蓝牙权限（正式版必需）
   * 注意：微信小程序蓝牙权限通过 openBluetoothAdapter 自动申请，不需要单独调用 authorize
   */
  requestBluetoothPermission: function (successCallback) {
    // 获取系统信息，判断是否在真机运行
    const systemInfo = wx.getSystemInfoSync();
    const isSimulator = systemInfo.platform === 'devtools';

    // 开发者工具环境直接跳过权限申请
    if (isSimulator) {
      console.log('开发者工具环境，跳过权限申请');
      successCallback && successCallback();
      return;
    }

    this.updateDebugInfo('检查蓝牙权限...');

    // 调试模式：强制检查权限
    if (DEBUG_CONFIG.FORCE_PERMISSION_CHECK) {
      console.log('【调试模式】强制检查权限');
      this.updateDebugInfo('[调试] 强制检查权限');
      
      // 模拟正式版行为：必须先获得权限才能使用
      wx.getSetting({
        success: (res) => {
          const authSetting = res.authSetting;
          
          // 调试模式：模拟权限被拒绝
          if (DEBUG_CONFIG.MOCK_PERMISSION_DENIED) {
            console.log('【调试模式】模拟权限被拒绝');
            authSetting['scope.bluetoothDevices'] = false;
          }
          
          if (authSetting['scope.bluetoothDevices'] === true) {
            this.updateDebugInfo('已有蓝牙权限');
            successCallback && successCallback();
          } else if (authSetting['scope.bluetoothDevices'] === false) {
            // 用户之前拒绝过
            this.updateDebugInfo('权限被拒绝，引导去设置');
            wx.showModal({
              title: '需要蓝牙权限',
              content: '【调试模式】模拟正式版：蓝牙打印功能需要您的授权，是否前往设置页面开启？',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  wx.openSetting({
                    success: (settingRes) => {
                      if (settingRes.authSetting['scope.bluetoothDevices']) {
                        successCallback && successCallback();
                      } else {
                        wx.showToast({
                          title: '未获得蓝牙权限',
                          icon: 'none'
                        });
                      }
                    }
                  });
                }
              }
            });
          } else {
            // 未申请过权限，引导用户去设置（模拟正式版行为）
            this.updateDebugInfo('未申请权限，引导去设置');
            wx.showModal({
              title: '需要蓝牙权限',
              content: '【调试模式】模拟正式版：请先授权蓝牙权限',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  wx.openSetting({
                    success: (settingRes) => {
                      if (settingRes.authSetting['scope.bluetoothDevices']) {
                        successCallback && successCallback();
                      }
                    }
                  });
                }
              }
            });
          }
        }
      });
      return;
    }

    // 正常流程
    wx.getSetting({
      success: (res) => {
        const authSetting = res.authSetting;
        console.log('当前权限状态：', authSetting);

        // 检查是否已授权蓝牙权限
        if (authSetting['scope.bluetoothDevices'] === true) {
          // 已授权，直接执行
          this.updateDebugInfo('已有蓝牙权限');
          successCallback && successCallback();
        } else if (authSetting['scope.bluetoothDevices'] === false) {
          // 用户之前拒绝过，需要引导去设置页面
          this.updateDebugInfo('权限被拒绝，引导去设置');
          wx.showModal({
            title: '需要蓝牙权限',
            content: '蓝牙打印功能需要您的授权，是否前往设置页面开启？',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.bluetoothDevices']) {
                      successCallback && successCallback();
                    } else {
                      wx.showToast({
                        title: '未获得蓝牙权限',
                        icon: 'none'
                      });
                    }
                  }
                });
              }
            }
          });
        } else {
          // 未申请过权限，直接尝试打开蓝牙适配器（会自动申请权限）
          this.updateDebugInfo('尝试打开蓝牙适配器...');
          successCallback && successCallback();
        }
      },
      fail: (err) => {
        console.error('获取权限设置失败', err);
        this.updateDebugInfo('获取权限设置失败');
        // 获取失败也尝试执行，让后续API自己处理
        successCallback && successCallback();
      }
    });
  },

  /**
   * 检查蓝牙状态
   */
  checkBluetoothStatus: function () {
    wx.getBluetoothAdapterState({
      success: (res) => {
        console.log('蓝牙适配器状态：', res);
        this.setData({
          isBluetoothEnabled: res.available
        });
      },
      fail: (err) => {
        console.error('获取蓝牙适配器状态失败：', err);
        // 如果获取失败，说明适配器未初始化或蓝牙未开启
        this.setData({
          isBluetoothEnabled: false
        });
      }
    });
  },

  /**
   * 检查并更新蓝牙状态
   * 页面显示时调用，确保UI显示正确的状态
   */
  checkAndUpdateBluetoothState: function () {
    log.info('检查并更新蓝牙状态');
    this.updateDebugInfo('检查蓝牙状态...');

    // 加载本地保存的打印机信息
    const savedPrinter = wx.getStorageSync('connectedPrinter');

    // 检查蓝牙适配器状态
    wx.getBluetoothAdapterState({
      success: (res) => {
        log.info('蓝牙适配器状态：', res);
        this.updateDebugInfo(`蓝牙状态: ${res.available ? '可用' : '不可用'}`);

        if (res.available) {
          // 蓝牙已开启，检查是否有已连接的设备
          this.checkConnectedBLEDevices(savedPrinter);
        } else {
          // 蓝牙未开启
          this.setData({
            isBluetoothEnabled: false,
            connectedPrinter: null
          });
        }
      },
      fail: (err) => {
        log.warn('蓝牙适配器未初始化：', err);
        this.updateDebugInfo('蓝牙适配器未初始化');
        // 适配器未初始化，尝试初始化
        this.initBluetooth();
      }
    });
  },

  /**
   * 检查蓝牙状态并显示绑定的打印机（不检查实时连接状态）
   */
  checkConnectedBLEDevices: function (savedPrinter) {
    // 采用"用完即断"模式，平时不保持连接
    // 只显示是否有绑定的打印机
    if (savedPrinter) {
      this.updateDebugInfo(`已绑定打印机: ${savedPrinter.name}`);
    } else {
      this.updateDebugInfo('未绑定打印机');
    }
    this.setData({
      isBluetoothEnabled: true,
      connectedPrinter: savedPrinter || null
    });
  },

  /**
   * 连接上一次使用的打印机
   */
  connectLastPrinter: function () {
    const savedPrinter = wx.getStorageSync('connectedPrinter');
    const printerInfo = wx.getStorageSync('printerInfo');

    console.log('尝试连接已配对打印机:', savedPrinter);
    console.log('打印机信息:', printerInfo);

    // 检查是否有有效的打印机信息
    if (!savedPrinter || !savedPrinter.deviceId) {
      wx.showToast({
        title: '没有找到已配对的打印机',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({
      title: '正在连接...',
      mask: true
    });

    const BluetoothPrinter = require('../../utils/bluetooth.js');

    BluetoothPrinter.connectDevice(savedPrinter.deviceId,
      (info) => {
        wx.hideLoading();
        wx.showToast({
          title: '连接成功',
          icon: 'success'
        });
        this.setData({
          connectedPrinter: savedPrinter
        });
      },
      (err) => {
        wx.hideLoading();
        wx.showModal({
          title: '连接失败',
          content: '无法连接到打印机，请确保打印机已开启并在附近',
          showCancel: false
        });
      }
    );
  },

  /**
   * 重新初始化蓝牙适配器
   * 用于从设置页面返回后刷新蓝牙状态
   */
  reinitBluetooth: function () {
    log.info('重新检查蓝牙适配器状态');
    this.updateDebugInfo('重新检查蓝牙状态');

    // 先检查当前状态
    wx.getBluetoothAdapterState({
      success: (res) => {
        log.info('蓝牙适配器已初始化，状态：', res);
        this.updateDebugInfo(`蓝牙状态: ${res.available ? '可用' : '不可用'}`);
        this.setData({
          isBluetoothEnabled: res.available
        });
      },
      fail: (err) => {
        log.warn('蓝牙适配器未初始化，尝试重新初始化：', err);
        this.updateDebugInfo(`适配器未初始化，错误码: ${err.errCode}`);
        // 适配器未初始化，尝试重新初始化
        this.initBluetooth();
      }
    });
  },

  /**
   * 开始监听蓝牙状态变化
   */
  startBluetoothStateMonitor: function () {
    log.info('开始监听蓝牙状态变化');
    
    // 监听蓝牙适配器状态变化
    wx.onBluetoothAdapterStateChange((res) => {
      log.info('蓝牙适配器状态变化：', res);
      this.updateDebugInfo(`蓝牙状态变化: ${res.available ? '可用' : '不可用'}`);
      this.setData({
        isBluetoothEnabled: res.available
      });
      
      if (!res.available) {
        // 蓝牙被关闭，停止搜索
        this.stopSearch();
        wx.showToast({
          title: '蓝牙已关闭',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 关闭蓝牙适配器
   */
  closeBluetoothAdapter: function () {
    log.info('关闭蓝牙适配器');
    wx.closeBluetoothAdapter({
      success: () => {
        log.info('蓝牙适配器关闭成功');
      },
      fail: (err) => {
        log.error('蓝牙适配器关闭失败', err);
      }
    });
  },

  /**
   * 加载已绑定的打印机
   */
  loadBoundPrinter: function () {
    // 引入数据库操作工具
    const Database = require('../../utils/database.js');
    
    // 从本地存储获取（暂时保留，后续完全迁移到数据库）
    const connectedPrinter = wx.getStorageSync('connectedPrinter');
    if (connectedPrinter) {
      this.setData({
        connectedPrinter: connectedPrinter
      });
    }
  },

  /**
   * 搜索开关切换
   */
  onSearchToggle: function (e) {
    const checked = e.detail.value;
    
    if (checked) {
      // 开始搜索
      this.startSearch();
    } else {
      // 停止搜索
      this.stopSearch();
    }
    
    this.setData({
      isSearching: checked
    });
  },

  /**
   * 开始搜索蓝牙设备
   */
  startSearch: function () {
    // 先检查蓝牙适配器状态
    wx.getBluetoothAdapterState({
      success: (res) => {
        console.log('蓝牙适配器状态:', res);
        if (!res.available) {
          wx.showModal({
            title: '蓝牙未开启',
            content: '请前往手机设置开启蓝牙功能',
            showCancel: false
          });
          this.setData({ isSearching: false });
          return;
        }
        // 蓝牙已开启，开始搜索
        this.doStartDiscovery();
      },
      fail: (err) => {
        console.error('获取蓝牙状态失败:', err);
        // 适配器未初始化，尝试初始化
        this.updateDebugInfo('适配器未初始化，尝试初始化...');
        this.initBluetoothForSearch();
      }
    });
  },

  /**
   * 为搜索初始化蓝牙
   */
  initBluetoothForSearch: function () {
    wx.openBluetoothAdapter({
      success: () => {
        this.updateDebugInfo('蓝牙适配器初始化成功');
        this.setData({ isBluetoothEnabled: true });
        this.doStartDiscovery();
      },
      fail: (err) => {
        console.error('初始化失败:', err);
        this.updateDebugInfo(`初始化失败: ${err.errCode}`);
        if (err.errCode === 10001) {
          wx.showModal({
            title: '蓝牙未开启',
            content: '请前往手机设置开启蓝牙功能',
            showCancel: false
          });
        } else {
          // 可能是权限问题
          wx.showModal({
            title: '需要蓝牙权限',
            content: '蓝牙打印需要蓝牙权限，是否前往设置开启？',
            confirmText: '去设置',
            cancelText: '取消',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        }
        this.setData({ isSearching: false });
      }
    });
  },

  /**
   * 执行搜索
   */
  doStartDiscovery: function () {
    // 清空设备列表
    this.setData({
      bluetoothDevices: []
    });

    this.updateDebugInfo('开始搜索蓝牙设备...');

    // 先获取已配对的设备
    wx.getBluetoothDevices({
      success: (res) => {
        console.log('获取已配对设备:', res);
        this.updateDebugInfo(`已配对设备: ${res.devices ? res.devices.length : 0}个`);

        if (res.devices && res.devices.length > 0) {
          // 只添加有名称的蓝牙设备，且名称以"DL"开头或包含"T58"、"58A"
          const devices = res.devices.filter(device => {
            if (!device.name || !device.deviceId) return false;
            const name = device.name.toUpperCase();
            return name.startsWith('DL') || name.includes('T58') || name.includes('58A');
          });
          if (devices.length > 0) {
            this.setData({
              bluetoothDevices: devices
            });
            this.updateDebugInfo(`显示 ${devices.length} 个已配对设备`);
          }
        }
      },
      fail: (err) => {
        console.log('获取已配对设备失败:', err);
      }
    });

    // 开始搜索新设备
    wx.startBluetoothDevicesDiscovery({
      services: [],
      allowDuplicatesKey: false,
      interval: 0,
      success: (res) => {
        console.log('开始搜索蓝牙设备成功', res);
        this.updateDebugInfo('搜索已启动，等待发现设备...');

        // 设置超时，30秒后自动停止
        setTimeout(() => {
          if (this.data.isSearching) {
            this.stopSearch();
            this.setData({ isSearching: false });
            this.updateDebugInfo('搜索超时，已自动停止');
          }
        }, 30000);

        // 监听发现新设备
        wx.onBluetoothDeviceFound((res) => {
          console.log('发现设备:', res);
          this.onDeviceFound(res);
        });
      },
      fail: (err) => {
        console.error('搜索蓝牙设备失败', err);
        this.updateDebugInfo(`搜索失败: ${err.errCode} - ${err.errMsg}`);
        this.setData({ isSearching: false });

        if (err.errCode === 10001) {
          wx.showModal({
            title: '蓝牙未开启',
            content: '请前往手机设置开启蓝牙功能后重试',
            showCancel: false
          });
        } else if (err.errCode === 10008) {
          wx.showToast({
            title: '搜索超时，请重试',
            icon: 'none'
          });
        } else {
          wx.showToast({
            title: '搜索失败：' + (err.errMsg || '请检查蓝牙权限'),
            icon: 'none',
            duration: 3000
          });
        }
      }
    });
  },

  /**
   * 停止搜索蓝牙设备
   */
  stopSearch: function () {
    wx.stopBluetoothDevicesDiscovery({
      success: (res) => {
        console.log('停止搜索蓝牙设备', res);
      }
    });
    
    // 移除设备发现监听
    wx.offBluetoothDeviceFound();
  },

  /**
   * 发现新设备
   */
  onDeviceFound: function (res) {
    const devices = res.devices || [];
    console.log('onDeviceFound 收到设备:', devices);
    this.updateDebugInfo(`发现 ${devices.length} 个设备`);

    let bluetoothDevices = this.data.bluetoothDevices;
    let newDeviceCount = 0;

    // 过滤重复设备并添加到列表
    devices.forEach(device => {
      console.log('处理设备:', device.name, device.deviceId, 'RSSI:', device.RSSI);

      // 只添加有名称的蓝牙设备，且名称以"DL"开头或包含"T58"、"58A"
      if (device.name && device.deviceId) {
        const name = device.name.toUpperCase();
        // 检查是否是打印机：DL开头 或 包含T58、58A
        const isPrinter = name.startsWith('DL') || name.includes('T58') || name.includes('58A');
        
        if (isPrinter) {
          // 检查设备是否已存在
          const exists = bluetoothDevices.some(item => item.deviceId === device.deviceId);
          if (!exists) {
            bluetoothDevices.push(device);
            newDeviceCount++;
            console.log('添加打印机设备:', device.name);
          }
        } else {
          console.log('跳过非打印机设备:', device.name);
        }
      } else {
        console.log('跳过无名称设备:', device.deviceId);
      }
    });

    if (newDeviceCount > 0) {
      this.updateDebugInfo(`新增 ${newDeviceCount} 个打印机，共 ${bluetoothDevices.length} 个`);
      this.setData({
        bluetoothDevices: bluetoothDevices
      });
    }
  },

  /**
   * 绑定打印机
   */
  bindPrinter: function (e) {
    const device = e.currentTarget.dataset.device;
    const BluetoothPrinter = require('../../utils/bluetooth.js');
    const Database = require('../../utils/database.js');
    
    wx.showLoading({
      title: '绑定中...',
    });
    
    // 停止搜索
    this.stopSearch();
    this.setData({
      isSearching: false
    });
    
    // 连接设备并获取服务信息（验证打印机可用）
    BluetoothPrinter.connectDevice(device.deviceId, (info) => {
      // 保存打印机信息到本地存储
      wx.setStorageSync('connectedPrinter', device);
      wx.setStorageSync('printerInfo', info);
      
      // 同时保存到数据库
      Database.savePrinter(device, (res) => {
        console.log('打印机保存到数据库成功', res);
      }, (err) => {
        console.error('打印机保存到数据库失败', err);
      });
      
      // 验证成功后断开连接，释放资源
      BluetoothPrinter.disconnectDevice(device.deviceId);
      console.log('绑定验证完成，已断开蓝牙连接');
      
      // 更新页面数据
      this.setData({
        connectedPrinter: device
      });
      
      wx.hideLoading();
      wx.showToast({
        title: '绑定成功',
        icon: 'success'
      });
    }, (err) => {
      wx.hideLoading();
      wx.showToast({
        title: '绑定失败：' + err,
        icon: 'none'
      });
      console.error('绑定打印机失败：', err);
    });
  },

  /**
   * 解绑打印机
   */
  unbindPrinter: function () {
    const connectedPrinter = this.data.connectedPrinter;
    
    wx.showModal({
      title: '确认解绑',
      content: '确定要解绑当前打印机吗？',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({
            title: '解绑中...',
            mask: true
          });
          
          // 如果有连接，先断开蓝牙连接
          if (connectedPrinter && connectedPrinter.deviceId) {
            wx.closeBLEConnection({
              deviceId: connectedPrinter.deviceId,
              success: () => {
                console.log('蓝牙连接已断开');
              },
              fail: (err) => {
                console.log('断开蓝牙连接失败:', err);
              },
              complete: () => {
                // 清除本地存储
                wx.removeStorageSync('connectedPrinter');
                wx.removeStorageSync('printerInfo');
                
                // 更新页面数据
                this.setData({
                  connectedPrinter: null
                });
                
                wx.hideLoading();
                wx.showToast({
                  title: '解绑成功',
                  icon: 'success'
                });
              }
            });
          } else {
            // 没有连接，直接清除存储
            wx.removeStorageSync('connectedPrinter');
            wx.removeStorageSync('printerInfo');
            
            this.setData({
              connectedPrinter: null
            });
            
            wx.hideLoading();
            wx.showToast({
              title: '解绑成功',
              icon: 'success'
            });
          }
        }
      }
    });
  }
})
