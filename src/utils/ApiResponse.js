/**
 * API 统一响应包装器
 */
class ApiResponse {
  constructor(success, message, data = null, error = null) {
    this.success = success;
    this.message = message;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  static success(data, message = 'Success') {
    return new ApiResponse(true, message, data);
  }

  static error(message, error = null) {
    return new ApiResponse(false, message, null, error);
  }

  send(res, statusCode = 200) {
    return res.status(statusCode).json(this);
  }
}

module.exports = ApiResponse;
