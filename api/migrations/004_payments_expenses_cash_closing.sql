-- SSCTC Shop — due collection, supplier payments, expenses and cash closing.
--
-- 1. payments.kind: taken with a sale, or collected later against a due.
-- 2. supplier_payments: void fields and an idempotency key;
--    supplier_payment_allocations: how a payment is split across purchase
--    bills, exactly as payment_allocations does for sales. Payments entered
--    with a bill before this migration get their allocation row here.
-- 3. expenses: void fields and an idempotency key.
-- 4. customer_advance_movements: a 'refund' movement (advance paid back in cash).
-- 5. daily_cash_closings: the period each closing covers and the cash figures
--    that did not exist when the table was designed.
-- 6. document_counters: the 'cash_drawer' row every cash transaction locks.
--
-- Every change checks information_schema first, so the file can be run more
-- than once, through `npm run migrate` or pasted into phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- 1. payments -----------------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payments' AND column_name = 'kind') = 0,
  'ALTER TABLE payments ADD COLUMN kind ENUM(''sale'',''due_collection'') NOT NULL DEFAULT ''sale'' AFTER method', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. supplier payments --------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'supplier_payments' AND column_name = 'status') = 0,
  'ALTER TABLE supplier_payments
     ADD COLUMN status ENUM(''active'',''void'') NOT NULL DEFAULT ''active'' AFTER note,
     ADD COLUMN void_reason VARCHAR(255) NULL AFTER status,
     ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER void_reason,
     ADD COLUMN voided_at DATETIME NULL AFTER voided_by,
     ADD COLUMN idempotency_key CHAR(36) NULL AFTER voided_at,
     ADD UNIQUE KEY uq_supplier_payments_idempotency (idempotency_key),
     ADD CONSTRAINT fk_supplier_payments_voided_by FOREIGN KEY (voided_by) REFERENCES users (id)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id   BIGINT UNSIGNED NOT NULL,
  purchase_id  BIGINT UNSIGNED NOT NULL,
  amount       DECIMAL(12,2) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sp_alloc_payment_purchase (payment_id, purchase_id),
  KEY ix_sp_alloc_purchase (purchase_id),
  CONSTRAINT fk_sp_alloc_payment FOREIGN KEY (payment_id) REFERENCES supplier_payments (id),
  CONSTRAINT fk_sp_alloc_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id),
  CONSTRAINT ck_sp_alloc_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Payments entered together with a bill, before allocations existed.
INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount)
SELECT sp.id, sp.purchase_id, sp.amount
  FROM supplier_payments sp
 WHERE sp.purchase_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocations a WHERE a.payment_id = sp.id);

-- 3. expenses -----------------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'expenses' AND column_name = 'status') = 0,
  'ALTER TABLE expenses
     ADD COLUMN status ENUM(''active'',''void'') NOT NULL DEFAULT ''active'' AFTER note,
     ADD COLUMN void_reason VARCHAR(255) NULL AFTER status,
     ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER void_reason,
     ADD COLUMN voided_at DATETIME NULL AFTER voided_by,
     ADD COLUMN idempotency_key CHAR(36) NULL AFTER voided_at,
     ADD UNIQUE KEY uq_expenses_idempotency (idempotency_key),
     ADD CONSTRAINT fk_expenses_voided_by FOREIGN KEY (voided_by) REFERENCES users (id)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. customer advance: money paid back out ------------------------------------

ALTER TABLE customer_advance_movements
  MODIFY COLUMN movement_type ENUM('deposit','sale_payment','payment_void','return_credit','refund') NOT NULL;

-- 5. cash closings ------------------------------------------------------------
-- A closing covers everything recorded from the previous closing up to
-- closed_at, whatever date was written on the document: the drawer holds the
-- cash that actually moved in that time.

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'daily_cash_closings' AND column_name = 'period_start') = 0,
  'ALTER TABLE daily_cash_closings
     ADD COLUMN period_start DATETIME NULL AFTER closing_date,
     ADD COLUMN cash_advance_deposits DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cash_dues_collected,
     ADD COLUMN cash_voids_in DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cash_advance_deposits,
     ADD COLUMN cash_refunds DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cash_supplier_paid,
     ADD COLUMN cash_withdrawn DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER difference,
     ADD CONSTRAINT ck_cash_new_figures CHECK (cash_advance_deposits >= 0 AND cash_voids_in >= 0 AND cash_refunds >= 0),
     ADD CONSTRAINT ck_cash_withdrawn CHECK (cash_withdrawn >= 0 AND cash_withdrawn <= actual_closing_cash)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. the cash drawer lock -----------------------------------------------------
-- Not a document number. Every transaction that moves money locks this row
-- first, so a cash closing never runs half-way through one of them.

INSERT IGNORE INTO document_counters (doc_type, last_number) VALUES ('cash_drawer', 0);
