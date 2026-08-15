const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext()
    
    if (event.code) {
      const res = await cloud.openapi.phonenumber.getPhoneNumber({
        code: event.code
      })
      
      console.log('getPhoneNumber result:', JSON.stringify(res))
      
      if (res.errCode === 0 && res.phoneInfo) {
        return {
          phoneNumber: res.phoneInfo.phoneNumber,
          purePhoneNumber: res.phoneInfo.purePhoneNumber,
          countryCode: res.phoneInfo.countryCode,
          openid: wxContext.OPENID,
          appid: wxContext.APPID,
          unionid: wxContext.UNIONID
        }
      } else {
        return {
          errCode: res.errCode || -1,
          errMsg: res.errMsg || '获取手机号失败'
        }
      }
    }
    
    if (event.cloudID) {
      const res = await cloud.getOpenData({
        list: [event.cloudID]
      })
      
      if (res.list && res.list.length > 0 && res.list[0].data) {
        const phoneData = res.list[0].data
        return {
          phoneNumber: phoneData.phoneNumber,
          purePhoneNumber: phoneData.purePhoneNumber,
          countryCode: phoneData.countryCode,
          openid: wxContext.OPENID,
          appid: wxContext.APPID,
          unionid: wxContext.UNIONID
        }
      }
    }
    
    return {
      errCode: -1,
      errMsg: '缺少code或cloudID参数'
    }
  } catch (err) {
    console.error('获取手机号失败:', err)
    return {
      errCode: err.errCode || -1,
      errMsg: err.errMsg || err.message || '获取手机号失败'
    }
  }
}
