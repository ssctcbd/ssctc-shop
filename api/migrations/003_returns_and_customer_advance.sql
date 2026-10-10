-- SSCTC Shop — sale returns and customer advance balance.
--
-- 1. sales: returned_amount and refunded_amount, and the money checks rewritten
--    so that   due = total − returned − paid   (paid is net of refunds).
-- 2. sale_returns: return_amount (value of the goods returned; total_refund is
--    the part actually given back) and an idempotency key.
-- 3. customer_advance_movements: the ledger behind customers.advance_balance,
--    exactly as inventory_movements is the ledger behind products.stock_qty.
--
-- Every change checks information_schema first, so the file can be run more
-- than once, through `npm run migrate` or pasted into phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- 1. sales --------------------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sales' AND column_name = 'returned_amount') = 0,
  'ALTER TABLE sales ADD COLUMN returned_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER total_amount', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sales' AND column_name = 'refunded_amount') = 0,
  'ALTER TABLE sales ADD COLUMN refunded_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER returned_amount', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Replace the two checks written before returns existed.
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_name = 'ck_sales_paid') = 1,
  'ALTER TABLE sales DROP CHECK ck_sales_paid', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_name = 'ck_sales_due') = 1,
  'ALTER TABLE sales DROP CHECK ck_sales_due', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_name = 'ck_sales_returned') = 0,
  'ALTER TABLE sales ADD CONSTRAINT ck_sales_returned CHECK (returned_amount >= 0 AND returned_amount <= total_amount AND refunded_amount >= 0 AND refunded_amount <= returned_amount)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_name = 'ck_sales_paid_net') = 0,
  'ALTER TABLE sales ADD CONSTRAINT ck_sales_paid_net CHECK (paid_amount >= 0 AND paid_amount <= total_amount - returned_amount)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_name = 'ck_sales_due_net') = 0,
  'ALTER TABLE sales ADD CONSTRAINT ck_sales_due_net CHECK (due_amount = total_amount - returned_amount - paid_amount)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. sale_returns -------------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sale_returns' AND column_name = 'return_amount') = 0,
  'ALTER TABLE sale_returns ADD COLUMN return_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER return_date', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sale_returns' AND column_name = 'idempotency_key') = 0,
  'ALTER TABLE sale_returns ADD COLUMN idempotency_key CHAR(36) NULL AFTER reason', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'sale_returns' AND index_name = 'uq_sale_returns_idempotency') = 0,
  'ALTER TABLE sale_returns ADD UNIQUE KEY uq_sale_returns_idempotency (idempotency_key)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sale_returns' AND constraint_name = 'ck_sale_returns_amounts') = 0,
  'ALTER TABLE sale_returns ADD CONSTRAINT ck_sale_returns_amounts CHECK (return_amount >= 0 AND total_refund <= return_amount)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. customer advance ledger --------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_advance_movements (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id      BIGINT UNSIGNED NOT NULL,
  movement_type    ENUM('deposit','sale_payment','payment_void','return_credit') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,              -- signed: + in, − out
  balance_after    DECIMAL(12,2) NOT NULL,
  method           ENUM('cash','bkash','nagad','bank_transfer','other') NULL,  -- how a deposit was received
  reference        VARCHAR(60) NULL,
  receipt_no       VARCHAR(20) NULL,                    -- deposits get a receipt
  payment_id       BIGINT UNSIGNED NULL,
  sale_return_id   BIGINT UNSIGNED NULL,
  note             VARCHAR(255) NULL,
  idempotency_key  CHAR(36) NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_advance_receipt (receipt_no),
  UNIQUE KEY uq_advance_idempotency (idempotency_key),
  KEY ix_advance_customer (customer_id, id),
  CONSTRAINT fk_advance_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_advance_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_advance_return FOREIGN KEY (sale_return_id) REFERENCES sale_returns (id),
  CONSTRAINT fk_advance_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_advance_amount CHECK (amount <> 0),
  CONSTRAINT ck_advance_balance CHECK (balance_after >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
