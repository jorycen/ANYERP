// pages/photo-download/photo-download.js

Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 日期范围选择
    startDate: '',
    endDate: '',
    // 图片列表
    photoList: [],
    // 选中的图片
    selectedPhotos: [],
    // 是否全选
    isAllSelected: false,
    // 加载状态
    isLoading: false,
    // 下载进度
    downloadProgress: 0,
    isDownloading: false,
    // 当前下载索引
    currentDownloadIndex: 0,
    // 下载成功数量
    downloadSuccessCount: 0,
    // 下载失败数量
    downloadFailCount: 0,
    // 预览图片列表
    previewList: [],
    // 图片类型筛选
    photoTypeFilter: 'all',
    photoTypeLabel: '全部类型',
    photoTypeIndex: 0,
    photoTypeOptions: [
      { value: 'all', label: '全部类型' },
      { value: 'subsidy', label: '国补照片' },
      { value: 'product', label: '商品照片' },
      { value: 'education', label: '教育补贴凭证' },
      { value: 'personal', label: '个人资料' },
      { value: 'supplement', label: '补录凭证' }
    ],
    // 云存储文件夹路径
    cloudFolders: [
      'subsidy_photos/',
      'orders/',
      'personal-info-photos/',
      'supplement-proofs/'
    ],
    // 链接弹窗
    showLinksModal: false,
    linksText: '',
    linksCount: 0
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    // 设置默认日期为前一天
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = this.formatDate(yesterday);

    this.setData({
      startDate: yesterdayStr,
      endDate: yesterdayStr
    });
  },

  /**
   * 格式化日期
   */
  formatDate: function (date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  /**
   * 开始日期变化
   */
  onStartDateChange: function (e) {
    this.setData({
      startDate: e.detail.value
    });
  },

  /**
   * 结束日期变化
   */
  onEndDateChange: function (e) {
    this.setData({
      endDate: e.detail.value
    });
  },

  /**
   * 获取当前选中的图片类型标签
   */
  getSelectedPhotoTypeLabel: function () {
    const selectedOption = this.data.photoTypeOptions.find(
      option => option.value === this.data.photoTypeFilter
    );
    return selectedOption ? selectedOption.label : '全部类型';
  },

  /**
   * 图片类型筛选变化
   */
  onPhotoTypeChange: function (e) {
    const index = parseInt(e.detail.value);
    const selectedOption = this.data.photoTypeOptions[index];
    this.setData({
      photoTypeFilter: selectedOption.value,
      photoTypeLabel: selectedOption.label,
      photoTypeIndex: index
    });
  },

  /**
   * 从文件名解析日期（支持多种格式）
   * 格式1: YYYYMMDDHHmmSS_姓名_类别.jpg (14位时间戳)
   * 格式2: subsidy_YYYYMMDDHHmmSS_姓名.jpg (带前缀)
   * 格式3: 其他包含8位日期的格式 (YYYYMMDD)
   */
  parseDateFromFileName: function (fileName) {
    const name = fileName.split('/').pop();

    let match = name.match(/^(\d{14})/);
    if (!match) {
      match = name.match(/_(\d{14})_/);
    }
    if (!match) {
      match = name.match(/(\d{8})/);
    }

    if (match) {
      const digits = match[1];
      const year = digits.substring(0, 4);
      const month = digits.substring(4, 6);
      const day = digits.substring(6, 8);
      const hour = digits.length >= 10 ? digits.substring(8, 10) : '00';
      const minute = digits.length >= 12 ? digits.substring(10, 12) : '00';
      const second = digits.length >= 14 ? digits.substring(12, 14) : '00';

      return {
        dateStr: `${year}-${month}-${day}`,
        timeStr: `${hour}:${minute}:${second}`,
        timestamp: new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime(),
        year, month, day, hour, minute, second
      };
    }
    return null;
  },

  /**
   * 从文件名解析信息
   */
  parseFileInfo: function (fileName) {
    const name = fileName.split('/').pop();
    const parts = name.replace(/\.[^/.]+$/, '').split('_');
    
    const typeInfo = this.getPhotoType(fileName);
    const dateInfo = this.parseDateFromFileName(fileName);
    
    return {
      fileName: name,
      dateInfo: dateInfo,
      customerName: parts[1] || '未知客户',
      photoType: parts[2] || '未知类型',
      // 根据文件夹判断类型
      type: typeInfo.type,
      typeLabel: typeInfo.label
    };
  },

  /**
   * 根据文件路径判断图片类型
   */
  getPhotoType: function (filePath) {
    if (filePath.includes('subsidy_photos')) return { type: 'subsidy', label: '国补' };
    if (filePath.includes('personal-info-photos')) {
      const fileName = filePath.split('/').pop();
      if (fileName.includes('商品图片')) {
        return { type: 'product', label: '商品' };
      }
      return { type: 'personal', label: '个人资料' };
    }
    if (filePath.includes('supplement-proofs')) return { type: 'supplement', label: '补录凭证' };
    if (filePath.includes('orders')) {
      if (filePath.includes('edu_subsidy')) return { type: 'education', label: '教育补贴' };
      if (filePath.includes('subsidy_')) return { type: 'subsidy', label: '国补' };
      if (filePath.includes('product_')) return { type: 'product', label: '商品' };
      return { type: 'product', label: '商品' };
    }
    return { type: 'other', label: '其他' };
  },

  /**
   * 查询云存储中的图片
   */
  queryPhotos: async function () {
    const { startDate, endDate, photoTypeFilter } = this.data;
    
    this.setData({ isLoading: true });
    wx.showLoading({ title: '查询中...' });
    
    try {
      const allPhotos = [];
      
      // 遍历所有文件夹查询
      for (const folder of this.data.cloudFolders) {
        const photos = await this.listCloudFiles(folder);
        allPhotos.push(...photos);
      }
      
      console.log('云存储中共有图片:', allPhotos.length);
      
      // 转换时间范围为时间戳
      const startTime = new Date(startDate + 'T00:00:00').getTime();
      const endTime = new Date(endDate + 'T23:59:59').getTime();
      
      console.log('筛选时间范围:', startDate, '到', endDate);
      console.log('时间戳:', startTime, '到', endTime);
      
      // 筛选图片
      const filteredPhotos = allPhotos.filter(photo => {
        const info = this.parseFileInfo(photo.fileID);

        // 类型筛选
        let typeMatch = true;
        if (photoTypeFilter !== 'all') {
          typeMatch = info.type === photoTypeFilter;
        }

        // 日期筛选：如果无法从文件名解析日期，则保留该文件（避免遗漏）
        if (!info.dateInfo) {
          console.log('无法解析日期，保留文件:', photo.fileID);
          return typeMatch;
        }

        // 日期范围筛选
        const inDateRange = info.dateInfo.timestamp >= startTime && info.dateInfo.timestamp <= endTime;
        const shouldInclude = inDateRange && typeMatch;

        if (shouldInclude) {
          photo.parsedInfo = info;
          photo.dateInfo = info.dateInfo;
        }

        return shouldInclude;
      });
      
      // 按日期倒序排列
      filteredPhotos.sort((a, b) => b.dateInfo.timestamp - a.dateInfo.timestamp);
      
      console.log('筛选后图片数:', filteredPhotos.length);
      
      this.setData({
        photoList: filteredPhotos,
        selectedPhotos: [],
        isAllSelected: false,
        isLoading: false,
        previewList: filteredPhotos.map(p => p.tempFileURL || p.fileID)
      });
      
      wx.showToast({
        title: `找到 ${filteredPhotos.length} 张图片`,
        icon: 'none'
      });
      
    } catch (err) {
      console.error('查询失败:', err);
      wx.hideLoading();
      this.setData({ isLoading: false });
      wx.showToast({
        title: '查询失败：' + err.message,
        icon: 'none'
      });
    }
  },

  /**
   * 列出云存储文件夹中的文件
   */
  listCloudFiles: function (folderPath) {
    return new Promise((resolve, reject) => {
      console.log('调用云函数列出文件夹:', folderPath);

      // 使用云函数列出文件，传递日期范围参数
      wx.cloud.callFunction({
        name: 'listCloudFiles',
        data: {
          folder: folderPath,
          startDate: this.data.startDate,
          endDate: this.data.endDate
        },
        success: (res) => {
          console.log('云函数返回:', folderPath, res.result);
          if (res.result && res.result.files) {
            resolve(res.result.files);
          } else {
            console.warn('云函数返回空数据:', folderPath, res);
            resolve([]);
          }
        },
        fail: (err) => {
          console.error('列出文件失败:', folderPath, err);
          resolve([]); // 失败返回空数组，不影响其他文件夹
        }
      });
    });
  },

  /**
   * 选择/取消选择图片
   */
  onPhotoSelect: function (e) {
    const index = e.currentTarget.dataset.index;
    const photoList = this.data.photoList;
    
    photoList[index].selected = !photoList[index].selected;
    
    const selectedPhotos = photoList.filter(p => p.selected);
    const isAllSelected = photoList.length > 0 && selectedPhotos.length === photoList.length;
    
    this.setData({
      photoList: photoList,
      selectedPhotos: selectedPhotos,
      isAllSelected: isAllSelected
    });
  },

  /**
   * 全选/取消全选
   */
  onSelectAll: function () {
    const isAllSelected = !this.data.isAllSelected;
    const photoList = this.data.photoList.map(photo => ({
      ...photo,
      selected: isAllSelected
    }));
    
    this.setData({
      photoList: photoList,
      selectedPhotos: isAllSelected ? photoList : [],
      isAllSelected: isAllSelected
    });
  },

  /**
   * 预览图片
   */
  onPreviewPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const urls = this.data.previewList;
    
    wx.previewImage({
      current: urls[index],
      urls: urls
    });
  },

  /**
   * 下载选中的图片
   */
  onDownloadSelected: async function () {
    const selectedPhotos = this.data.selectedPhotos;
    
    if (selectedPhotos.length === 0) {
      wx.showToast({
        title: '请先选择要下载的图片',
        icon: 'none'
      });
      return;
    }
    
    this.setData({
      isDownloading: true,
      downloadProgress: 0,
      currentDownloadIndex: 0,
      downloadSuccessCount: 0,
      downloadFailCount: 0
    });
    
    // 逐个下载图片
    for (let i = 0; i < selectedPhotos.length; i++) {
      this.setData({ currentDownloadIndex: i + 1 });
      
      const photo = selectedPhotos[i];
      const success = await this.downloadSinglePhoto(photo);
      
      if (success) {
        this.setData({
          downloadSuccessCount: this.data.downloadSuccessCount + 1
        });
      } else {
        this.setData({
          downloadFailCount: this.data.downloadFailCount + 1
        });
      }
      
      // 更新进度
      const progress = Math.round(((i + 1) / selectedPhotos.length) * 100);
      this.setData({ downloadProgress: progress });
    }
    
    this.setData({ isDownloading: false });
    
    // 显示结果
    wx.showModal({
      title: '下载完成',
      content: `成功：${this.data.downloadSuccessCount} 张\n失败：${this.data.downloadFailCount} 张`,
      showCancel: false
    });
  },

  /**
   * 下载单张图片
   */
  downloadSinglePhoto: function (photo) {
    return new Promise((resolve) => {
      // 获取临时链接
      wx.cloud.getTempFileURL({
        fileList: [photo.fileID],
        success: (res) => {
          if (res.fileList && res.fileList[0] && res.fileList[0].tempFileURL) {
            const fileName = photo.parsedInfo ? photo.parsedInfo.fileName : photo.fileID.split('/').pop();
            this.saveImageToAlbum(res.fileList[0].tempFileURL, fileName, resolve);
          } else {
            resolve(false);
          }
        },
        fail: () => {
          resolve(false);
        }
      });
    });
  },

  /**
   * 保存图片到相册
   */
  saveImageToAlbum: function (url, fileName, callback) {
    wx.downloadFile({
      url: url,
      success: (res) => {
        if (res.statusCode === 200) {
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => {
              console.log(`保存成功: ${fileName}`);
              callback(true);
            },
            fail: (err) => {
              console.error(`保存失败: ${fileName}`, err);
              // 处理权限相关的错误
              if (err.errMsg && err.errMsg.includes('auth deny')) {
                wx.showModal({
                  title: '提示',
                  content: '需要授权保存图片到相册，请前往设置开启权限',
                  confirmText: '去设置',
                  success: (res) => {
                    if (res.confirm) {
                      wx.openSetting();
                    }
                  }
                });
              }
              callback(false);
            }
          });
        } else {
          callback(false);
        }
      },
      fail: (err) => {
        console.error(`下载失败: ${fileName}`, err);
        callback(false);
      }
    });
  },

  /**
   * 下载全部图片
   */
  onDownloadAll: function () {
    const photoList = this.data.photoList;

    if (photoList.length === 0) {
      wx.showToast({
        title: '没有可下载的图片',
        icon: 'none'
      });
      return;
    }

    // 先全选
    const allSelected = photoList.map(photo => ({
      ...photo,
      selected: true
    }));

    this.setData({
      photoList: allSelected,
      selectedPhotos: allSelected,
      isAllSelected: true
    }, () => {
      // 然后下载
      this.onDownloadSelected();
    });
  },

  /**
   * 获取选中图片的链接并显示在文本框中
   */
  onCopyLinks: function () {
    const selectedPhotos = this.data.selectedPhotos;

    console.log('选中的图片数:', selectedPhotos.length);
    console.log('选中的图片:', selectedPhotos);

    if (selectedPhotos.length === 0) {
      wx.showToast({
        title: '请先选择图片',
        icon: 'none'
      });
      return;
    }

    // 过滤掉没有tempFileURL的图片
    const validPhotos = selectedPhotos.filter(photo => 
      photo.tempFileURL && photo.tempFileURL.trim() !== ''
    );

    console.log('有临时链接的图片数:', validPhotos.length);

    if (validPhotos.length === 0) {
      // 如果没有临时链接，尝试使用fileID重新获取
      const fileIDs = selectedPhotos
        .map(photo => photo.fileID)
        .filter(fileID => fileID && fileID.trim() !== '');

      console.log('尝试重新获取链接，fileIDs:', fileIDs);

      if (fileIDs.length === 0) {
        wx.showToast({
          title: '所选图片没有有效的文件ID',
          icon: 'none'
        });
        return;
      }

      wx.showLoading({
        title: '获取链接...',
        mask: true
      });

      // 获取临时链接
      wx.cloud.getTempFileURL({
        fileList: fileIDs,
        success: (res) => {
          wx.hideLoading();

          console.log('获取临时链接结果:', res);

          if (res.fileList && res.fileList.length > 0) {
            // 过滤掉获取失败的链接
            const validFiles = res.fileList.filter(file => file.tempFileURL && file.status === 0);

            if (validFiles.length === 0) {
              wx.showToast({
                title: '获取链接失败',
                icon: 'none'
              });
              return;
            }

            // 构建链接文本（只包含链接，每行一个）
            let linksText = '';
            validFiles.forEach((file, index) => {
              linksText += `${file.tempFileURL}\n`;
            });

            // 显示链接文本框
            this.setData({
              showLinksModal: true,
              linksText: linksText,
              linksCount: validFiles.length
            });
          } else {
            wx.showToast({
              title: '获取链接失败',
              icon: 'none'
            });
          }
        },
        fail: (err) => {
          wx.hideLoading();
          console.error('获取临时链接失败:', err);
          wx.showToast({
            title: '获取链接失败',
            icon: 'none'
          });
        }
      });
      return;
    }

    // 直接使用已有的临时链接
    let linksText = '';
    validPhotos.forEach((photo, index) => {
      linksText += `${photo.tempFileURL}\n`;
    });

    // 显示链接文本框
    this.setData({
      showLinksModal: true,
      linksText: linksText,
      linksCount: validPhotos.length
    });
  },

  /**
   * 关闭链接弹窗
   */
  closeLinksModal: function () {
    this.setData({
      showLinksModal: false,
      linksText: '',
      linksCount: 0
    });
  },

  /**
   * 全选链接文本
   */
  selectAllLinks: function () {
    const query = wx.createSelectorQuery();
    query.select('#linksTextarea').fields({
      context: true
    }, (res) => {
      if (res && res.context) {
        // 使用 textarea 的上下文来全选文本
        res.context.selectAll();
      }
    }).exec();
  }
});
