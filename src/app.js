const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const ApiResponse = require('./utils/ApiResponse');

const app = express();

// Middlewares
app.use(helmet()); // Security headers
app.use(cors());   // Enable CORS
app.use(morgan('dev')); // Logging
app.use(express.json()); // Body parser
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/v1/auth', require('./routes/authRoutes'));
app.use('/api/v1/inventory', require('./routes/inventoryRoutes'));
app.use('/api/v1/orders', require('./routes/orderRoutes'));
app.use('/api/v1/stats', require('./routes/statsRoutes'));
app.use('/api/v1/suppliers', require('./routes/supplierRoutes'));
app.use('/api/v1/purchases', require('./routes/purchaseRoutes'));

// Health Check
app.get('/health', (req, res) => {
  return ApiResponse.success({ status: 'UP' }, 'System is healthy').send(res);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  return ApiResponse.error('Internal Server Error', err.message).send(res, 500);
});

module.exports = app;
