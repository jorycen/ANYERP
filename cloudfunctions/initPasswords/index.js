// 云函数：初始化所有用户密码为手机号后6位
const cloud = require('wx-server-sdk');
cloud.init();

exports.main = async (event, context) => {
  const db = cloud.database();
  
  try {
    // 1. 初始化经销商密码
    const distributorsResult = await db.collection('distributors').get();
    for (const distributor of distributorsResult.data) {
      // 设置经销商主账号密码
      if (distributor.phone) {
        const defaultPassword = distributor.phone.slice(-6);
        await db.collection('distributors').doc(distributor._id).update({
          data: { password: defaultPassword }
        });
        console.log(`经销商 ${distributor.name} 密码已设置为: ${defaultPassword}`);
      }
      
      // 设置经销商员工密码
      if (distributor.staffList && distributor.staffList.length > 0) {
        for (let i = 0; i < distributor.staffList.length; i++) {
          const staff = distributor.staffList[i];
          if (staff.phone) {
            const defaultPassword = staff.phone.slice(-6);
            await db.collection('distributors').doc(distributor._id).update({
              data: { [`staffList.${i}.password`]: defaultPassword }
            });
            console.log(`经销商员工 ${staff.name} 密码已设置为: ${defaultPassword}`);
          }
        }
      }
    }
    
    // 2. 初始化门店密码
    const storesResult = await db.collection('stores').get();
    for (const store of storesResult.data) {
      const updateData = {};
      
      // 设置门店主账号密码
      if (store.phone) {
        updateData.password = store.phone.slice(-6);
      }
      
      // 设置店长密码
      if (store.managerPhone) {
        updateData.managerPassword = store.managerPhone.slice(-6);
      }
      
      // 设置店员密码
      if (store.staffList && store.staffList.length > 0) {
        for (let i = 0; i < store.staffList.length; i++) {
          const staff = store.staffList[i];
          if (staff.phone) {
            updateData[`staffList.${i}.password`] = staff.phone.slice(-6);
          }
        }
      }
      
      if (Object.keys(updateData).length > 0) {
        await db.collection('stores').doc(store._id).update({ data: updateData });
        console.log(`门店 ${store.name} 密码已初始化`);
      }
    }
    
    return {
      success: true,
      message: '密码初始化完成'
    };
  } catch (error) {
    console.error('初始化密码失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
};
