/**
 * 订单与补贴计算服务
 */
class OrderService {
  /**
   * 计算单品补贴
   * @param {number} categoryId - 1: 电脑, 2: 手机
   * @param {number} basePrice - 商品原价
   * @returns {number} 补贴金额
   */
  static calculateSubsidy(categoryId, basePrice) {
    if (!basePrice || isNaN(basePrice)) return 0;
    
    // 国补逻辑：85折 (15% off)
    const discount = basePrice * 0.15;
    
    if (categoryId === 1) {
      // 电脑类：最高 1500
      return Math.min(discount, 1500);
    } else if (categoryId === 2) {
      // 手机类：最高 500
      return Math.min(discount, 500);
    }
    
    return 0;
  }

  /**
   * 汇总订单金额
   * @param {Array} items - 订单明细项
   */
  static summaryOrder(items) {
    let totalAmount = 0;
    let subsidyAmount = 0;

    items.forEach(item => {
      const subsidy = this.calculateSubsidy(item.categoryId, item.price);
      totalAmount += parseFloat(item.price);
      subsidyAmount += subsidy;
      item.subsidyVal = subsidy; // 记录每项补贴
    });

    return {
      totalAmount,
      subsidyAmount,
      finalAmount: totalAmount - subsidyAmount
    };
  }
}

module.exports = OrderService;
