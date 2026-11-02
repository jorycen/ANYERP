# 重点分类自动报表

## 配置与接口

- Web：商品管理 → 分类管理 → 新增/编辑分类 → 重点分类。各级分类均可独立开启，默认关闭；未选择时报告显示配置提示。
- 复用 `POST /api/product/category`、`PUT /api/product/category/:categoryId`，新增可选布尔参数 `isFocusCategory`；创建默认 false，更新省略保留旧值，非布尔值返回 400。沿用分类维护接口原有鉴权及权限。
- 复用 `GET /api/product/category/tree`，节点新增 `is_focus_category`（0/1）。其他分类、排序及财务展示配置不变。
- 兼容扩展 `GET /api/report/dashboard/overview`，`productAnalysis.focusCategories` 自动读取有效分类配置，原 `focusCategoryPaths` 参数不再决定结果；`focusCategoryMode` 继续返回 `category`。旧产品重点标记与 `focusProducts` 返回字段保留兼容。
- 每行含 `categoryPath/name/productName/quantity/unit/salesAmount/grossProfit/barWidth`。Web与小程序使用同一接口；不截断配置分类数量，不分级展开，不提供重叠分类总计。

## 统计契约

复用 `getProductRows` 的全量产品销售排名结果，包含原有已审批商品毛利调整；以当前分类ID解析规范路径，自身及路径边界内下级汇总。日期字段、Asia/Shanghai边界、授权门店、员工分配、产品线、归档范围、退货/冲销处理沿用经营看板原契约。不是实际采购/产品端利润，不增加新公式。金额按分汇总，数量保留两位小数；销售额降序、路径稳定排序。无销量分类返回0，无毛利查看权限返回null，不由前端补算。

## 部署与回滚

启动时幂等补充 `T_PRODUCT_CATEGORY.IS_FOCUS_CATEGORY TINYINT NOT NULL DEFAULT 0`。启动就绪前再次检查，迁移失败不标记就绪；不回填重点分类、不改业务单据。先部署后台，再部署Web和发布小程序。数据库需具有该表ALTER权限。回滚旧应用可保留新增字段，无需删除数据列。

## 验证

后台 `focusCategoryConfig.test.js`、`focusCategorySales.test.js`、`dashboardService.test.js`；小程序 `test/report-focus-categories.test.js`。覆盖配置更新/省略、非法值、迁移重入及失败、忽略客户端临时选择、全量产品、父子重叠、零销量、毛利权限与展示。生产发布后仍需用同账号、门店、日期及筛选进行真机跨端验收。
