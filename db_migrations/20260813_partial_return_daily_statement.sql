-- Partial sales return items and negative daily-statement posting.
-- The return request is still approved in the existing two-level workflow;
-- only an approved/executed refund may create the negative statement item.

CREATE TABLE IF NOT EXISTS `T_SALES_RETURN_ITEM` (
  `ITEM_ID` bigint(20) AUTO_INCREMENT PRIMARY KEY,
  `RETURN_ID` varchar(32) NOT NULL,
  `ORIGINAL_ORDER_ID` varchar(32) NOT NULL,
  `ORIGINAL_ITEM_ID` varchar(32),
  `PRODUCT_ID` varchar(32),
  `PRODUCT_NAME` varchar(255),
  `PN_CODE` varchar(128),
  `SN_CODE` varchar(128),
  `ORIGINAL_QUANTITY` decimal(10,2) NOT NULL DEFAULT 0.00,
  `RETURN_QUANTITY` decimal(10,2) NOT NULL DEFAULT 0.00,
  `UNIT_PRICE` decimal(10,2) NOT NULL DEFAULT 0.00,
  `REFUND_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00,
  `CREATE_TIME` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_sales_return_item_return` (`RETURN_ID`),
  KEY `idx_sales_return_item_order` (`ORIGINAL_ORDER_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单商品明细，支持部分退单';

ALTER TABLE `T_SALES_RETURN`
  ADD COLUMN `ORIGINAL_PAYMENT_METHODS` text NULL COMMENT '原订单支付方式快照',
  ADD COLUMN `POST_TO_DAILY_STATEMENT` tinyint(1) NOT NULL DEFAULT 1 COMMENT '审批通过后是否生成日结负项',
  ADD COLUMN `DAILY_STATEMENT_AMOUNT` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '日结负向金额';

ALTER TABLE `T_REFUND_ORDER`
  ADD COLUMN `NEGATIVE_STATEMENT_ITEM_ID` bigint(20) NULL COMMENT '关联日结负项明细ID',
  ADD COLUMN `ORIGINAL_PAYMENT_METHODS` text NULL COMMENT '原订单支付方式快照';
