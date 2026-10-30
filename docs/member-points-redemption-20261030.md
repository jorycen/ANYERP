# 会员积分与兑换调整（2026-10-30）

用户已确认：取消强制手机号授权；首次保存购机手机号，后续自动查询待领积分，点击批量领取。新商品券领取不选门店、不预占，核销时检查实际门店库存并事务出库；历史预占券沿用原规则。

购机号码使用独立 purchase_phone 字段，启动迁移增加该列。新增 POST /api/v1/customer/member/purchase-phone（phone 参数）及 GET /api/v1/customer/member/pending-points；返回脱敏号码、pendingPoints、pendingCount、hasPhone。领取接口省略 phone 时使用已保存号码，预览与领取共用后台计分函数，原订单唯一键防重复入账。

会员小程序代码在 member 本地维护，不上传 GitHub。正式接口此前实测新增积分路由404；需部署本提交后完成字段迁移、确认接口可用，再编译会员端真机验证。上传GitHub不代表云端部署成功。

不修改积分公式、补差及毛利规则，不清除已有验证号码，不自动领取积分。数据库集成与真机验收待完成。
