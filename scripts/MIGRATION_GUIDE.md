# 商品表字段迁移指南

## 修改内容

本次数据库迁移将对 T_PRODUCT 表进行以下修改：

1. **新增字段：MANUFACTURER_CODE** - 厂商编码
2. **新增字段：BARCODE_69** - 69码
3. **新增字段：MIN_SALE_PRICE** - 最低销售限价（替代原 COST_PRICE）
4. **数据迁移**：将原有 COST_PRICE 的值复制到 MIN_SALE_PRICE

## 迁移方法

### 方法一：使用 Node.js 脚本（推荐）

1. 确保 MySQL 服务已启动
2. 在 `backend` 目录下执行：

```bash
cd backend
node src/utils/migrate.js
```

### 方法二：直接执行 SQL 文件

1. 使用 MySQL 客户端工具（如 Navicat、MySQL Workbench 等）连接数据库
2. 执行文件：`scripts/migrate_product_fields.sql`

### 方法三：通过命令行执行 SQL

```bash
mysql -u root -p any_erp < scripts/migrate_product_fields.sql
```

## 文件说明

- `scripts/init.sql` - 完整的数据库初始化脚本（已更新字段）
- `scripts/migrate_product_fields.sql` - 增量迁移脚本
- `backend/src/utils/migrate.js` - Node.js 迁移执行脚本

## 注意事项

1. **COST_PRICE 字段**：保留该字段但标记为废弃，数据已复制到 MIN_SALE_PRICE
2. **字段位置**：新字段按业务逻辑合理排列
3. **重复执行安全**：迁移脚本支持重复执行，不会报错

## 验证

迁移完成后，可以使用以下 SQL 验证：

```sql
DESC T_PRODUCT;
```

应该能看到新增的三个字段：MANUFACTURER_CODE、BARCODE_69、MIN_SALE_PRICE
