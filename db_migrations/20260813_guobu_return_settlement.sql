-- National subsidy return settlement extensions.
-- Customer received and policy subsidy receivable are posted separately.

CREATE TABLE IF NOT EXISTS `T_SALES_RETURN_RESOURCE` (
  `RESOURCE_RETURN_ID` bigint(20) AUTO_INCREMENT PRIMARY KEY,
  `RETURN_ID` varchar(32) NOT NULL,
  `ORIGINAL_ORDER_ID` varchar(32) NOT NULL,
  `ORIGINAL_ITEM_ID` varchar(32),
  `RESOURCE_ID` varchar(64),
  `RESOURCE_TYPE` varchar(64) NOT NULL,
  `BEFORE_STATUS` varchar(32),
  `TARGET_STATUS` varchar(32) NOT NULL DEFAULT 'AVAILABLE',
  `STATUS` varchar(32) NOT NULL DEFAULT 'pending',
  `CREATE_TIME` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `UPDATE_TIME` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uni_return_resource` (`RETURN_ID`, `ORIGINAL_ITEM_ID`, `RESOURCE_ID`, `RESOURCE_TYPE`),
  KEY `idx_return_resource_return` (`RETURN_ID`),
  KEY `idx_return_resource_type` (`RESOURCE_TYPE`, `STATUS`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退单时回退商品资源资格';

ALTER TABLE `T_SALES_RETURN_ITEM`
  ADD COLUMN `CUSTOMER_RECEIVED_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '对应客户实收退款',
  ADD COLUMN `POLICY_SUBSIDY_RECEIVABLE_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '对应国补代收退款',
  ADD COLUMN `NATIONAL_SUBSIDY_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '退回国补金额',
  ADD COLUMN `RESOURCE_TYPES` text NULL COMMENT '需要回退的资源资格';

ALTER TABLE `T_REFUND_ORDER`
  ADD COLUMN `CUSTOMER_RECEIVED_REFUND_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '客户实收退款金额',
  ADD COLUMN `POLICY_SUBSIDY_RECEIVABLE_REFUND_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '国补代收退款金额',
  ADD COLUMN `NATIONAL_SUBSIDY_REFUND_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '国补资格对应退款金额',
  ADD COLUMN `CUSTOMER_STATEMENT_ITEM_ID` bigint(20) NULL COMMENT '客户实收负向日结明细',
  ADD COLUMN `POLICY_SUBSIDY_STATEMENT_ITEM_ID` bigint(20) NULL COMMENT '国补代收负向日结明细';

-- On refund execution success, the service must atomically release GOV_SUBSIDY
-- resources, create the customer-received negative item, create a separate
-- policy-subsidy-receivable negative item, and remain idempotent.
