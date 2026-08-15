// pages/webview/webview.js
Page({
  /**
   * 页面的初始数据
   */
  data: {
    url: ''
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    if (options.url) {
      this.setData({
        url: decodeURIComponent(options.url)
      });
    }
    this.callback = options.callback || '';
  },

  /**
   * 处理 web-view 组件的 message 事件
   */
  onMessage: function (e) {
    const data = e.detail.data[0];
    if (data.type === 'aliyunDriveAuth' && data.code) {
      // 获取来源页面的页面栈
      const pages = getCurrentPages();
      if (pages.length > 1) {
        const prevPage = pages[pages.length - 2];
        // 调用来源页面的处理函数
        if (prevPage.handleAliyunDriveAuth) {
          prevPage.handleAliyunDriveAuth(data.code);
        }
      }
      // 关闭当前页面
      wx.navigateBack();
    }
  }
})