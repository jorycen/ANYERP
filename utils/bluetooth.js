// utils/bluetooth.js

/**
 * 蓝牙打印工具类
 */

// 强制引入你创建的完整 GBK 编码库
const GBK = require('./gbk.js');

// 缓存转换后的 Logo 位图数据
let cachedLogoBuffer = null;
let isLogoLoading = false;
let logoLoadCallbacks = [];

const BluetoothPrinter = {
  /**
   * 连接蓝牙设备
   */
  connectDevice: function (deviceId, success, fail) {
    wx.createBLEConnection({
      deviceId: deviceId,
      success: (res) => {
        console.log('连接蓝牙设备成功', res);
        this.findWritableCharacteristic(deviceId, success, fail);
      },
      fail: (err) => {
        console.error('连接蓝牙设备失败', err);
        const errorMessage = err.message || JSON.stringify(err);
        if (errorMessage.includes('already connect')) {
          console.log('设备已连接，继续获取服务信息');
          this.findWritableCharacteristic(deviceId, success, fail);
        } else {
          fail && fail(errorMessage);
        }
      }
    });
  },
  
  /**
   * 查找可写特征值
   */
  findWritableCharacteristic: function (deviceId, success, fail) {
    wx.getBLEDeviceServices({
      deviceId: deviceId,
      success: (servicesRes) => {
        if (!servicesRes.services || servicesRes.services.length === 0) {
          fail && fail('服务列表为空');
          return;
        }
        this.searchCharacteristics(deviceId, servicesRes.services, 0, success, fail);
      },
      fail: (err) => {
        fail && fail(err.message || JSON.stringify(err));
      }
    });
  },
  
  /**
   * 递归搜索特征值
   */
  searchCharacteristics: function (deviceId, services, index, success, fail) {
    if (index >= services.length) {
      fail && fail('未找到可写特征值');
      return;
    }
    const service = services[index];
    wx.getBLEDeviceCharacteristics({
      deviceId: deviceId,
      serviceId: service.uuid,
      success: (charsRes) => {
        if (charsRes.characteristics) {
          for (let j = 0; j < charsRes.characteristics.length; j++) {
            const characteristic = charsRes.characteristics[j];
            if (characteristic.properties.write || characteristic.properties.writeNoResponse) {
              const printerInfo = {
                deviceId: deviceId,
                serviceId: service.uuid,
                characteristicId: characteristic.uuid
              };
              wx.setStorageSync('printerInfo', printerInfo);
              success && success(printerInfo);
              return;
            }
          }
        }
        this.searchCharacteristics(deviceId, services, index + 1, success, fail);
      },
      fail: (err) => {
        this.searchCharacteristics(deviceId, services, index + 1, success, fail);
      }
    });
  },

  disconnectDevice: function (deviceId) {
    wx.closeBLEConnection({
      deviceId: deviceId,
      success: () => console.log('断开蓝牙连接成功'),
      fail: (err) => console.error('断开蓝牙连接失败', err)
    });
  },

  /**
   * ==========================================
   * 核心修复：防截断发送逻辑
   * ==========================================
   */
  sendData: function (deviceId, serviceId, characteristicId, buffer, success, fail) {
    const MTU_SIZE = 20; // DL 5801PW 蓝牙包最大限制
    const totalLength = buffer.byteLength;
    const view = new Uint8Array(buffer); // 创建视图，用于检查中文字节
    
    // 如果数据量极小，直接发送
    if (totalLength <= MTU_SIZE) {
      this.sendDataChunk(deviceId, serviceId, characteristicId, buffer, success, fail);
      return;
    }
    
    let offset = 0;
    
    const sendNextChunk = () => {
      if (offset >= totalLength) {
        setTimeout(() => { success && success({}); }, 1000);
        return;
      }
      
      let chunkSize = Math.min(MTU_SIZE, totalLength - offset);
      
      // 【防截断算法】：判断如果当前包的最后一个字节是半个汉字，就退回一个字节
      if (offset + chunkSize < totalLength) {
        let i = 0;
        while (i < chunkSize) {
          if (view[offset + i] > 127) { 
            // 遇到高位字节（中文字符的一部分）
            if (i + 1 === chunkSize) {
              // 此时刚好是当前数据包的最后一个字节，意味着汉字的另一半在下一个包！
              chunkSize--; // 砍掉这个字节，把它留到下一个包的开头
              break;
            }
            i += 2; // 完整的汉字占2个字节，跳过
          } else {
            i += 1; // 英文/数字占1个字节，跳过
          }
        }
      }
      
      const chunk = buffer.slice(offset, offset + chunkSize);
      
      this.sendDataChunk(deviceId, serviceId, characteristicId, chunk, () => {
        offset += chunkSize;
        // 延迟50ms防丢包
        setTimeout(() => { sendNextChunk(); }, 50);
      }, (err) => {
        fail && fail(err);
      });
    };
    
    sendNextChunk();
  },

  /**
   * 发送单批数据
   */
  sendDataChunk: function (deviceId, serviceId, characteristicId, buffer, success, fail) {
    wx.writeBLECharacteristicValue({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      value: buffer,
      success: (res) => {
        success && success(res);
      },
      fail: (err) => {
        const errorMessage = err.message || JSON.stringify(err);
        if (errorMessage.includes('already') || errorMessage.includes('timeout')) {
          success && success({});
        } else if (errorMessage.includes('1500104') || errorMessage.includes('10008')) {
          this.connectDevice(deviceId, (info) => {
            wx.writeBLECharacteristicValue({
              deviceId: deviceId,
              serviceId: info.serviceId,
              characteristicId: info.characteristicId,
              value: buffer,
              success: (retryRes) => success && success(retryRes),
              fail: (retryErr) => fail && fail('打印失败：' + JSON.stringify(retryErr))
            });
          }, (connectErr) => fail && fail('连接打印机失败：' + JSON.stringify(connectErr)));
        } else {
          fail && fail(errorMessage);
        }
      }
    });
  },

  /**
   * 生成小票模板 - 使用ESC/POS指令
   */
  generateReceipt: function (order, storeInfo, externalLogoBuffer) {
    const result = [];
    
    const addBytes = (bytes) => {
      if (Array.isArray(bytes)) {
        result.push(...bytes);
      } else {
        result.push(bytes);
      }
    };
    
    // ==========================================
    // 强制调用新的 GBK.js 进行转码
    // ==========================================
    const addText = (text) => {
      const encoded = GBK.encode(text);
      // 兼容处理：确保我们拿到的是一个可遍历的数组或视图
      const view = encoded instanceof ArrayBuffer ? new Uint8Array(encoded) : encoded;
      for (let i = 0; i < view.length; i++) {
        result.push(view[i]);
      }
    };
    
    const addLine = () => result.push(0x0A);
    const addSeparator = () => { addText('--------------------'); addLine(); };
    const getAmount = (val) => (parseFloat(val) || 0).toFixed(2);
    
    // ==========================================
    // ========== 1. 居中大号加粗打印 Lenovo Logo ==========
    // 初始化打印机，清除之前的所有设置
    addBytes([0x1B, 0x40]);       // ESC @ 初始化打印机
    
    // 打印 Lenovo Logo 图片（居中）
    // 优先使用传入的 externalLogoBuffer（从 BMP 加载的）
    const logoBuffer = externalLogoBuffer || this.generateLenovoLogo();
    if (logoBuffer && logoBuffer.byteLength > 0) {
      // 将 Logo buffer 添加到结果
      const logoView = new Uint8Array(logoBuffer);
      for (let i = 0; i < logoView.length; i++) {
        result.push(logoView[i]);
      }
    } else {
      // 如果图片生成失败，回退到文字打印（使用空格居中）
      addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
      addBytes([0x1D, 0x21, 0x11]); // GS ! 17 双倍宽高
      addText('     Lenovo'); // 5个空格 + Lenovo
      addBytes([0x1D, 0x21, 0x00]); // GS ! 0 恢复正常大小
      addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
      addLine();
    }

    // ========== 1.5 打印"联想体验店"（居中）==========
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addBytes([0x1D, 0x21, 0x01]); // GS ! 1 双倍宽度（正常高度）
    addText('           联想体验店'); // 11个空格 + 联想体验店
    addBytes([0x1D, 0x21, 0x00]); // GS ! 0 恢复正常大小
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addLine();
    addLine(); // 额外空行，分隔标题与主体

    // ESC/POS 终极强制中文初始化指令
    // ==========================================
    addBytes([0x1B, 0x40]);       // ESC @ 初始化打印机
    addBytes([0x1B, 0x39, 0x01]); // 强制指令：ESC 9 1 选择中文/GBK代码页
    addBytes([0x1B, 0x74, 0xFF]); // 强制指令：ESC t 打印机字符集
    addBytes([0x1C, 0x26]);       // 强制指令：FS & 开启汉字模式
    addBytes([0x1B, 0x32]);         // ESC 2 使用默认行距（1倍行距）
    addBytes([0x1B, 0x33, 0x00]); // ESC 3 0 设置紧凑行距（可调整）

    // ========== 订单信息 ==========
    // 3. 标题居中加粗
    addBytes([0x1B, 0x61, 0x01]); // ESC a 1 居中
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addText('订单信息');
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addBytes([0x1B, 0x61, 0x00]); // ESC a 0 左对齐
    addLine();
    addSeparator();
    // 2. 隐藏公司名称"成都艾诺云科技有限公司"
    addText('订单编号: ' + (order.orderNo || '未知'));
    addLine();
    addText('下单时间: ' + (order.createTime || order.createTimeFormat || '未知'));
    addLine();
    const createUserPhone = order.createUserPhone ? ' (' + order.createUserPhone + ')' : '';
    addText('提交人: ' + (order.createUser || '未知') + createUserPhone);
    addLine();
    addSeparator();

    // ========== 商品明细 ==========
    // 3. 标题居中加粗
    addBytes([0x1B, 0x61, 0x01]); // ESC a 1 居中
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addText('商品明细');
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addBytes([0x1B, 0x61, 0x00]); // ESC a 0 左对齐
    addLine();
    addSeparator();

    if (order.goods && Array.isArray(order.goods) && order.goods.length > 0) {
      order.goods.forEach((item, index) => {
        // 3. 商品名称加粗
        addText('商品 ' + (index + 1) + ': ');
        addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
        // 新建订单提交后的标准化商品项可能只保留 productName，兼容订单详情打印使用的 name。
        const productName = item.name || item.productName || item.product_name || '';
        addText(productName || '未命名');
        addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
        addLine();
        addText('PN: ' + (item.pnCode || '无') + ' / SN: ' + (item.snCode || '无'));
        addLine();
        const quantity = item.quantity || 0;
        addText('数量: ' + quantity);
        addLine();
        if (index < order.goods.length - 1) {
          addSeparator();
        }
      });
    } else {
      addText('无商品');
      addLine();
    }
    addSeparator();

    // ========== 金额汇总 ==========
    // 3. 标题居中加粗
    addBytes([0x1B, 0x61, 0x01]); // ESC a 1 居中
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addText('金额汇总');
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addBytes([0x1B, 0x61, 0x00]); // ESC a 0 左对齐
    addLine();
    addSeparator();
    addText('总计: ' + getAmount(order.totalAmount));
    addLine();
    // 4. 判断优惠、国补、教育补贴如果金额为0，则不展示
    const discount = parseFloat(order.discount) || 0;
    const nationalSubsidy = parseFloat(order.nationalSubsidy) || 0;
    const educationSubsidy = parseFloat(order.educationSubsidy) || 0;
    if (discount > 0) {
      addText(' 优惠: ' + getAmount(order.discount));
      addLine();
    }
    if (nationalSubsidy > 0) {
      addText(' 国补: ' + getAmount(order.nationalSubsidy));
      addLine();
    }
    if (educationSubsidy > 0) {
      addText(' 教育补贴: ' + getAmount(order.educationSubsidy));
      addLine();
    }
    // 应收金额（加粗，正常大小）
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addText('应收: ' + getAmount(order.actualAmount));
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addLine();
    // 空一行
    addLine();
    // 实收金额（加粗，双倍高，比应收大一号）
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addBytes([0x1D, 0x21, 0x10]); // GS ! 16 双倍高
    addText('实收: ' + getAmount(order.paymentTotal));
    addBytes([0x1D, 0x21, 0x00]); // GS ! 0 恢复正常
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addLine();
    addSeparator();

    // ========== 6. 页面最下方打印售后须知 ==========
    // 3. 标题居中加粗
    addBytes([0x1B, 0x61, 0x01]); // ESC a 1 居中
    addBytes([0x1B, 0x45, 0x01]); // ESC E 1 加粗
    addText('售后须知');
    addBytes([0x1B, 0x45, 0x00]); // ESC E 0 取消加粗
    addBytes([0x1B, 0x61, 0x00]); // ESC a 0 左对齐
    addLine();
    addSeparator();
    // 1. 引用打印预览中的售后须知（每行16个汉字）
    addText('1.请确定以上资料正确无误,收货');
    addLine();
    addText('  时核对相应物品及配件外观完好');
    addLine();
    addText('  无损、配置齐全。');
    addLine();
    addText('2.所购新机在15天内若有质量问题');
    addLine();
    addText('  ,经厂家售后鉴定后包换新机(请');
    addLine();
    addText('  确保原包装箱/盒、保修卡等配');
    addLine();
    addText('  件完好无损),若机身或机壳刮花');
    addLine();
    addText('  损坏,无法支持换机,只做维修');
    addLine();
    addText('  处理。');
    addLine();
    addText('3.请您按照厂家说明书规范使用,');
    addLine();
    addText('  机器在质保期内若有质量问题,');
    addLine();
    addText('  经厂家售后鉴定后免费维修,人');
    addLine();
    addText('  为损坏(如入液、受潮、私自拆');
    addLine();
    addText('  装等)均不在免费维修范围内。');
    addLine();
    addText('4.本单据可作为保修凭证,请妥善保');
    addLine();
    addText('  管,如有售后,请出示此单。');
    addLine();
    addSeparator();

    // 5. 不显示谢谢惠顾及400电话
    addLine();
    addLine();
    addLine(); // 额外空白行
    
    // 切纸命令
    addBytes([0x1D, 0x56, 0x00]); // GS V 0 切纸
    
    // 转换为ArrayBuffer
    const buffer = new ArrayBuffer(result.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < result.length; i++) {
      view[i] = result[i];
    }
    
    return buffer;
  },

  /**
   * 将ImageData转换为ESC/POS位图命令 (保留你的原有实现)
   */
  imageDataToBitmap: function (imageData, width, height) {
    const MAX_HEIGHT = 600;
    if (height > MAX_HEIGHT) height = MAX_HEIGHT;
    
    const scaleFactor = 0.75;
    const newWidth = Math.floor(width * scaleFactor);
    const newHeight = Math.floor(height * scaleFactor);
    const bytesPerLine = Math.ceil(newWidth / 8);
    const bitmapData = [];
    
    bitmapData.push(0x1B, 0x40); 
    const xL = bytesPerLine & 0xFF;
    const xH = (bytesPerLine >> 8) & 0xFF;
    const yL = newHeight & 0xFF;
    const yH = (newHeight >> 8) & 0xFF;
    
    bitmapData.push(0x1D, 0x76, 0x30, 0x00);
    bitmapData.push(xL, xH, yL, yH);
    
    for (let y = 0; y < newHeight; y++) {
      for (let xByte = 0; xByte < bytesPerLine; xByte++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xByte * 8 + bit;
          if (x < newWidth) {
            const srcX = Math.floor(x / scaleFactor);
            const srcY = Math.floor(y / scaleFactor);
            const idx = (srcY * width + srcX) * 4;
            const gray = (imageData.data[idx] * 0.299 + imageData.data[idx + 1] * 0.587 + imageData.data[idx + 2] * 0.114);
            if (gray < 180) {
              byte |= (1 << (7 - bit));
            }
          }
        }
        bitmapData.push(byte);
      }
    }
    
    bitmapData.push(0x1B, 0x64, 0x03); 
    bitmapData.push(0x1D, 0x56, 0x00); 
    
    const buffer = new ArrayBuffer(bitmapData.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < bitmapData.length; i++) {
      view[i] = bitmapData[i];
    }
    return buffer;
  },

  /**
   * 从 BMP 文件加载 Logo 并转换为 ESC/POS 位图格式
   * 带缓存机制，只转换一次，后续直接返回缓存数据
   */
  loadLogoFromBMP: function() {
    return new Promise((resolve, reject) => {
      // 如果已有缓存，直接返回
      if (cachedLogoBuffer) {
        console.log('使用缓存的 Logo 位图数据');
        resolve(cachedLogoBuffer);
        return;
      }
      
      // 如果正在加载中，加入等待队列
      if (isLogoLoading) {
        console.log('Logo 正在加载中，加入等待队列');
        logoLoadCallbacks.push({ resolve, reject });
        return;
      }
      
      // 开始加载
      isLogoLoading = true;
      logoLoadCallbacks = [{ resolve, reject }];
      
      console.log('开始加载并转换 BMP Logo...');
      
      // 使用 wx.getImageInfo 获取图片信息
      wx.getImageInfo({
        src: '/images/2.bmp',
        success: (imageInfo) => {
          console.log('图片信息获取成功:', imageInfo);
          
          // 创建离屏 canvas
          const canvas = wx.createOffscreenCanvas({
            type: '2d',
            width: Math.min(imageInfo.width, 384),
            height: imageInfo.height
          });
          
          if (!canvas) {
            console.log('离屏 Canvas 创建失败，使用文字回退');
            isLogoLoading = false;
            logoLoadCallbacks.forEach(cb => cb.reject(new Error('Canvas creation failed')));
            logoLoadCallbacks = [];
            return;
          }
          
          const ctx = canvas.getContext('2d');
          
          // 设置 canvas 尺寸
          const width = Math.min(imageInfo.width, 384);
          const height = imageInfo.height;
          
          // 创建图片对象
          const img = canvas.createImage();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, width, height);
            
            // 获取像素数据
            const imageData = ctx.getImageData(0, 0, width, height);
            
            // 转换为 ESC/POS 位图（包含居中指令）
            const buffer = this.imageDataToBitmapWithCenter(imageData, width, height);
            
            // 缓存结果
            cachedLogoBuffer = buffer;
            isLogoLoading = false;
            
            console.log('Logo 位图生成成功并缓存');
            
            // 通知所有等待的回调
            logoLoadCallbacks.forEach(cb => cb.resolve(buffer));
            logoLoadCallbacks = [];
          };
          img.onerror = (err) => {
            console.error('图片绘制失败:', err);
            isLogoLoading = false;
            logoLoadCallbacks.forEach(cb => cb.reject(err));
            logoLoadCallbacks = [];
          };
          img.src = '/images/2.bmp';
        },
        fail: (err) => {
          console.error('加载图片失败:', err);
          isLogoLoading = false;
          logoLoadCallbacks.forEach(cb => cb.reject(err));
          logoLoadCallbacks = [];
        }
      });
    });
  },

  /**
   * 将ImageData转换为ESC/POS位图命令（带居中）
   */
  imageDataToBitmapWithCenter: function (imageData, width, height) {
    const MAX_HEIGHT = 600;
    if (height > MAX_HEIGHT) height = MAX_HEIGHT;
    
    const scaleFactor = 0.75;
    const newWidth = Math.floor(width * scaleFactor);
    const newHeight = Math.floor(height * scaleFactor);
    const bytesPerLine = Math.ceil(newWidth / 8);
    const bitmapData = [];
    
    // 初始化打印机并设置居中
    bitmapData.push(0x1B, 0x40);       // ESC @ 初始化
    bitmapData.push(0x1B, 0x61, 0x01); // ESC a 1 居中对齐
    
    const xL = bytesPerLine & 0xFF;
    const xH = (bytesPerLine >> 8) & 0xFF;
    const yL = newHeight & 0xFF;
    const yH = (newHeight >> 8) & 0xFF;
    
    bitmapData.push(0x1D, 0x76, 0x30, 0x00); // GS v 0 位图打印命令
    bitmapData.push(xL, xH, yL, yH);
    
    for (let y = 0; y < newHeight; y++) {
      for (let xByte = 0; xByte < bytesPerLine; xByte++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xByte * 8 + bit;
          if (x < newWidth) {
            const srcX = Math.floor(x / scaleFactor);
            const srcY = Math.floor(y / scaleFactor);
            const idx = (srcY * width + srcX) * 4;
            const gray = (imageData.data[idx] * 0.299 + imageData.data[idx + 1] * 0.587 + imageData.data[idx + 2] * 0.114);
            if (gray < 180) {
              byte |= (1 << (7 - bit));
            }
          }
        }
        bitmapData.push(byte);
      }
    }
    
    // 恢复左对齐并换行
    bitmapData.push(0x1B, 0x61, 0x00); // ESC a 0 左对齐
    bitmapData.push(0x0A); // 换行
    
    const buffer = new ArrayBuffer(bitmapData.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < bitmapData.length; i++) {
      view[i] = bitmapData[i];
    }
    return buffer;
  },
  
  /**
   * 清除 Logo 缓存（用于更换 Logo 图片时调用）
   */
  clearLogoCache: function() {
    cachedLogoBuffer = null;
    console.log('Logo 缓存已清除');
  },

  /**
   * 生成 Lenovo Logo 位图（回退方法）
   * 如果 BMP 加载失败，使用文字版 Logo
   */
  generateLenovoLogo: function() {
    // 返回 null，让调用方使用回退方案
    return null;
  },

  /**
   * 创建 Lenovo Logo 图案（简化版）
   * 返回二维数组表示的位图图案
   */
  createLenovoLogoPattern: function() {
    const width = 384;
    const height = 80;
    const pattern = [];
    
    // 初始化空白图案
    for (let y = 0; y < height; y++) {
      pattern[y] = new Array(width).fill(0);
    }
    
    // 绘制 Lenovo Logo 的简化版本
    // 在中间区域绘制 Logo
    const startX = 80;
    const startY = 15;
    
    // "Lenovo" 文字样式（使用点阵模拟）
    const letters = {
      'L': [
        [1,0,0,0],
        [1,0,0,0],
        [1,0,0,0],
        [1,0,0,0],
        [1,1,1,1]
      ],
      'e': [
        [0,1,1,0],
        [1,0,0,1],
        [1,1,1,1],
        [1,0,0,0],
        [0,1,1,1]
      ],
      'n': [
        [1,1,1,0],
        [1,0,0,1],
        [1,0,0,1],
        [1,0,0,1],
        [1,0,0,1]
      ],
      'o': [
        [0,1,1,0],
        [1,0,0,1],
        [1,0,0,1],
        [1,0,0,1],
        [0,1,1,0]
      ],
      'v': [
        [1,0,0,1],
        [1,0,0,1],
        [1,0,0,1],
        [0,1,1,0],
        [0,1,0,0]
      ],
      ' ': [
        [0,0,0,0],
        [0,0,0,0],
        [0,0,0,0],
        [0,0,0,0],
        [0,0,0,0]
      ]
    };
    
    // 绘制红色背景条（模拟 Lenovo 红色背景）
    for (let y = startY - 5; y < startY + 40; y++) {
      for (let x = startX - 20; x < startX + 220; x++) {
        if (y >= 0 && y < height && x >= 0 && x < width) {
          // 红色背景使用密集点阵模拟
          if ((x + y) % 2 === 0) {
            pattern[y][x] = 1;
          }
        }
      }
    }
    
    // 绘制 "Lenovo" 文字（白色，使用空白区域）
    const text = 'Lenovo';
    let currentX = startX;
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const charPattern = letters[char] || letters[' '];
      
      // 绘制字符（放大 3 倍）
      for (let cy = 0; cy < charPattern.length; cy++) {
        for (let cx = 0; cx < charPattern[cy].length; cx++) {
          if (charPattern[cy][cx] === 0) {
            // 空白像素（白色文字）
            for (let sy = 0; sy < 4; sy++) {
              for (let sx = 0; sx < 4; sx++) {
                const py = startY + cy * 4 + sy;
                const px = currentX + cx * 4 + sx;
                if (py >= 0 && py < height && px >= 0 && px < width) {
                  pattern[py][px] = 0; // 白色
                }
              }
            }
          }
        }
      }
      currentX += 20; // 字符间距
    }
    
    // 绘制 "联想" 中文字符（简化表示）
    const chineseStartX = startX + 140;
    for (let y = startY; y < startY + 35; y++) {
      for (let x = chineseStartX; x < chineseStartX + 60; x++) {
        if (y >= 0 && y < height && x >= 0 && x < width) {
          // 使用不同的点阵模式区分中文
          if ((x + y * 2) % 3 === 0) {
            pattern[y][x] = 0; // 白色文字效果
          }
        }
      }
    }
    
    return pattern;
  },

  centerText: function (text) {
    const maxLength = 24;
    const padding = Math.max(0, Math.floor((maxLength - text.length) / 2));
    return ' '.repeat(padding) + text;
  },

  formatGoodsLine: function (codeInfo, price, quantity, subtotal) {
    const code = codeInfo.substring(0, 10).padEnd(12, ' ');
    const priceStr = price.padStart(6, ' ');
    const quantityStr = quantity.toString().padStart(4, ' ');
    const subtotalStr = subtotal.padStart(6, ' ');
    return code + priceStr + quantityStr + subtotalStr;
  },

  byteArrayToBuffer: function (byteArray) {
    try {
      const buffer = new ArrayBuffer(byteArray.length);
      const dataView = new DataView(buffer);
      for (let i = 0; i < byteArray.length; i++) {
        dataView.setUint8(i, byteArray[i]);
      }
      return buffer;
    } catch (error) {
      return new ArrayBuffer(0);
    }
  },

  /**
   * 打印订单小票
   */
  printOrder: async function (order, success, fail) {
    if (!order || typeof order !== 'object') {
      fail && fail('订单数据无效');
      return;
    }
    
    const printerInfo = wx.getStorageSync('printerInfo');
    const connectedPrinter = wx.getStorageSync('connectedPrinter');
    
    if (!printerInfo || !connectedPrinter) {
      fail && fail('请先绑定蓝牙打印机');
      return;
    }
    
    const app = getApp();
    const storeInfo = app.globalData.storeInfo || {};
    
    // 异步加载 Logo 并生成打印数据
    try {
      const printBuffer = await this.generateReceiptAsync(order, storeInfo);
      
      if (printBuffer.byteLength === 0) {
        fail && fail('打印数据为空');
        return;
      }
      
      wx.openBluetoothAdapter({
        success: () => {
          wx.getBluetoothAdapterState({
            success: (adapterState) => {
              if (!adapterState.available) {
                fail && fail('蓝牙未开启，请先开启手机蓝牙');
                return;
              }
              
              wx.closeBLEConnection({
                deviceId: connectedPrinter.deviceId,
                complete: () => {
                  setTimeout(() => {
                    this.connectDevice(connectedPrinter.deviceId, (info) => {
                      setTimeout(() => {
                        this.sendData(
                          connectedPrinter.deviceId,
                          info.serviceId,
                          info.characteristicId,
                          printBuffer,
                          (res) => {
                            // 打印成功后断开连接，释放打印机资源
                            setTimeout(() => {
                              this.disconnectDevice(connectedPrinter.deviceId);
                              console.log('打印完成，已断开蓝牙连接');
                              success && success(res);
                            }, 2000);
                          },
                          (err) => {
                            // 打印失败也断开连接
                            this.disconnectDevice(connectedPrinter.deviceId);
                            fail && fail('打印失败：' + JSON.stringify(err));
                          }
                        );
                      }, 500);
                    }, (connectErr) => {
                      fail && fail('连接打印机失败：' + JSON.stringify(connectErr));
                    });
                  }, 100);
                }
              });
            },
            fail: (adapterErr) => fail && fail('蓝牙适配器错误：' + (adapterErr.message || JSON.stringify(adapterErr)))
          });
        },
        fail: (openErr) => {
          const msg = openErr.message || JSON.stringify(openErr);
          if (msg.includes('1500101') || msg.includes('10001')) {
            fail && fail('蓝牙初始化失败，请检查手机蓝牙是否开启，以及微信是否有蓝牙权限');
          } else {
            fail && fail('蓝牙适配器初始化失败：' + msg);
          }
        }
      });
    } catch (error) {
      console.error('生成打印数据失败:', error);
      fail && fail('生成打印数据失败：' + error.message);
    }
  },

  /**
   * 异步生成打印数据（已取消 Logo 图片打印）
   */
  generateReceiptAsync: async function(order, storeInfo) {
    // Logo 图片打印功能已取消，直接传入 null
    console.log('Logo 图片打印功能已禁用');
    return this.generateReceipt(order, storeInfo, null);
  }
};

module.exports = BluetoothPrinter;
