require('dotenv').config();

// Export the configuration object containing the CloudBase SQL connection details.
// Make sure to fill in the correct values in the .env file.
module.exports = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lenovo_smart_mgmt'
};
