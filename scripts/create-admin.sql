-- 创建测试管理员账号
-- 密码: admin123456 (BCrypt加密)

INSERT INTO `sys_user` (`id`, `username`, `password`, `realname`, `phone`, `status`, `role_id`, `store_id`, `region_id`, `created_at`, `updated_at`) VALUES
(1, 'admin', '$2a$10$n1KIPdw3WuW7jHAJ/dFFu.fe5WWOpKv6o0BUXLbeXxj/neUqSxHr2', '系统管理员', '13800138000', 1, 1, NULL, NULL, NOW(), NOW());

-- 分配所有区域权限给管理员
INSERT INTO `sys_user_region` (`id`, `user_id`, `region_id`, `created_at`) VALUES
(1, 1, 1, NOW()),
(2, 1, 2, NOW()),
(3, 1, 3, NOW());
