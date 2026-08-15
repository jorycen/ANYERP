// pages/ocr-scan/ocr-scan.js
Page({
  /**
   * 页面的初始数据
   */
  data: {
    showResult: false,
    scanResult: {
      pnCode: '',
      mtmCode: '',
      snCode: ''
    },
    goodsIndex: 0,
    codeType: '', // 需要扫描的编码类型：pnCode, snCode
    tempImagePath: '', // 临时图片路径
    showImageSelect: false, // 是否显示图片选择选项
    ocrRegions: [], // OCR识别出的区域
    selectedRegion: null // 选中的区域
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    // 获取传递的商品索引和编码类型
    if (options.index) {
      this.setData({
        goodsIndex: parseInt(options.index)
      });
    }
    
    // 获取需要扫描的编码类型
    if (options.codeType) {
      this.setData({
        codeType: options.codeType
      });
    }
    
    // 请求相机权限
    this.requestCameraPermission();
  },

  /**
   * 请求相机权限
   */
  requestCameraPermission: function () {
    wx.getSetting({
      success: (res) => {
        if (!res.authSetting['scope.camera']) {
          wx.authorize({
            scope: 'scope.camera',
            success: () => {
              console.log('相机权限授权成功');
            },
            fail: () => {
              wx.showToast({
                title: '请授权相机权限',
                icon: 'none',
                duration: 2000
              });
              // 跳转到设置页面
              setTimeout(() => {
                wx.openSetting();
              }, 2000);
            }
          });
        }
      }
    });
  },

  /**
   * 拍照识别
   */
  takePhoto: function () {
    const ctx = wx.createCameraContext();
    
    ctx.takePhoto({
      quality: 'high',
      success: (res) => {
        // 调用PaddleOCR识别
        this.callPaddleOCR(res.tempImagePath);
      },
      fail: (err) => {
        wx.showToast({
          title: '拍照失败',
          icon: 'none'
        });
        console.error('拍照失败:', err);
      }
    });
  },

  /**
   * 从相册选择图片
   */
  chooseImage: function () {
    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.callPaddleOCR(tempFilePath);
      },
      fail: (err) => {
        wx.showToast({
          title: '选择图片失败',
          icon: 'none'
        });
        console.error('选择图片失败:', err);
      }
    });
  },

  /**
   * 显示图片选择选项
   */
  showImageOptions: function () {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        if (res.tapIndex === 0) {
          // 拍照
          this.takePhoto();
        } else if (res.tapIndex === 1) {
          // 从相册选择
          this.chooseImage();
        }
      },
      fail: (err) => {
        console.error('显示选择菜单失败:', err);
      }
    });
  },

  /**
   * 调用PaddleOCR云函数进行识别
   */
  callPaddleOCR: function (imagePath) {
    // 检查云开发环境是否可用
    const app = getApp();
    if (!app.isCloudAvailable()) {
      // 云开发不可用，直接提示并提供手动输入选项
      wx.showActionSheet({
        itemList: ['云开发不可用，是否手动输入编码？', '取消'],
        success: (res) => {
          if (res.tapIndex === 0) {
            this.showManualInput();
          }
        }
      });
      return;
    }
    
    wx.showLoading({
      title: '识别中...',
    });
    
    // 保存临时图片路径
    this.setData({
      tempImagePath: imagePath
    });
    
    // 1. 先上传图片到云存储
    wx.cloud.uploadFile({
      cloudPath: 'ocr-images/' + Date.now() + '.jpg', // 云存储路径
      filePath: imagePath, // 本地临时文件路径
      success: (uploadRes) => {
        // 2. 上传成功后，将fileID传给云函数
        wx.cloud.callFunction({
          name: 'paddleOCR', // 云函数名称
          data: {
            fileID: uploadRes.fileID // 传递云存储的fileID
          },
          success: (res) => {
            wx.hideLoading();
            
            if (res.result && res.result.success) {
              // 解析OCR识别结果
              const ocrResult = this.parseOCRResult(res.result.data);
              
              // 保存OCR识别区域
              this.setData({
                tempImagePath: imagePath,
                showImageSelect: true,
                ocrRegions: res.result.data || [],
                scanResult: ocrResult
              });
              
              wx.showToast({
                title: '识别成功，点击区域选择编码',
                icon: 'success'
              });
            } else {
              wx.showToast({
                title: '识别失败: ' + (res.result.message || '未知错误'),
                icon: 'none'
              });
            }
          },
          fail: (err) => {
            wx.hideLoading();
            // 云函数调用失败，提示用户
            wx.showToast({
              title: '识别失败，请重试',
              icon: 'none'
            });
            console.error('PaddleOCR云函数调用失败:', err);
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        // 图片上传失败，提示用户详细错误信息
        let errorMsg = '图片上传失败，请重试';
        let showManualOption = true;
        if (err) {
          console.error('图片上传失败详细信息:', JSON.stringify(err));
          if (err.errMsg) {
            if (err.errMsg.includes('permission')) {
              errorMsg = '云开发权限不足，请开通云开发服务';
            } else if (err.errMsg.includes('file not found')) {
              errorMsg = '找不到图片文件，请重新拍照';
              showManualOption = false;
            } else if (err.errMsg.includes('uploadFile:fail')) {
              errorMsg = '网络异常，上传失败，请检查网络';
            } else if (err.errMsg.includes('function not found')) {
              errorMsg = '云函数不存在，请先部署云函数';
            } else if (err.errMsg.includes('env not found')) {
              errorMsg = '云开发环境不存在，请检查环境ID是否正确';
            } else {
              errorMsg = '上传失败: ' + err.errMsg;
            }
          } else {
            errorMsg = '上传失败: ' + JSON.stringify(err);
          }
        }
        
        // 显示错误提示
        wx.showToast({
          title: errorMsg,
          icon: 'none',
          duration: 5000
        });
        
        // 如果是云开发权限问题，显示手动输入选项
        if (showManualOption) {
          setTimeout(() => {
            wx.showActionSheet({
              itemList: ['手动输入编码', '取消'],
              success: (res) => {
                if (res.tapIndex === 0) {
                  this.showManualInput();
                }
              }
            });
          }, 3000);
        }
        
        console.error('图片上传失败:', err);
      }
    });
  },

  /**
   * 解析OCR识别结果
   */
  parseOCRResult: function (ocrData) {
    // 初始化结果
    let pnCode = '';
    let mtmCode = '';
    let snCode = '';
    
    // 增强的规则匹配，支持更多编码格式
    if (ocrData && Array.isArray(ocrData)) {
      ocrData.forEach(item => {
        const text = item.text || '';
        const cleanText = text.trim();
        
        // 匹配PN码：字母开头，后跟6-15位字母或数字，支持常见前缀如PN:、Part No:等
        if (!pnCode) {
          const pnMatch = cleanText.match(/^(?:PN:|Part No:|Part Number:)?\s*([A-Za-z][A-Za-z0-9]{6,15})$/i);
          if (pnMatch) {
            pnCode = pnMatch[1].toUpperCase();
          }
        }
        
        // 匹配MTM码：包含字母、数字和连字符，10-20位
        if (!mtmCode) {
          const mtmMatch = cleanText.match(/^(?:MTM:|Model:)?\s*([A-Za-z0-9-]{10,20})$/i);
          if (mtmMatch) {
            mtmCode = mtmMatch[1].toUpperCase();
          }
        }
        
        // 匹配SN码：15-25位字母或数字，支持常见前缀如SN:、Serial No:等
        if (!snCode) {
          const snMatch = cleanText.match(/^(?:SN:|Serial:|Serial No:|Serial Number:)?\s*([A-Za-z0-9]{15,25})$/i);
          if (snMatch) {
            snCode = snMatch[1].toUpperCase();
          }
        }
      });
    }
    
    // 只返回真实识别到的结果，不生成随机编码
    return {
      pnCode: pnCode,
      mtmCode: mtmCode,
      snCode: snCode
    };
  },

  /**
   * 点击OCR识别区域选择编码
   */
  onRegionTap: function (e) {
    const index = e.currentTarget.dataset.index;
    const region = this.data.ocrRegions[index];
    const text = region.text;
    
    this.setData({
      selectedRegion: region
    });
    
    // 定义不同类型的正则表达式
    const codePatterns = {
      pnCode: /^[A-Za-z][A-Za-z0-9]{7,11}$/, // PN码：字母开头，后跟7-11位字母或数字
      mtmCode: /^[A-Za-z0-9-]{10,15}$/, // MTM码：包含字母、数字和连字符，10-15位
      snCode: /^[A-Za-z0-9]{15,20}$/ // SN码：15-20位字母或数字
    };
    
    // 根据需要扫描的编码类型或自动识别类型
    let targetCodeType = this.data.codeType;
    let targetText = text;
    
    if (!targetCodeType) {
      // 自动识别编码类型
      for (const [type, pattern] of Object.entries(codePatterns)) {
        if (pattern.test(text)) {
          targetCodeType = type;
          break;
        }
      }
    } else {
      // 强制使用指定的编码类型
      if (codePatterns[targetCodeType].test(text)) {
        // 编码格式匹配
        console.log(`匹配到${targetCodeType}: ${text}`);
      } else {
        // 编码格式不匹配，仍使用该文本
        console.log(`未匹配到${targetCodeType}格式，但仍使用该文本: ${text}`);
      }
    }
    
    // 更新扫描结果
    const scanResult = this.data.scanResult;
    scanResult[targetCodeType] = targetText;
    this.setData({
      scanResult: scanResult
    });
    
    // 直接返回结果，不需要确认
    this.confirmResult();
  },

  /**
   * 确认使用识别结果
   */
  confirmResult: function () {
    // 将识别结果传递回订单创建页面
    const pages = getCurrentPages();
    const prevPage = pages[pages.length - 2]; // 获取上一个页面
    
    // 调用上一个页面的方法更新商品信息
    prevPage.updateGoodsFromOCR({
      index: this.data.goodsIndex,
      pnCode: this.data.scanResult.pnCode,
      mtmCode: this.data.scanResult.mtmCode,
      snCode: this.data.scanResult.snCode
    });
    
    // 返回上一个页面
    wx.navigateBack();
  },

  /**
   * 重新识别
   */
  retakePhoto: function () {
    this.setData({
      showResult: false,
      showImageSelect: false,
      ocrRegions: [],
      selectedRegion: null,
      tempImagePath: '',
      showManualInput: false
    });
    
    // 显示图片选择选项
    this.showImageOptions();
  },

  /**
   * 显示手动输入选项
   */
  showManualInput: function () {
    this.setData({
      showManualInput: true
    });
  },

  /**
   * 手动输入编码
   */
  onManualInput: function (e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    
    const scanResult = this.data.scanResult;
    scanResult[field] = value;
    this.setData({
      scanResult: scanResult
    });
  },

  /**
   * 确认手动输入结果
   */
  confirmManualInput: function () {
    // 直接返回结果
    this.confirmResult();
  },

  /**
   * 返回上一页
   */
  navigateBack: function () {
    wx.navigateBack();
  },

  /**
   * 相机错误处理
   */
  cameraError: function (e) {
    console.error('相机错误:', e.detail);
    wx.showToast({
      title: '相机初始化失败',
      icon: 'none'
    });
    
    // 显示图片选择选项
    this.showImageOptions();
  }
})
