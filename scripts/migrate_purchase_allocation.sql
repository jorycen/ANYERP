-- 为采购申请明细表添加门店分配字段
ALTER TABLE T_PURCHASE_REQUEST_ITEM ADD COLUMN store_allocations TEXT NULL COMMENT '门店分配信息';
