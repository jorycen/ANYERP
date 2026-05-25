-- 初始化区域数据
USE `cloud1-8glwjlnq4c74f7f1`;

-- 插入区域
INSERT INTO T_REGION (REGION_ID, REGION_CODE, NAME, SORT_ORDER, STATUS) VALUES
('R001', 'CD', '成都区域', 1, 1),
('R002', 'CQ', '重庆区域', 2, 1),
('R003', 'DS', '地市区域', 3, 1);

SELECT '区域数据初始化完成！' AS message;
