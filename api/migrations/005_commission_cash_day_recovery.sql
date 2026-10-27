-- SSCTC Shop — staff commission, the cash day, Owner recovery codes.
--
-- 1. Commission rates: on services, and on product categories (a product earns
--    at its category's rate; a sub-category without its own rate uses its
--    parent's). NULL = no rate set.
-- 2. users.commission_enabled: who earns commission on the sales they record.
-- 3. sale_items.commission_amount: what each line earned, fixed at the sale.
-- 4. commission_payouts and staff_commission_entries: the ledger behind every
--    staff member's commission balance, as customer_advance_movements is for
--    the advance balance.
-- 5. daily_cash_openings: the morning count. Nothing that moves money can be
--    recorded until the day is opened, and nothing after it is closed.
-- 6. daily_cash_closings: the opening it closes, and cash paid out as
--    commission. owner_cash_receipts: cash the Owner takes from the drawer
--    after a closing; cash_withdrawn on the closing is their running total.
-- 7. owner_recovery_codes: one-time codes for an Owner who forgot the password.
-- 8. Permissions: commission, the cash day, and the opening due (Owner only).
--
-- Every change checks information_schema first, so the file can be run more
-- than once, through `npm run migrate` or pasted into phpMyAdmin.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- 1. commission rates ---------------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'services' AND column_name = 'commission_type') = 0,
  'ALTER TABLE services
     ADD COLUMN commission_type ENUM(''percent'',''fixed'') NULL AFTER price_editable,
     ADD COLUMN commission_value DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER commission_type,
     ADD CONSTRAINT ck_services_commission CHECK (commission_value >= 0 AND (commission_type IS NULL OR commission_type <> ''percent'' OR commission_value <= 100))', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'categories' AND column_name = 'commission_type') = 0,
  'ALTER TABLE categories
     ADD COLUMN commission_type ENUM(''percent'',''fixed'') NULL AFTER sort_order,
     ADD COLUMN commission_value DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER commission_type,
     ADD CONSTRAINT ck_categories_commission CHECK (commission_value >= 0 AND (commission_type IS NULL OR commission_type <> ''percent'' OR commission_value <= 100))', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. who earns ----------------------------------------------------------------
-- Existing Staff accounts earn from now on; the Owner does not.

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'commission_enabled') = 0,
  'ALTER TABLE users ADD COLUMN commission_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER must_change_password', 'DO 0');
SET @first_time = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'commission_enabled') = 0;
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @dml = IF(@first_time, 'UPDATE users SET commission_enabled = 1 WHERE role_id = 2', 'DO 0');
PREPARE stmt FROM @dml; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. what each line earned ----------------------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sale_items' AND column_name = 'commission_amount') = 0,
  'ALTER TABLE sale_items
     ADD COLUMN commission_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER line_total,
     ADD CONSTRAINT ck_sale_items_commission CHECK (commission_amount >= 0)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. commission ledger --------------------------------------------------------

