-- SSCTC Shop — initial schema (DATABASE_SCHEMA.md, revision 2026-10-10)
-- MySQL 8.0.16+ (CHECK constraints are enforced). All DATETIME values are UTC.
-- Run through `npm run migrate`, or paste into phpMyAdmin on an empty database.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- 4.1 Access
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id          TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(30)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE role_permissions (
  role_id     TINYINT UNSIGNED NOT NULL,
  permission  VARCHAR(60) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE users (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_id               TINYINT UNSIGNED NOT NULL,
  name                  VARCHAR(120) NOT NULL,
  username              VARCHAR(60)  NOT NULL,
  phone                 VARCHAR(15)  NULL,
  password_hash         VARCHAR(255) NOT NULL,
  status                ENUM('active','blocked') NOT NULL DEFAULT 'active',
  must_change_password  TINYINT(1)   NOT NULL DEFAULT 0,
  locked_until          DATETIME     NULL,
  last_login_at         DATETIME     NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  KEY ix_users_role (role_id),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sessions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  token_hash    CHAR(64)     NOT NULL,
  ip            VARCHAR(45)  NOT NULL,
  user_agent    VARCHAR(255) NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME     NOT NULL,
  revoked_at    DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE login_attempts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identifier  VARCHAR(60) NOT NULL,
  ip          VARCHAR(45) NOT NULL,
  success     TINYINT(1)  NOT NULL,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_login_attempts_identifier (identifier, created_at),
  KEY ix_login_attempts_ip (ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id  BIGINT UNSIGNED NULL,
  action         VARCHAR(60) NOT NULL,
  entity_type    VARCHAR(40) NOT NULL,
  entity_id      BIGINT UNSIGNED NULL,
  old_values     JSON NULL,
  new_values     JSON NULL,
  ip             VARCHAR(45) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_entity (entity_type, entity_id),
  KEY ix_audit_actor (actor_user_id, created_at),
  KEY ix_audit_action (action, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE settings (
  setting_key  VARCHAR(100) NOT NULL,
  value        JSON NOT NULL,
  description  VARCHAR(255) NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.2 Catalog
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id   BIGINT UNSIGNED NULL,
  name        VARCHAR(100) NOT NULL,
  sort_order  INT        NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_parent_name (parent_id, name),
  KEY ix_categories_parent_sort (parent_id, sort_order),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE products (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id          BIGINT UNSIGNED NOT NULL,
  sku                  VARCHAR(50)  NOT NULL,
  name                 VARCHAR(200) NOT NULL,
  brand                VARCHAR(100) NULL,
  unit                 VARCHAR(20)  NOT NULL DEFAULT 'pcs',
  price                DECIMAL(12,2) NOT NULL,
  cost_price           DECIMAL(12,2) NOT NULL DEFAULT 0,
  track_stock          TINYINT(1) NOT NULL DEFAULT 1,
  stock_qty            INT NOT NULL DEFAULT 0,
  low_stock_threshold  INT NOT NULL DEFAULT 5,
  status               ENUM('active','archived') NOT NULL DEFAULT 'active',
  note                 VARCHAR(255) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY ix_products_category_status (category_id, status),
  KEY ix_products_status_name (status, name),
  FULLTEXT KEY ft_products_name_brand (name, brand),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT ck_products_price CHECK (price >= 0),
  CONSTRAINT ck_products_stock CHECK (stock_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE services (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_type    ENUM('print','photocopy','online','other') NOT NULL,
  name            VARCHAR(150) NOT NULL,
  unit            VARCHAR(20)  NOT NULL DEFAULT 'pcs',
  default_price   DECIMAL(12,2) NOT NULL,
  price_editable  TINYINT(1) NOT NULL DEFAULT 1,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_services_name (name),
  KEY ix_services_type_active (service_type, is_active),
  CONSTRAINT ck_services_price CHECK (default_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.3 Inventory
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_movements (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id      BIGINT UNSIGNED NOT NULL,
  movement_type   ENUM('opening','stock_in','purchase','sale','sale_void',
                       'sale_return','adjustment_in','adjustment_out') NOT NULL,
  quantity        INT NOT NULL,
  balance_after   INT NOT NULL,
  unit_cost       DECIMAL(12,2) NULL,
  reference_type  ENUM('sale','purchase','return','manual') NOT NULL,
  reference_id    BIGINT UNSIGNED NULL,
  note            VARCHAR(255) NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_inv_product_created (product_id, created_at),
  KEY ix_inv_reference (reference_type, reference_id),
  KEY ix_inv_type_created (movement_type, created_at),
  CONSTRAINT fk_inv_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_inv_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_inv_quantity CHECK (quantity <> 0),
  CONSTRAINT ck_inv_balance CHECK (balance_after >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.4 Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                  VARCHAR(120) NOT NULL,
  phone                 VARCHAR(15)  NULL,
  address               VARCHAR(255) NULL,
  note                  VARCHAR(255) NULL,
  current_due           DECIMAL(12,2) NOT NULL DEFAULT 0,
  advance_balance       DECIMAL(12,2) NOT NULL DEFAULT 0,
  portal_pin            VARCHAR(10)  NULL,
  portal_password_hash  VARCHAR(255) NULL,
  portal_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  last_portal_login_at  DATETIME NULL,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  created_by            BIGINT UNSIGNED NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_phone (phone),
  KEY ix_customers_name (name),
  KEY ix_customers_due (current_due),
  KEY ix_customers_advance (advance_balance),
  CONSTRAINT fk_customers_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_customers_due CHECK (current_due >= 0),
  CONSTRAINT ck_customers_advance CHECK (advance_balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE customer_sessions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id   BIGINT UNSIGNED NOT NULL,
  token_hash    CHAR(64)     NOT NULL,
  ip            VARCHAR(45)  NOT NULL,
  user_agent    VARCHAR(255) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_sessions_token (token_hash),
  KEY ix_customer_sessions_customer (customer_id),
  KEY ix_customer_sessions_expires (expires_at),
  CONSTRAINT fk_customer_sessions_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.5 Sales
-- ---------------------------------------------------------------------------

CREATE TABLE sales (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no         VARCHAR(20) NOT NULL,
  sale_type          ENUM('sale','opening_due') NOT NULL DEFAULT 'sale',
  customer_id        BIGINT UNSIGNED NULL,
  customer_name      VARCHAR(120) NULL,
  customer_phone     VARCHAR(15)  NULL,
  qr_token           CHAR(32) NULL,
  sale_date          DATETIME NOT NULL,
  status             ENUM('completed','void') NOT NULL DEFAULT 'completed',
  subtotal           DECIMAL(12,2) NOT NULL,
  discount_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount       DECIMAL(12,2) NOT NULL,
  paid_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  unverified_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_amount         DECIMAL(12,2) NOT NULL,
  payment_status     ENUM('unpaid','partial','paid') NOT NULL,
  note               VARCHAR(500) NULL,
  idempotency_key    CHAR(36) NOT NULL,
  void_reason        VARCHAR(255) NULL,
  voided_by          BIGINT UNSIGNED NULL,
  voided_at          DATETIME NULL,
  created_by         BIGINT UNSIGNED NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_invoice (invoice_no),
  UNIQUE KEY uq_sales_qr_token (qr_token),
  UNIQUE KEY uq_sales_idempotency (idempotency_key),
  KEY ix_sales_customer_date (customer_id, sale_date),
  KEY ix_sales_date (sale_date),
  KEY ix_sales_status (status, payment_status, sale_date),
  CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_sales_voided_by FOREIGN KEY (voided_by) REFERENCES users (id),
  CONSTRAINT fk_sales_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_sales_discount CHECK (discount_amount >= 0),
  CONSTRAINT ck_sales_total CHECK (total_amount >= 0),
  CONSTRAINT ck_sales_paid CHECK (paid_amount >= 0 AND paid_amount <= total_amount),
  CONSTRAINT ck_sales_due CHECK (due_amount = total_amount - paid_amount),
  CONSTRAINT ck_sales_due_needs_customer CHECK (status = 'void' OR due_amount = 0 OR customer_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sale_items (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id              BIGINT UNSIGNED NOT NULL,
  item_type            ENUM('product','service') NOT NULL,
  product_id           BIGINT UNSIGNED NULL,
  service_id           BIGINT UNSIGNED NULL,
  name_snapshot        VARCHAR(200) NOT NULL,
  sku_snapshot         VARCHAR(50)  NULL,
  unit_snapshot        VARCHAR(20)  NOT NULL,
  unit_price           DECIMAL(12,2) NOT NULL,
  cost_price_snapshot  DECIMAL(12,2) NULL,
  quantity             INT NOT NULL,
  warranty             VARCHAR(50)  NULL,
  serial_no            VARCHAR(100) NULL,
  line_total           DECIMAL(12,2) NOT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_sale_items_sale (sale_id),
  KEY ix_sale_items_product (product_id),
  KEY ix_sale_items_service (service_id),
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales (id),
  CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_sale_items_service FOREIGN KEY (service_id) REFERENCES services (id),
  CONSTRAINT ck_sale_items_price CHECK (unit_price >= 0),
  CONSTRAINT ck_sale_items_qty CHECK (quantity > 0),
  CONSTRAINT ck_sale_items_type CHECK (
       (item_type = 'product' AND product_id IS NOT NULL AND service_id IS NULL)
    OR (item_type = 'service' AND service_id IS NOT NULL AND product_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.6 Payments
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  receipt_no       VARCHAR(20) NOT NULL,
  customer_id      BIGINT UNSIGNED NULL,
  payment_date     DATETIME NOT NULL,
  method           ENUM('cash','bkash','nagad','bank_transfer','customer_advance','other') NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,
  reference        VARCHAR(60) NULL,
  is_verified      TINYINT(1) NOT NULL DEFAULT 0,
  verified_by      BIGINT UNSIGNED NULL,
  verified_at      DATETIME NULL,
  status           ENUM('active','void') NOT NULL DEFAULT 'active',
  void_reason      VARCHAR(255) NULL,
  voided_by        BIGINT UNSIGNED NULL,
  voided_at        DATETIME NULL,
  note             VARCHAR(255) NULL,
  idempotency_key  CHAR(36) NOT NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- A bKash/Nagad transaction ID may appear once among active payments.
  active_ref_key   VARCHAR(70) GENERATED ALWAYS AS (
    CASE WHEN status = 'active' AND reference IS NOT NULL AND method IN ('bkash','nagad')
         THEN CONCAT(method, ':', reference) END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_receipt (receipt_no),
  UNIQUE KEY uq_payments_idempotency (idempotency_key),
  UNIQUE KEY uq_payments_active_ref (active_ref_key),
  KEY ix_payments_customer_date (customer_id, payment_date),
  KEY ix_payments_date (payment_date),
  KEY ix_payments_method_date (method, payment_date),
  KEY ix_payments_verified (is_verified, status, payment_date),
  CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_payments_verified_by FOREIGN KEY (verified_by) REFERENCES users (id),
  CONSTRAINT fk_payments_voided_by FOREIGN KEY (voided_by) REFERENCES users (id),
  CONSTRAINT fk_payments_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_payments_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payment_allocations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id  BIGINT UNSIGNED NOT NULL,
  sale_id     BIGINT UNSIGNED NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alloc_payment_sale (payment_id, sale_id),
  KEY ix_alloc_sale (sale_id),
  CONSTRAINT fk_alloc_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_alloc_sale FOREIGN KEY (sale_id) REFERENCES sales (id),
  CONSTRAINT ck_alloc_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.7 Suppliers and purchases
-- ---------------------------------------------------------------------------

CREATE TABLE suppliers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name             VARCHAR(120) NOT NULL,
  company          VARCHAR(150) NULL,
  phone            VARCHAR(15)  NULL,
  address          VARCHAR(255) NULL,
  note             VARCHAR(255) NULL,
  current_payable  DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_suppliers_name (name),
  KEY ix_suppliers_payable (current_payable),
  CONSTRAINT fk_suppliers_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_suppliers_payable CHECK (current_payable >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE purchases (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_no       VARCHAR(20) NOT NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  purchase_date     DATETIME NOT NULL,
  supplier_memo_no  VARCHAR(60) NULL,
  total_amount      DECIMAL(12,2) NOT NULL,
  paid_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_amount        DECIMAL(12,2) NOT NULL,
  payment_status    ENUM('unpaid','partial','paid') NOT NULL,
  note              VARCHAR(500) NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchases_no (purchase_no),
  KEY ix_purchases_supplier_date (supplier_id, purchase_date),
  KEY ix_purchases_date (purchase_date),
  CONSTRAINT fk_purchases_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_purchases_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_purchases_total CHECK (total_amount >= 0),
  CONSTRAINT ck_purchases_paid CHECK (paid_amount >= 0 AND paid_amount <= total_amount),
  CONSTRAINT ck_purchases_due CHECK (due_amount = total_amount - paid_amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE purchase_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_id  BIGINT UNSIGNED NOT NULL,
  product_id   BIGINT UNSIGNED NOT NULL,
  quantity     INT NOT NULL,
  unit_cost    DECIMAL(12,2) NOT NULL,
  line_total   DECIMAL(12,2) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_purchase_items_purchase (purchase_id),
  KEY ix_purchase_items_product (product_id),
  CONSTRAINT fk_purchase_items_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id),
  CONSTRAINT fk_purchase_items_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT ck_purchase_items_qty CHECK (quantity > 0),
  CONSTRAINT ck_purchase_items_cost CHECK (unit_cost >= 0),
  CONSTRAINT ck_purchase_items_total CHECK (line_total >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE supplier_payments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voucher_no    VARCHAR(20) NOT NULL,
  supplier_id   BIGINT UNSIGNED NOT NULL,
  purchase_id   BIGINT UNSIGNED NULL,
  payment_date  DATETIME NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  method        ENUM('cash','bkash','nagad','bank_transfer','other') NOT NULL DEFAULT 'cash',
  reference     VARCHAR(60)  NULL,
  note          VARCHAR(255) NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_payments_voucher (voucher_no),
  KEY ix_supplier_payments_supplier_date (supplier_id, payment_date),
  KEY ix_supplier_payments_date (payment_date),
  CONSTRAINT fk_supplier_payments_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_supplier_payments_purchase FOREIGN KEY (purchase_id) REFERENCES purchases (id),
  CONSTRAINT fk_supplier_payments_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_supplier_payments_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.8 Expenses and cash drawer
-- ---------------------------------------------------------------------------

CREATE TABLE expense_categories (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE expenses (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  voucher_no      VARCHAR(20) NOT NULL,
  category_id     BIGINT UNSIGNED NOT NULL,
  expense_date    DATETIME NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  payment_method  ENUM('cash','bkash','nagad','bank_transfer','other') NOT NULL DEFAULT 'cash',
  title           VARCHAR(200) NOT NULL,
  note            VARCHAR(500) NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expenses_voucher (voucher_no),
  KEY ix_expenses_category_date (category_id, expense_date),
  KEY ix_expenses_date (expense_date),
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories (id),
  CONSTRAINT fk_expenses_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_expenses_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE daily_cash_closings (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  closing_date           DATE NOT NULL,
  opening_cash           DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_sales             DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_dues_collected    DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_expenses          DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_supplier_paid     DECIMAL(12,2) NOT NULL DEFAULT 0,
  expected_closing_cash  DECIMAL(12,2) NOT NULL,
  actual_closing_cash    DECIMAL(12,2) NOT NULL,
  difference             DECIMAL(12,2) NOT NULL,
  note                   VARCHAR(500) NULL,
  closed_by              BIGINT UNSIGNED NOT NULL,
  closed_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_closings_date (closing_date),
  CONSTRAINT fk_cash_closings_user FOREIGN KEY (closed_by) REFERENCES users (id),
  CONSTRAINT ck_cash_opening CHECK (opening_cash >= 0),
  CONSTRAINT ck_cash_sales CHECK (cash_sales >= 0),
  CONSTRAINT ck_cash_dues CHECK (cash_dues_collected >= 0),
  CONSTRAINT ck_cash_expenses CHECK (cash_expenses >= 0),
  CONSTRAINT ck_cash_supplier CHECK (cash_supplier_paid >= 0),
  CONSTRAINT ck_cash_actual CHECK (actual_closing_cash >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.9 Sale returns
-- ---------------------------------------------------------------------------

CREATE TABLE sale_returns (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_no      VARCHAR(20) NOT NULL,
  sale_id        BIGINT UNSIGNED NOT NULL,
  customer_id    BIGINT UNSIGNED NULL,
  return_date    DATETIME NOT NULL,
  total_refund   DECIMAL(12,2) NOT NULL,
  refund_method  ENUM('cash','advance_credit') NOT NULL DEFAULT 'cash',
  reason         VARCHAR(255) NOT NULL,
  created_by     BIGINT UNSIGNED NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sale_returns_no (return_no),
  KEY ix_sale_returns_sale (sale_id),
  KEY ix_sale_returns_customer_date (customer_id, return_date),
  CONSTRAINT fk_sale_returns_sale FOREIGN KEY (sale_id) REFERENCES sales (id),
  CONSTRAINT fk_sale_returns_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_sale_returns_user FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT ck_sale_returns_refund CHECK (total_refund >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sale_return_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id     BIGINT UNSIGNED NOT NULL,
  sale_item_id  BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  quantity      INT NOT NULL,
  unit_price    DECIMAL(12,2) NOT NULL,
  line_total    DECIMAL(12,2) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_return_items_return (return_id),
  KEY ix_return_items_product (product_id),
  CONSTRAINT fk_return_items_return FOREIGN KEY (return_id) REFERENCES sale_returns (id),
  CONSTRAINT fk_return_items_sale_item FOREIGN KEY (sale_item_id) REFERENCES sale_items (id),
  CONSTRAINT fk_return_items_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT ck_return_items_qty CHECK (quantity > 0),
  CONSTRAINT ck_return_items_price CHECK (unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- 4.10 Numbering
-- ---------------------------------------------------------------------------

CREATE TABLE document_counters (
  doc_type     VARCHAR(25) NOT NULL,
  last_number  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
