const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');

/**
 * 获取供应商列表
 */
exports.getAllSuppliers = async (req, res) => {
  try {
    const [suppliers] = await db.execute('SELECT * FROM T_SUPPLIER ORDER BY CREATE_TIME DESC');
    return ApiResponse.success(suppliers).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching suppliers', error.message).send(res, 500);
  }
};

/**
 * 新增供应商
 */
exports.createSupplier = async (req, res) => {
  const { name, contact, phone } = req.body;
  if (!name) return ApiResponse.error('Supplier name is required').send(res, 400);

  const supplierId = `SUP-${Date.now()}`;
  try {
    await db.execute(
      'INSERT INTO T_SUPPLIER (SUPPLIER_ID, SUPPLIER_NAME, CONTACT_PERSON, PHONE) VALUES (?, ?, ?, ?)',
      [supplierId, name, contact, phone]
    );
    return ApiResponse.success({ supplierId }).send(res, 201);
  } catch (error) {
    return ApiResponse.error('Error creating supplier', error.message).send(res, 500);
  }
};
