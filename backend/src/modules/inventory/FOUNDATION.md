# 统一库存基础资料

## 唯一来源

`T_INVENTORY_FOUNDATION` 按库存周期记录采购含税属性、实际采购成本及其依据。当前毛利计价方式由商品管理维护，当前公司标准定价由商品价格管理维护。基础资料 API 通过 `currentCatalog` 返回当前计价方式和公司定价；历史 `company_price` 列保留用于追溯，新增档案及迁移停写该列。
`T_INVENTORY_FOUNDATION_REF` 仅存关联标识和权限门店，不存第二套属性值。
库存、历史销售及来源单据保留原始事实；销售归档快照是历史核算审计，修改基础档案不会自动重写归档金额。

Web、ERP 小程序订单详情及库存报表都调用 `foundation.load/salesBasis`，以 basisId、revision 核对同一对象。
新销售计算使用 `applySalesPricing/applySalesTaxBasis`。原采购查询解析器仅用于初次建档/来源写入和迁移核实，不是查询时的另一套回退数据。

## 身份与批次

- SN 使用内部 sn_id 加库存周期标识；以 stock_cycle_reentry 日志区分重新入库，销售根据自身历史时点关联对应周期。
- 同一周期多个商品身份冲突时隔离并阻止直接确认。SN 文本或商品名称不能单独用于合并。
- 当前非 SN 聚合库存按库存记录/库位数量类型建档；不能推定已售商品来自当前库存。无法明确批次的历史非 SN 销售单独建档。
- 非 SN 补货增加聚合数量时，不能继承旧批次已确认票种，建立待核实的新库存基础记录，旧销售关联不动。
- 只有确认同商品、同实际批次后，可在统一管理入口关联记录；跨商品、SN 跨周期、权限越界及并发变化均拒绝。
- 十月临时分类票税确认只适用于原十月范围。共用记录涉及当前库存或十一月时，不用十月临时值填补未知；优先保留这些范围的已确认资料，矛盾不猜测。

## API 契约

原 `/api/v1/sales/:orderId`、`/sales/:orderId/gross-profit`、`/report/inventory` 兼容增加基础档案字段，复用原权限。
订单商品行返回 inventory_foundation；库存明细返回 basisId、basisRevision、invoiceType、unitCost、costMode、companyPrice。
无成本权限的订单响应不返回基础采购成本、公司价格及内部来源明细。

管理复用价格管理权限和经销商/门店数据范围：

| 方法/路径（/api/v1） | 参数/返回 |
| --- | --- |
| GET /product/price/inventory-foundation | keyword、status、productId、referenceKey、page、pageSize；后台筛选/分页及 total |
| PUT /product/price/inventory-foundation/:basisId | revision、invoiceType（收据/专票13%/null）、purchaseCost、costMode、companyPrice、reason；显式零成本、低于成本须确认 |
| GET /product/price/inventory-foundation/:basisId/history | 后台权限校验后返回修改审计 |
| POST /product/price/inventory-foundation/link | referenceKey、sourceBasisId、targetBasisId、sourceRevision、targetRevision、reason；只关联，不改历史金额 |

未知保留 null，不置零；修改带版本号并写前后审计。跨越用户完整门店范围的共同档案不能修改。
原库存计价 API 已改为同一基础档案修改服务，避免旧接口另写计价值。商品默认价和已归档成交/核算快照保留各自含义。

## 发布与迁移

入口：商品管理 → 价格管理 → **库存基础资料（含已售）**。

首次启动在就绪前建表、验证所有字段，并在 MySQL 命名锁内初始化现有库存及十月、十一月销售关联。分批事务完成后才提交 bootstrap_completed 标记。
后续启动不覆盖人工修订；初始化失败停止就绪，不能静默使用空资料或旧接口拼凑值。
新库存/库存周期变化在原写入事务中接入统一资料；查询不触发建档或金额重算。

可在发布前手动运行：

```powershell
node scripts/migrate-inventory-foundation.js          # 只读预览及冲突清单
node scripts/migrate-inventory-foundation.js --apply  # 建表、建档、关联、验证；不重算历史金额
```

原始表不删除，旧回填审计留存。迁移只将明确事实汇入统一档案；未关联及冲突项在管理入口核实。
历史毛利重算须另行明确订单范围与期间，不能因本次统一资料自动全量改数。
