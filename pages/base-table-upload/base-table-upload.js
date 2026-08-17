// pages/base-table-upload/base-table-upload.js
const DataStorage = require('../../utils/storage.js');
const api = require('../../utils/api.js');
const { normalizePnCode } = require('../../utils/pn.js');

Page({
  data: {
    selectedFile: null,
    parseResult: null,
    uploadHistory: [],
    isUploading: false,
    uploadProgress: 0,
    uploadCurrent: 0,
    uploadTotal: 0,
    addCount: 0,
    updateCount: 0,
    failCount: 0,
    uploadFinished: false,
    showFailModal: false,
    failList: []
  },

  onLoad: function (options) {
    this.loadUploadHistory();
  },

  onShow: function () {
    this.loadUploadHistory();
  },

  loadUploadHistory: function () {
    const history = wx.getStorageSync('baseTableUploadHistory') || [];
    this.setData({
      uploadHistory: history
    });
  },

  chooseFile: function () {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['.csv', '.txt'],
      success: (res) => {
        const file = res.tempFiles[0];

        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith('.csv') && !fileName.endsWith('.txt')) {
          wx.showToast({
            title: '请选择 .csv 或 .txt 格式的文件',
            icon: 'none'
          });
          return;
        }

        if (file.size > 10 * 1024 * 1024) {
          wx.showToast({
            title: '文件大小不能超过10MB',
            icon: 'none'
          });
          return;
        }

        this.setData({
          selectedFile: file,
          parseResult: null,
          uploadFinished: false,
          failList: []
        });
      },
      fail: (err) => {
        console.error('选择文件失败:', err);
        wx.showToast({
          title: '选择文件失败',
          icon: 'none'
        });
      }
    });
  },

  removeSelectedFile: function () {
    this.setData({
      selectedFile: null,
      parseResult: null,
      uploadFinished: false,
      failList: []
    });
  },

  formatFileSize: function (size) {
    if (size < 1024) {
      return size + ' B';
    } else if (size < 1024 * 1024) {
      return (size / 1024).toFixed(2) + ' KB';
    } else {
      return (size / (1024 * 1024)).toFixed(2) + ' MB';
    }
  },

  parseAndUpload: function () {
    const file = this.data.selectedFile;
    if (!file) {
      wx.showToast({
        title: '请先选择文件',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({
      title: '正在解析...',
      mask: true
    });

    const filePath = file.path;
    const fileManager = wx.getFileSystemManager();

    try {
      fileManager.readFile({
        filePath: filePath,
        encoding: 'utf8',
        success: (res) => {
          console.log('文件读取成功，开始解析');

          try {
            const parseResult = this.parseGoodsData(res.data);

            this.setData({
              parseResult: parseResult
            });

            wx.hideLoading();
            wx.showToast({
              title: '解析完成，共' + parseResult.totalCount + '条记录',
              icon: 'success'
            });
          } catch (parseError) {
            console.error('解析失败:', parseError);
            wx.hideLoading();
            wx.showToast({
              title: '解析失败: ' + parseError.message,
              icon: 'none',
              duration: 3000
            });
          }
        },
        fail: (err) => {
          console.error('文件读取失败:', err);
          wx.hideLoading();
          wx.showToast({
            title: '文件读取失败',
            icon: 'none'
          });
        }
      });
    } catch (error) {
      console.error('读取文件时发生错误:', error);
      wx.hideLoading();
      wx.showToast({
        title: '读取文件失败: ' + error.message,
        icon: 'none',
        duration: 3000
      });
    }
  },

  parseGoodsData: function (content) {
    const lines = content.split(/\r?\n/).filter(line => line.trim());

    if (lines.length === 0) {
      throw new Error('文件内容为空');
    }

    const headers = this.parseCSVLine(lines[0]);

    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      const row = {};

      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });

      data.push(row);
    }

    const result = this.processGoodsData(data);

    return {
      fileName: 'goods',
      fileType: 'goods',
      totalCount: data.length,
      headers: headers,
      data: result.data,
      errors: result.errors || []
    };
  },

  parseCSVLine: function (line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());

    return result;
  },

  processGoodsData: function (jsonData) {
    const goods = [];
    const errors = [];

    jsonData.forEach((row, index) => {
      try {
        const pnCode = row['PN'] || row['pn'] || row['Pn'] || row['PN码'] || '';
        const snCode = row['SN'] || row['sn'] || row['Sn'] || row['SN码'] || '';
        const mtmCode = row['MTM'] || row['mtm'] || row['Mtm'] || row['MTM码'] || '';
        const name = row['名称'] || row['name'] || row['Name'] || row['商品名称'] || '';
        const category = row['类别'] || row['category'] || row['Category'] || row['分类'] || '';
        const type = row['TYPE'] || row['type'] || row['Type'] || row['类型'] || '';
        const price = parseFloat(row['价格'] || row['price'] || row['Price'] || 0);
        const unitprice = parseFloat(row['Unitprice'] || row['unitprice'] || row['UnitPrice'] || row['单价'] || 0);

        if (!name && !pnCode && !mtmCode) {
          errors.push(`第${index + 2}行: 商品名称、PN码和MTM码不能同时为空`);
          return;
        }

        goods.push({
          pnCode: normalizePnCode(pnCode),
          snCode: snCode,
          mtmCode: mtmCode,
          name: name,
          category: category,
          type: type,
          price: isNaN(price) ? 0 : price,
          unitprice: isNaN(unitprice) ? 0 : unitprice
        });
      } catch (error) {
        errors.push(`第${index + 2}行: ${error.message}`);
      }
    });

    return { data: goods, errors: errors };
  },

  viewTemplate: function () {
    const content = '名称,PN,SN,MTM,类别,TYPE,价格,Unitprice\nThinkPad X1 Carbon,21HM0000CD,,21HM,笔记本,computer,9999,8500\nThinkBook 14,21K00001CD,,21K0,笔记本,computer,4999,4500\nMoto Edge,PN123456,,MTM789,手机,mobile,2999,2800';
    const fileName = '商品数据模板.csv';
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
    const fileManager = wx.getFileSystemManager();

    try {
      fileManager.writeFileSync(filePath, content, 'utf8');

      wx.openDocument({
        filePath: filePath,
        fileType: 'csv',
        showMenu: true,
        success: () => {
          console.log('模板打开成功');
        },
        fail: (err) => {
          console.error('模板打开失败:', err);
          wx.showToast({
            title: '模板打开失败',
            icon: 'none'
          });
        }
      });
    } catch (error) {
      console.error('生成模板失败:', error);
      wx.showToast({
        title: '生成模板失败',
        icon: 'none'
      });
    }
  },

  confirmUpload: function () {
    const parseResult = this.data.parseResult;
    if (!parseResult || !parseResult.data || parseResult.data.length === 0) {
      wx.showToast({
        title: '没有可上传的数据',
        icon: 'none'
      });
      return;
    }

    wx.showModal({
      title: '确认上传',
      content: `确定要将${parseResult.totalCount}条商品数据上传到数据库吗？`,
      confirmText: '确认上传',
      success: (res) => {
        if (res.confirm) {
          this.startBatchUpload(parseResult.data);
        }
      }
    });
  },

  cancelUpload: function () {
    wx.showModal({
      title: '取消上传',
      content: '确定要取消上传吗？已上传的数据不会回滚。',
      confirmText: '确定取消',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            isUploading: false,
            cancelled: true,
            uploadFinished: true
          });
          wx.hideLoading();
          wx.showToast({
            title: '已取消上传',
            icon: 'none'
          });
        }
      }
    });
  },

  showFailDetails: function () {
    this.setData({
      showFailModal: true
    });
  },

  closeFailModal: function () {
    this.setData({
      showFailModal: false
    });
  },

  resetUpload: function () {
    this.setData({
      selectedFile: null,
      parseResult: null,
      isUploading: false,
      uploadProgress: 0,
      uploadCurrent: 0,
      uploadTotal: 0,
      addCount: 0,
      updateCount: 0,
      failCount: 0,
      uploadFinished: false,
      failList: []
    });
  },

  startBatchUpload: function (goodsData) {
    const totalCount = goodsData.length;
    const batchSize = 5;

    this.setData({
      isUploading: true,
      cancelled: false,
      uploadProgress: 0,
      uploadCurrent: 0,
      uploadTotal: totalCount,
      addCount: 0,
      updateCount: 0,
      failCount: 0,
      uploadFinished: false,
      failList: []
    });

    this.updateUploadHistory(this.data.selectedFile.name, { totalCount: totalCount });

    const batches = [];
    for (let i = 0; i < totalCount; i += batchSize) {
      batches.push(goodsData.slice(i, i + batchSize));
    }

    this.processBatches(batches, 0, totalCount);
  },

  processBatches: function (batches, batchIndex, totalCount) {
    if (this.data.cancelled) {
      return;
    }

    if (batchIndex >= batches.length) {
      this.finishUpload();
      return;
    }

    const batch = batches[batchIndex];
    const startIndex = batchIndex * 20;

    this.uploadBatch(batch, startIndex, totalCount, () => {
      this.processBatches(batches, batchIndex + 1, totalCount);
    });
  },

  uploadBatch: function (batch, startIndex, totalCount, callback) {
    let processedInBatch = 0;

    batch.forEach((item, batchOffset) => {
      if (this.data.cancelled) {
        return;
      }

      const index = startIndex + batchOffset;
      if (!item.pnCode) {
        const failItem = {
          name: item.name || '未知商品',
          pnCode: item.pnCode || '',
          reason: '缺少PN码，无法创建商品'
        };
        const failList = this.data.failList;
        failList.push(failItem);
        this.setData({
          failCount: this.data.failCount + 1,
          uploadCurrent: this.data.uploadCurrent + 1,
          uploadProgress: Math.round(((startIndex + batchOffset + 1) / totalCount) * 100),
          failList: failList
        });
        processedInBatch++;
        if (processedInBatch === batch.length) {
          setTimeout(() => callback(), 300);
        }
        return;
      }

      setTimeout(() => {
        api.product.saveLegacyGoods({
          name: item.name || '',
          pnCode: item.pnCode || '',
          snCode: item.snCode || '',
          mtmCode: item.mtmCode || '',
          category: item.category || '',
          price: item.price || item.unitprice || 0,
          remark: item.type || ''
        })
          .then(() => {
            if (this.data.cancelled) return;
            this.setData({
              addCount: this.data.addCount + 1
            });
          })
          .then(() => {
            if (this.data.cancelled) return;

            this.setData({
              uploadCurrent: this.data.uploadCurrent + 1,
              uploadProgress: Math.round(((startIndex + batchOffset + 1) / totalCount) * 100)
            });
            processedInBatch++;
            if (processedInBatch === batch.length) {
              setTimeout(() => callback(), 200);
            }
          })
          .catch(err => {
            if (this.data.cancelled) return;

            console.error('上传商品失败:', item.name, err);
            const failItem = {
              name: item.name || '未知商品',
              pnCode: item.pnCode || '',
              reason: err.errMsg || err.message || '数据库操作失败'
            };
            const failList = this.data.failList;
            failList.push(failItem);
            this.setData({
              failCount: this.data.failCount + 1,
              uploadCurrent: this.data.uploadCurrent + 1,
              uploadProgress: Math.round(((startIndex + batchOffset + 1) / totalCount) * 100),
              failList: failList
            });
            processedInBatch++;
            if (processedInBatch === batch.length) {
              setTimeout(() => callback(), 200);
            }
          });
      }, batchOffset * 150);
    });
  },

  finishUpload: function () {
    const { addCount, updateCount, failCount, uploadTotal } = this.data;

    this.setData({
      isUploading: false,
      uploadFinished: true
    });

    if (failCount > 0) {
      wx.showModal({
        title: '上传完成',
        content: `总计: ${uploadTotal}条\n新增: ${addCount}条\n更新: ${updateCount}条\n失败: ${failCount}条\n\n点击"失败"可查看详情`,
        showCancel: false
      });
    } else {
      wx.showModal({
        title: '上传完成',
        content: `总计: ${uploadTotal}条\n新增: ${addCount}条\n更新: ${updateCount}条`,
        showCancel: false
      });
    }
  },

  updateUploadHistory: function (fileName, parseResult) {
    const history = wx.getStorageSync('baseTableUploadHistory') || [];

    const historyItem = {
      fileName: fileName,
      totalCount: parseResult.totalCount,
      uploadTime: new Date().toISOString(),
      uploadTimeFormat: new Date().toLocaleString('zh-CN')
    };

    history.unshift(historyItem);

    if (history.length > 20) {
      history.pop();
    }

    wx.setStorageSync('baseTableUploadHistory', history);

    this.setData({
      uploadHistory: history
    });
  },

  clearUploadHistory: function () {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有上传历史记录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('baseTableUploadHistory');
          this.setData({
            uploadHistory: []
          });
          wx.showToast({
            title: '已清空历史记录',
            icon: 'success'
          });
        }
      }
    });
  }
});
