# 获赠入库及销售拆机回收

2026-10-26 用户确认实施。后台和Web位于ANY-ERP，小程序页面及API封装位于sdxcx，不操作member。

## 入口及流程

* 小程序：订单查询每单的可用资源内有独立“拆机回收 / 拆件入库”按钮；商城销售查询的同类弹窗同步接入。选择原销售商品行和回收配件，提交审批。当前支持已归档且没有退单记录的原销售。
* 小程序库存查询：获赠入库/入库记录。Web库存管理：获赠/拆机回收页签。
* pending → approved（待验收）→ received。pending/approved可由申请人或管理员取消；拒绝不生成入库单。已入库不可直接取消，不能丢弃库存后仍保留毛利。
* 没有找到现存拆件审批定义；新增sales_component_recovery（拆机回收审批）及gift_receipt（获赠入库审批），复用审批引擎。默认采购/admin/boss或签，可通过现有审批配置修改；在途使用冻结审批快照。申请人不提交成本，回收审批人逐项明确确认回收单价，允许明确0。
* 审批完成生成现有T_INBOUND/T_INBOUND_ITEM待入库记录，不创建采购单、应付、付款或银行流水。实际验收整单入库，SN按现有全局唯一校验，库存及毛利同事务提交。通用入库接口也校验审批内容，不允许改SN、数量、货型或回收成本。

## 金额与追溯

* 回收审批金额＝逐项确认单价×数量之和。验收入库时创建一笔已批准PerformanceProfitAdjustment关联原订单，复用现有经营毛利、员工分摊、明细及汇总口径，期间沿用原销售日期，不改原归档成本或快照，不在公司财务利润中直接增加同额收入。
* 获赠成本明确0且不创建销售毛利调整。新来源不回填历史零元采购。
* SN保留逐件回收成本、来源、审批单号、入库明细及毛利按公司定价标记。无SN商品使用原商品级COMPANY_PRICE，须先配置公司定价；复用FIFO成本层服务，已审批的获赠0成本层有效，混合库存不得被最新一笔零元入库全部覆盖。完整成本层缺失时阻止入库并提示核对，不冒充0。
* 二次销售冻结非采购来源及已知实际/平均成本（含明确0），产品端经营结算沿用该证据。原销售回收价值不再通过拆分降低原商品成本，避免重复增加毛利。普通获赠的已确认0成本可用于财务成本；回收确认价值属于内部经营价值，公司财务端列为原成本分摊待核实，不能在原整机已经计入成本后再重复扣一次。无SN混库存在回收来源时同样保持财务待核实，不因后续普通获赠覆盖该标记。
* 保存原订单、原商品行、原商品ID/PN/SN、目标商品/SN、审批、入库单、毛利调整ID及验收审计。requestKey防重；同编号不同内容拒绝；同原商品行同类配件不可重复申请。有关联回收的原销售退单被拦截，须先核实并处理回收。

## 接口契约与复用结论

原库存转换接口面向在库商品，执行拆分会降低原商品成本，不能直接承载已售回收及审批。因此新增非采购申请接口，复用现有审批、入库、SN、FIFO成本层及经营毛利调整服务，未复制新的前端业务计算。

* GET /inventory/non-purchase/context?orderId=：原销售可操作性及商品行、门店、后台生成的选择标签；原订单状态和门店/经销商权限校验。
* GET /inventory/non-purchase：page/pageSize、可选orderId/sourceType；返回data.list/total，含后台statusText及items，不把分页求和作为汇总。
* POST /inventory/non-purchase：sourceType为GIFT或SALES_COMPONENT_RECOVERY，requestKey、reason、items；回收传orderId、items[].orderItemId，获赠传storeId。items含productId、quantity、snCode（SN商品每行1件）、可选pnCode。所有商品必须启用且具有有效公司定价。
* POST /approval/business/:businessType/:businessId/action：沿用原接口；回收通过需businessData.costs，键为申请明细从0开始的序号，值为明确单价；拒绝需comment。由审批任务校验审批人，不因拥有采购角色就绕过任务。
* POST /inventory/non-purchase/:receiptId/receive：整单实物验收，可选locationId；不传则后台选择本店有效普通仓。
* POST /inventory/non-purchase/:receiptId/cancel：仅待审批/待验收可取消。

## 验证及发布状态

* 55项相关后台回归、4项新增小程序交互测试通过；Web生产构建通过，5个修改页面WXML及新页面WXSS经本机微信开发者工具编译器检查通过。
* 扩展旧测试中审批/毛利测试11项、原归档成本测试2项在HEAD基线同样失败；小程序旧采购编辑转发测试3项失败，当前原有executeReview没有转发purchaseEdits，与本轮新增costs分支无关。未替换旧业务规则或修改这些测试以掩盖结果。
* 新增启动迁移20261026_non_purchase_receipt.sql；只创建新表，审批目录只补缺失定义。未执行线上迁移、真实入库或毛利写入，未部署、未推送GitHub，小程序保留本地。已入库后的自动冲销与原销售退单联动未开放，当前明确阻止直接取消和直接退回完整原商品。
