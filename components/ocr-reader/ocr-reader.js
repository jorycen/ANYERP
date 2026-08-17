// components/ocr-reader/ocr-reader.js
Component({
  /**
   * 组件的属性列表
   */
  properties: {
    index: {
      type: Number,
      value: 0
    }
  },

  /**
   * 组件的初始数据
   */
  data: {
    showResult: false,
    tempImagePath: '',
    ocrResult: {
      pnCode: '',
      mtmCode: '',
      snCode: ''
    },
    cameraContext: null,
    ocrRegions: [], // OCR识别出的区域
    showImageSelect: false // 是否显示图片选择选项
  },

  /**
   * 组件生命周期函数，在组件实例进入页面节点树时执行
   */
  attached: function () {
    // 初始化摄像头上下文
    this.setData({
      cameraContext: wx.createCameraContext()
    });
  },

  /**
   * 组件的方法列表
   */
  methods: {
    /**
     * 拍照
     */
    takePhoto: function () {
      wx.showLoading({
        title: '正在拍照...',
      });
      
      const cameraContext = this.data.cameraContext;
      cameraContext.takePhoto({
        quality: 'high',
        success: (res) => {
          this.setData({
            tempImagePath: res.tempImagePath
          });
          
          // 调用真实的OCR识别
          this.callPaddleOCR(res.tempImagePath);
        },
        fail: (err) => {
          wx.hideLoading();
          wx.showToast({
            title: '拍照失败，请重试',
            icon: 'none'
          });
          console.error('拍照失败:', err);
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
        // 云开发不可用，直接提示并触发手动输入事件
        wx.showActionSheet({
          itemList: ['云开发不可用，是否手动输入编码？', '取消'],
          success: (res) => {
            if (res.tapIndex === 0) {
              // 触发手动输入事件，让父组件处理
              this.triggerEvent('manualinput');
            }
          }
        });
        return;
      }
      
      wx.showLoading({
        title: '识别中...',
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
                
                this.setData({
                  ocrResult: ocrResult,
                  showResult: true,
                  ocrRegions: res.result.data || []
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
                    // 触发手动输入事件，让父组件处理
                    this.triggerEvent('manualinput');
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
     * 重新拍摄
     */
    retakePhoto: function () {
      this.setData({
        showResult: false,
        tempImagePath: '',
        ocrResult: {
          pnCode: '',
          mtmCode: '',
          snCode: ''
        },
        ocrRegions: [],
        showImageSelect: false
      });
    },

    /**
     * 确认使用识别结果
     */
    confirmResult: function () {
      const index = this.properties.index;
      const ocrResult = this.data.ocrResult;
      
      // 触发自定义事件，将识别结果传递给父页面
      this.triggerEvent('confirm', {
        index: index,
        result: ocrResult
      });
      
      // 返回上一页
      wx.navigateBack();
    },

    /**
     * 关闭识别页面
     */
    close: function () {
      wx.navigateBack();
    },

    /**
     * 摄像头错误处理
     */
    onCameraError: function (e) {
      console.error('摄像头错误:', e.detail);
      wx.showToast({
        title: '摄像头无法使用',
        icon: 'none'
      });
    },

    /**
     * 识别结果输入处理
     */
    onResultInput: function (e) {
      const field = e.currentTarget.dataset.field;
      const value = e.detail.value;
      
      const ocrResult = this.data.ocrResult;
      ocrResult[field] = value;
      
      this.setData({
        ocrResult: ocrResult
      });
    }
  }
})
