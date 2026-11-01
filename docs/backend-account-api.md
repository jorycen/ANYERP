# 后台账号显示标记

字段：`T_STAFF.IS_BACKEND_ACCOUNT`，非空TINYINT，默认0。业务账号为0、后台账号为1；该字段不参与登录、角色权限或统计计算。

原管理API兼容扩展：

* `GET /system/users?accountType=all|business|backend`：默认all，返回`is_backend_account`；原关键词、门店、经销商权限及分页继续生效，类型筛选先于分页。
* `POST /system/user`、`PUT /system/user/:staffId`：参数`isBackendAccount`接受true/false、1/0或字符串1/0；新增默认0，更新省略保留原值。沿用admin/boss及原经销商管理权限，变更事务内审计。
* `/sales/auxiliary-staff`、月度任务人员选项及费用绩效人员选项默认过滤该字段为0，不接受前端绕过。门店负责人选择调用管理列表的business筛选。

用户管理、审批配置及直属上级配置读取完整账号；历史关联及认证按ID读取，不使用全局scope。小程序业务选人只采用后台业务名单，不能从缓存或管理用户接口合并补人。

部署前可运行`node backend/scripts/migrate-staff-backend-account.js`；启动runSchemaMigrations也执行同一幂等迁移。迁移后立即查询字段验证，失败不会标记服务已就绪。既有账号全部默认0，管理员自行明确标记；不自动分类人员。
