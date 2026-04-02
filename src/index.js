const app = require('./app');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 80;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ainuoyun ERP Server running on http://localhost:${PORT}`);
  console.log(`📡 Health Check: http://localhost:${PORT}/health`);
});