CREATE TABLE IF NOT EXISTS commission_payouts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,                 -- who was paid
  amount           DECIMAL(12,2) NOT NULL,
  method           ENUM('cash','bkash','nagad','bank_transfer','other') NOT NULL DEFAULT 'cash',
  note             VARCHAR(255) NULL,
  status           ENUM('active','void') NOT NULL DEFAULT 'active',
  void_reason      VARCHAR(255) NULL,
  voided_by        BIGINT UNSIGNED NULL,
  voided_at        DATETIME NULL,
  idempotency_key  CHAR(36) NULL,
  paid_by          BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_commission_payouts_idempotency (idempotency_key),
  KEY ix_commission_payouts_user (user_id, id),
  KEY ix_commission_payouts_created (created_at),
  CONSTRAINT fk_commission_payouts_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_commission_payouts_paid_by FOREIGN KEY (paid_by) REFERENCES users (id),
  CONSTRAINT fk_commission_payouts_voided_by FOREIGN KEY (voided_by) REFERENCES users (id),
  CONSTRAINT ck_commission_payouts_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS staff_commission_entries (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,                 -- whose balance
  entry_type       ENUM('sale','sale_void','sale_return','payout','payout_void') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,                   -- signed: + earned, − taken back or paid
  sale_id          BIGINT UNSIGNED NULL,
  sale_return_id   BIGINT UNSIGNED NULL,
  payout_id        BIGINT UNSIGNED NULL,
  note             VARCHAR(255) NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_commission_user (user_id, id),
  KEY ix_commission_sale (sale_id),
  KEY ix_commission_created (created_at),
  CONSTRAINT fk_commission_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_commission_sale FOREIGN KEY (sale_id) REFERENCES sales (id),
  CONSTRAINT fk_commission_return FOREIGN KEY (sale_return_id) REFERENCES sale_returns (id),
  CONSTRAINT fk_commission_payout FOREIGN KEY (payout_id) REFERENCES commission_payouts (id),
  CONSTRAINT fk_commission_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_commission_amount CHECK (amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 5. the morning count --------------------------------------------------------
-- previous_closing_id is the closing this day follows (NULL for the very first
-- day). It is unique, so a closing is followed by one opening only.

CREATE TABLE IF NOT EXISTS daily_cash_openings (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  opening_date         DATE NOT NULL,
  previous_closing_id  BIGINT UNSIGNED NULL,
  carried_cash         DECIMAL(12,2) NULL,                   -- left in the drawer by the last closing; NULL the first time
  counted_cash         DECIMAL(12,2) NOT NULL,
  difference           DECIMAL(12,2) NULL,                   -- counted − carried
  note                 VARCHAR(500) NULL,
  opened_by            BIGINT UNSIGNED NOT NULL,
  opened_at            DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_openings_date (opening_date),
  UNIQUE KEY uq_cash_openings_previous (previous_closing_id),
  CONSTRAINT fk_cash_openings_previous FOREIGN KEY (previous_closing_id) REFERENCES daily_cash_closings (id),
  CONSTRAINT fk_cash_openings_user FOREIGN KEY (opened_by) REFERENCES users (id),
  CONSTRAINT ck_cash_openings_counted CHECK (counted_cash >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 6. closings and the Owner's receipts ----------------------------------------

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'daily_cash_closings' AND column_name = 'opening_id') = 0,
  'ALTER TABLE daily_cash_closings
     ADD COLUMN opening_id BIGINT UNSIGNED NULL AFTER period_start,
     ADD COLUMN cash_commission_paid DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER cash_refunds,
     ADD UNIQUE KEY uq_cash_closings_opening (opening_id),
     ADD CONSTRAINT fk_cash_closings_opening FOREIGN KEY (opening_id) REFERENCES daily_cash_openings (id),
     ADD CONSTRAINT ck_cash_commission_paid CHECK (cash_commission_paid >= 0)', 'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS owner_cash_receipts (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  closing_id   BIGINT UNSIGNED NOT NULL,
  amount       DECIMAL(12,2) NOT NULL,
  note         VARCHAR(255) NULL,
  received_by  BIGINT UNSIGNED NOT NULL,
  received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_owner_cash_receipts_closing (closing_id),
  CONSTRAINT fk_owner_cash_receipts_closing FOREIGN KEY (closing_id) REFERENCES daily_cash_closings (id),
  CONSTRAINT fk_owner_cash_receipts_user FOREIGN KEY (received_by) REFERENCES users (id),
  CONSTRAINT ck_owner_cash_receipts_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 7. Owner recovery codes -----------------------------------------------------
-- Only the hash is stored. A used code is kept, marked, so it never works twice.

CREATE TABLE IF NOT EXISTS owner_recovery_codes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_code_hash (code_hash),
  KEY ix_recovery_user (user_id),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 8. permissions --------------------------------------------------------------
-- Staff now count the drawer in the morning and hand it over at night.

INSERT IGNORE INTO role_permissions (role_id, permission) VALUES
  (1, 'customers.opening_due'),
  (1, 'commission.manage'),
  (1, 'cash.open'),           (1, 'cash.receive'),
  (2, 'commission.view_own'),
  (2, 'cash.open'),           (2, 'cash.close');
