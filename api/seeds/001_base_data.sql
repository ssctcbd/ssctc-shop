-- SSCTC Shop — base data. Safe to run repeatedly.
-- The first Owner account is created by `npm run seed` (scripts/seed.js), because
-- its password must be hashed and is never stored in a file.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- Roles ----------------------------------------------------------------------

INSERT INTO roles (id, code, name) VALUES
  (1, 'owner', 'Owner'),
  (2, 'staff', 'Staff')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Permissions (PROJECT_PLAN.md §4.13, Decision D4) ----------------------------
-- Owner: everything. Staff: sell, record payments, view stock, record expenses.

INSERT IGNORE INTO role_permissions (role_id, permission) VALUES
  (1, 'dashboard.view'),
  (1, 'catalog.view'),        (1, 'catalog.manage'),     (1, 'catalog.edit_price'),
  (1, 'inventory.view'),      (1, 'inventory.adjust'),
  (1, 'customers.view'),      (1, 'customers.manage'),   (1, 'customers.reset_pin'),
  (1, 'sales.view'),          (1, 'sales.create'),       (1, 'sales.void'),
  (1, 'sales.edit_price'),    (1, 'sales.backdate'),     (1, 'sales.return'),
  (1, 'payments.view'),       (1, 'payments.create'),    (1, 'payments.verify'),
  (1, 'payments.void'),
  (1, 'suppliers.view'),      (1, 'suppliers.manage'),   (1, 'purchases.manage'),
  (1, 'expenses.view'),       (1, 'expenses.create'),    (1, 'expenses.manage'),
  (1, 'cash.view'),           (1, 'cash.close'),
  (1, 'reports.view'),        (1, 'reports.financial'),
  (1, 'users.manage'),        (1, 'settings.manage'),    (1, 'audit.view'),
  (1, 'system.backup'),

  (2, 'dashboard.view'),
  (2, 'catalog.view'),
  (2, 'inventory.view'),
  (2, 'customers.view'),      (2, 'customers.manage'),
  (2, 'sales.view'),          (2, 'sales.create'),
  (2, 'payments.view'),       (2, 'payments.create'),
  (2, 'expenses.view'),       (2, 'expenses.create'),
  (2, 'cash.view');

-- Settings -------------------------------------------------------------------
-- INSERT IGNORE: values the Owner has already changed are never overwritten.

INSERT IGNORE INTO settings (setting_key, value, description) VALUES
  ('shop.name',              '"SS Computer Training Centre"', 'Shop name on screens, invoices and receipts'),
  ('shop.tagline',           '"Computer, Printing, Photocopy & Online Services"', 'Line under the shop name'),
  ('shop.address',           '"Baunia, Kalibari, Dhaka"', 'Address on invoices'),
  ('shop.phone',             '""', 'Phone number on invoices'),
  ('shop.email',             '""', 'Email on invoices'),
  ('shop.logo_url',          '"/brand/ssctc-logo.png"', 'Logo used on the navbar and invoice header'),
  ('shop.favicon_url',       '"/brand/favicon.svg"', 'Browser tab icon'),
  ('shop.currency_symbol',   '"৳"', 'Currency symbol'),
  ('shop.timezone',          '"Asia/Dhaka"', 'Time zone used to display dates'),
  ('invoice.footer',         '"Thank you for your business."', 'Footer text on invoices and receipts'),
  ('invoice.default_layout', '"a4"', 'a4 | thermal80 | thermal58'),
  ('payment.bkash_number',   '""', 'bKash number printed on invoices'),
  ('payment.nagad_number',   '""', 'Nagad number printed on invoices'),
  ('portal.enabled',         'true', 'Customer portal on/off');

-- Expense categories ---------------------------------------------------------

INSERT IGNORE INTO expense_categories (name) VALUES
  ('Rent'), ('Electricity'), ('Internet'), ('Paper/Toner'),
  ('Tea/Snacks'), ('Salary'), ('Other');

-- Document counters ----------------------------------------------------------

INSERT IGNORE INTO document_counters (doc_type, last_number) VALUES
  ('invoice', 0), ('receipt', 0), ('purchase', 0),
  ('supplier_payment', 0), ('expense', 0), ('return', 0);
