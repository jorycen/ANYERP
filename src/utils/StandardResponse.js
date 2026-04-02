class StandardResponse {
  /**
   * 成功响应
   * @param {any} data 返回的数据
   * @param {string} message 成功提示信息
   * @param {number} code 业务状态码，默认 0
   * @returns {object} 标准格式对象
   */
  static success(data = null, message = 'Success', code = 0) {
    return {
      code,
      message,
      data,
      timestamp: Date.now()
    };
  }

  /**
   * 失败/错误响应
   * @param {string} message 错误提示信息
   * @param {number} code 业务错误码，默认 -1
   * @param {any} data 补充的错误数据，通常为 null
   * @returns {object} 标准格式对象
   */
  static error(message = 'Error', code = -1, data = null) {
    return {
      code,
      message,
      data,
      timestamp: Date.now()
    };
  }

  /**
   * 参数校验失败响应
   * @param {string} message 提示信息
   * @param {any} errors 具体校验错误明细
   * @returns {object} 标准格式对象
   */
  static validationError(message = 'Validation Error', errors = null) {
    return {
      code: 400,
      message,
      data: errors,
      timestamp: Date.now()
    };
  }

  /**
   * 未授权响应
   * @param {string} message 提示信息
   * @returns {object} 标准格式对象
   */
  static unauthorized(message = 'Unauthorized') {
    return {
      code: 401,
      message,
      data: null,
      timestamp: Date.now()
    };
  }

  /**
   * 权限拒绝响应
   * @param {string} message 提示信息
   * @returns {object} 标准格式对象
   */
  static forbidden(message = 'Forbidden') {
    return {
      code: 403,
      message,
      data: null,
      timestamp: Date.now()
    };
  }
}

module.exports = StandardResponse;
