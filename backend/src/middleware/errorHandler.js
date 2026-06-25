const { isTransientDatabaseError } = require('../config/database');

async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    let status = err.status || 500;
    let message = err.message || 'Internal server error';

    if (isTransientDatabaseError(err)) {
      status = 503;
      message = 'Database connection is temporarily unavailable. Please retry later.';
    } else if (err.name === 'SequelizeValidationError') {
      status = 400;
      message = 'Validation error: ' + err.errors.map(e => `${e.path}: ${e.message}`).join(', ');
    } else if (err.name === 'SequelizeUniqueConstraintError') {
      status = 400;
      message = 'Data already exists: ' + (err.errors[0]?.message || err.message);
    } else if (err.parent?.sqlMessage) {
      message = 'Database error: ' + err.parent.sqlMessage;
    }

    console.error('Error:', {
      status,
      message,
      originalError: err.message,
      stack: err.stack,
      path: ctx.path,
      method: ctx.method
    });

    ctx.status = status;
    ctx.body = {
      code: status,
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    };
  }
}

module.exports = { errorHandler };
