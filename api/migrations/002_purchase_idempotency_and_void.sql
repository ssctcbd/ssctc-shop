-- SSCTC Shop — purchases: duplicate-submission guard and void.
--
-- Adds to `purchases`:
--   idempotency_key  UUID sent by the purchase form; a repeated save returns the first bill
--   status           'active' | 'void'
--   void_reason, voided_by, voided_at
--
-- MySQL 8.0 has no "ADD COLUMN IF NOT EXISTS", so each change first checks
-- information_schema and runs only when it is missing. The file is therefore
-- safe to run more than once, through `npm run migrate` or pasted into phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- idempotency_key -------------------------------------------------------------
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'idempotency_key') = 0,
  'ALTER TABLE purchases ADD COLUMN idempotency_key CHAR(36) NULL AFTER note',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND index_name = 'uq_purchases_idempotency') = 0,
  'ALTER TABLE purchases ADD UNIQUE KEY uq_purchases_idempotency (idempotency_key)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- status ----------------------------------------------------------------------
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'status') = 0,
  'ALTER TABLE purchases ADD COLUMN status ENUM(''active'',''void'') NOT NULL DEFAULT ''active'' AFTER payment_status',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- void_reason -----------------------------------------------------------------
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'void_reason') = 0,
  'ALTER TABLE purchases ADD COLUMN void_reason VARCHAR(255) NULL AFTER idempotency_key',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- voided_by -------------------------------------------------------------------
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'voided_by') = 0,
  'ALTER TABLE purchases ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER void_reason',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'purchases' AND constraint_name = 'fk_purchases_voided_by') = 0,
  'ALTER TABLE purchases ADD CONSTRAINT fk_purchases_voided_by FOREIGN KEY (voided_by) REFERENCES users (id)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- voided_at -------------------------------------------------------------------
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'voided_at') = 0,
  'ALTER TABLE purchases ADD COLUMN voided_at DATETIME NULL AFTER voided_by',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Lists and the payable sum filter on status.
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'purchases' AND index_name = 'ix_purchases_supplier_status') = 0,
  'ALTER TABLE purchases ADD KEY ix_purchases_supplier_status (supplier_id, status)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
