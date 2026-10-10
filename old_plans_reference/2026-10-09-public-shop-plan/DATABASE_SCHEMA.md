# SSCTC Shop — Database Schema

Design document for MySQL 8.0.46. This is a specification, not a migration; the
migration files are written in Milestone 1 after approval.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for scope and [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) for backups.

## 1. Conventions

| Topic | Rule |
|---|---|
| Engine / charset | InnoDB, `utf8mb4`, collation `utf8mb4_0900_ai_ci` (Bangla and English text) |
| Primary keys | `id BIGINT UNSIGNED AUTO_INCREMENT` unless stated |
| Money | `DECIMAL(12,2)`, BDT. Never floating point |
| Time | `DATETIME` stored in UTC; shown in Asia/Dhaka (UTC+6) by the application |
| Timestamps | `created_at` on every table; `updated_at` on every table whose rows change |
| Deletion | Business records are never hard-deleted; they are archived, cancelled or deactivated by a status column |
| Foreign keys | `ON DELETE RESTRICT` unless stated |
| Snapshots | Order tables copy names and prices at order time and never read them back from catalog tables |
| CHECK constraints | Enforced by MySQL from 8.0.16, so they are real guards here |

Notation: `PK` primary key, `FK → table` foreign key, `UQ` unique, `IX` index,
`NN` not null. Columns are `NN` unless marked `NULL`.

## 2. Relationships

```
roles ─< role_permissions
roles ─< users ─< sessions
                users ─< orders ─< order_items ─1 print_jobs ─< print_job_extras
                                   order_items >─ products / service_rates
                         orders ─< payments
                         orders ─< order_status_history
                         orders ─< notifications
                users ─< uploaded_files >─ order_items

categories ─< categories (parent)
categories ─< products ─< product_images
              products ─< inventory_movements
suppliers ─< purchases ─< purchase_items >─ products

services ─< service_rates
services ─< print_rates >─ paper_sizes
print_extras ─< print_job_extras

expense_categories ─< expenses
```

## 3. Tables

### 3.1 Access

```
roles
  id              TINYINT UNSIGNED  PK
  code            VARCHAR(30)       UQ            owner | manager | staff | customer
  name            VARCHAR(60)
  is_staff        TINYINT(1)        default 0
  created_at      DATETIME

role_permissions
  role_id         TINYINT UNSIGNED  FK → roles (CASCADE)
  permission      VARCHAR(60)                     e.g. orders.update, payments.verify,
                                                  files.download, inventory.adjust
  PK (role_id, permission)

users
  id              BIGINT UNSIGNED   PK
  role_id         TINYINT UNSIGNED  FK → roles
  name            VARCHAR(120)
  phone           VARCHAR(15)       UQ            normalised to 01XXXXXXXXX
  email           VARCHAR(190)      UQ, NULL
  password_hash   VARCHAR(255)
  status          ENUM('active','blocked')        default 'active'
  must_change_password TINYINT(1)   default 0     set after a staff-issued reset
  locked_until    DATETIME          NULL
  last_login_at   DATETIME          NULL
  created_at, updated_at
  IX (role_id)

sessions
  id              BIGINT UNSIGNED   PK
  user_id         BIGINT UNSIGNED   FK → users (CASCADE)
  token_hash      CHAR(64)          UQ            SHA-256 of the cookie value
  ip              VARCHAR(45)
  user_agent      VARCHAR(255)
  created_at      DATETIME
  last_seen_at    DATETIME
  expires_at      DATETIME
  revoked_at      DATETIME          NULL
  IX (user_id), IX (expires_at)

login_attempts
  id              BIGINT UNSIGNED   PK
  identifier      VARCHAR(190)                    phone as typed, normalised
  ip              VARCHAR(45)
  success         TINYINT(1)
  created_at      DATETIME
  IX (identifier, created_at), IX (ip, created_at)

audit_logs                                        append-only
  id              BIGINT UNSIGNED   PK
  actor_user_id   BIGINT UNSIGNED   FK → users, NULL (system / cron)
  action          VARCHAR(60)                     e.g. payment.verify, rate.update
  entity_type     VARCHAR(40)
  entity_id       BIGINT UNSIGNED   NULL
  old_values      JSON              NULL
  new_values      JSON              NULL
  ip              VARCHAR(45)       NULL
  created_at      DATETIME
  IX (entity_type, entity_id), IX (actor_user_id, created_at), IX (action, created_at)
```

### 3.2 Catalog

```
categories
  id              BIGINT UNSIGNED   PK
  parent_id       BIGINT UNSIGNED   FK → categories, NULL
  name            VARCHAR(100)
  slug            VARCHAR(120)      UQ
  sort_order      INT               default 0
  is_active       TINYINT(1)        default 1
  created_at, updated_at
  IX (parent_id, sort_order)

products
  id              BIGINT UNSIGNED   PK
  category_id     BIGINT UNSIGNED   FK → categories
  sku             VARCHAR(50)       UQ
  name            VARCHAR(200)
  slug            VARCHAR(220)      UQ
  description     TEXT              NULL
  brand           VARCHAR(100)      NULL
  unit            VARCHAR(20)       default 'pcs'
  price           DECIMAL(12,2)     CHECK (price >= 0)
  compare_at_price DECIMAL(12,2)    NULL          the "was" price
  cost_price      DECIMAL(12,2)     default 0     latest purchase cost
  track_stock     TINYINT(1)        default 1
  stock_qty       INT               default 0, CHECK (stock_qty >= 0)
  low_stock_threshold INT           default 5
  status          ENUM('draft','active','archived')  default 'draft'
  is_featured     TINYINT(1)        default 0
  created_at, updated_at
  IX (category_id, status), IX (status, is_featured)
  FULLTEXT (name, brand, description)

product_images
  id              BIGINT UNSIGNED   PK
  product_id      BIGINT UNSIGNED   FK → products (CASCADE)
  file_path       VARCHAR(255)                    relative path in the public media folder
  alt_text        VARCHAR(200)      NULL
  sort_order      INT               default 0
  is_primary      TINYINT(1)        default 0
  created_at      DATETIME
  IX (product_id, sort_order)
```

Product images are public by nature and live in a public media folder. They are the
only uploaded files that do.

### 3.3 Inventory and purchasing

```
inventory_movements                               append-only ledger
  id              BIGINT UNSIGNED   PK
  product_id      BIGINT UNSIGNED   FK → products
  movement_type   ENUM('opening','purchase','sale','order_cancel',
                       'adjustment_in','adjustment_out','return_in')
  quantity        INT               CHECK (quantity <> 0)   + in, − out
  balance_after   INT               CHECK (balance_after >= 0)
  unit_cost       DECIMAL(12,2)     NULL
  reference_type  ENUM('order','purchase','manual')
  reference_id    BIGINT UNSIGNED   NULL
  note            VARCHAR(255)      NULL          required for manual adjustments
  created_by      BIGINT UNSIGNED   FK → users, NULL
  created_at      DATETIME
  IX (product_id, created_at), IX (reference_type, reference_id)

suppliers                                         phase 2 screens
  id              BIGINT UNSIGNED   PK
  name            VARCHAR(150)
  phone           VARCHAR(15)       NULL
  email           VARCHAR(190)      NULL
  address         VARCHAR(255)      NULL
  note            VARCHAR(255)      NULL
  is_active       TINYINT(1)        default 1
  created_at, updated_at
  IX (name)

purchases                                         phase 2 screens
  id              BIGINT UNSIGNED   PK
  purchase_no     VARCHAR(20)       UQ
  supplier_id     BIGINT UNSIGNED   FK → suppliers
  purchase_date   DATE
  status          ENUM('draft','received','cancelled')   default 'draft'
  subtotal        DECIMAL(12,2)
  discount_amount DECIMAL(12,2)     default 0
  total_amount    DECIMAL(12,2)
  paid_amount     DECIMAL(12,2)     default 0
  payment_status  ENUM('unpaid','partial','paid')        default 'unpaid'
  note            VARCHAR(255)      NULL
  created_by      BIGINT UNSIGNED   FK → users
  received_at     DATETIME          NULL
  created_at, updated_at
  IX (supplier_id, purchase_date), IX (status)

purchase_items
  id              BIGINT UNSIGNED   PK
  purchase_id     BIGINT UNSIGNED   FK → purchases (CASCADE)
  product_id      BIGINT UNSIGNED   FK → products
  quantity        INT               CHECK (quantity > 0)
  unit_cost       DECIMAL(12,2)     CHECK (unit_cost >= 0)
  line_total      DECIMAL(12,2)
  UQ (purchase_id, product_id)
```

Stock is added when a purchase moves from `draft` to `received`, never before.

### 3.4 Services and rates

```
services
  id              BIGINT UNSIGNED   PK
  service_type    ENUM('print','photocopy','online','other')
  name            VARCHAR(150)
  slug            VARCHAR(170)      UQ
  description     TEXT              NULL
  pricing_mode    ENUM('print_matrix','fixed','starting_from','quote')
  min_charge      DECIMAL(12,2)     NULL          used by print_matrix services
  requires_file   TINYINT(1)        default 0
  is_active       TINYINT(1)        default 1
  sort_order      INT               default 0
  created_at, updated_at
  IX (service_type, is_active)

service_rates                                     online / other services
  id              BIGINT UNSIGNED   PK
  service_id      BIGINT UNSIGNED   FK → services
  name            VARCHAR(150)                    e.g. "New application", "Correction"
  service_charge  DECIMAL(12,2)     CHECK (service_charge >= 0)
  extra_fee_note  VARCHAR(255)      NULL          e.g. "Government fee payable separately"
  is_active       TINYINT(1)        default 1
  sort_order      INT               default 0
  created_at, updated_at
  IX (service_id, is_active)

paper_sizes
  id              SMALLINT UNSIGNED PK
  code            VARCHAR(10)       UQ            A4, A3, LEGAL, LETTER
  name            VARCHAR(40)
  is_active       TINYINT(1)        default 1
  sort_order      INT               default 0

print_rates
  id              BIGINT UNSIGNED   PK
  service_id      BIGINT UNSIGNED   FK → services  (print or photocopy)
  paper_size_id   SMALLINT UNSIGNED FK → paper_sizes
  color_mode      ENUM('bw','color')
  sides           ENUM('single','double')
  min_qty         INT               default 1, CHECK (min_qty >= 1)   tier start, printed sides
  max_qty         INT               NULL          NULL = no upper limit
  unit_price      DECIMAL(8,2)      CHECK (unit_price >= 0)           per printed side
  is_active       TINYINT(1)        default 1
  created_at, updated_at
  UQ (service_id, paper_size_id, color_mode, sides, min_qty)
  CHECK (max_qty IS NULL OR max_qty >= min_qty)

print_extras
  id              BIGINT UNSIGNED   PK
  code            VARCHAR(40)       UQ
  name            VARCHAR(100)
  charge_type     ENUM('per_order','per_copy','per_side','per_sheet')
  unit_price      DECIMAL(8,2)      CHECK (unit_price >= 0)
  is_active       TINYINT(1)        default 1
  sort_order      INT               default 0
  created_at, updated_at
```

The admin screen refuses overlapping quantity tiers for the same combination; the
unique key is a backstop against duplicate tier starts.

### 3.5 Orders

```
orders
  id              BIGINT UNSIGNED   PK
  order_no        VARCHAR(20)       UQ            e.g. SS-000123, set in the creating transaction
  user_id         BIGINT UNSIGNED   FK → users, NULL (counter sale without account)
  channel         ENUM('online','counter')        default 'online'
  customer_name   VARCHAR(120)                    snapshot
  customer_phone  VARCHAR(15)                     snapshot
  fulfilment_type ENUM('pickup','delivery')
  delivery_area   VARCHAR(100)      NULL
  delivery_address VARCHAR(500)     NULL
  status          ENUM('pending','confirmed','processing','ready',
                       'out_for_delivery','completed','cancelled')  default 'pending'
  needs_quote     TINYINT(1)        default 0     1 until staff price every quoted line
  payment_method  ENUM('cash','bkash','nagad')    customer's choice at checkout
  payment_status  ENUM('unpaid','pending_verification','partial','paid','refunded')
                                                  default 'unpaid'
  subtotal        DECIMAL(12,2)
  discount_amount DECIMAL(12,2)     default 0
  delivery_charge DECIMAL(12,2)     default 0
  total_amount    DECIMAL(12,2)     CHECK (total_amount >= 0)
  paid_amount     DECIMAL(12,2)     default 0     derived — see §4.3
  customer_note   VARCHAR(500)      NULL
  staff_note      VARCHAR(500)      NULL
  idempotency_key CHAR(36)                        UUID created by the checkout page
  cancel_reason   VARCHAR(255)      NULL
  created_by      BIGINT UNSIGNED   FK → users, NULL (staff, for counter sales)
  placed_at       DATETIME
  confirmed_at, completed_at, cancelled_at  DATETIME NULL
  created_at, updated_at
  UQ (user_id, idempotency_key)
  IX (user_id, placed_at), IX (status, placed_at), IX (payment_status, placed_at),
  IX (customer_phone)

order_items
  id              BIGINT UNSIGNED   PK
  order_id        BIGINT UNSIGNED   FK → orders (CASCADE)
  item_type       ENUM('product','service','print')
  product_id      BIGINT UNSIGNED   FK → products, NULL
  service_id      BIGINT UNSIGNED   FK → services, NULL
  service_rate_id BIGINT UNSIGNED   FK → service_rates (SET NULL), NULL
  name_snapshot   VARCHAR(220)
  sku_snapshot    VARCHAR(50)       NULL
  unit_price      DECIMAL(12,2)     NULL          NULL while awaiting a staff quote
  cost_price_snapshot DECIMAL(12,2) NULL          for profit reports
  quantity        INT               CHECK (quantity > 0)
  line_total      DECIMAL(12,2)     NULL
  details         JSON              NULL          customer's answers on a service request
  created_at      DATETIME
  IX (order_id), IX (product_id)
  CHECK ((item_type = 'product') = (product_id IS NOT NULL))

print_jobs
  id              BIGINT UNSIGNED   PK
  order_item_id   BIGINT UNSIGNED   FK → order_items (CASCADE), UQ
  service_id      BIGINT UNSIGNED   FK → services
  paper_size_code VARCHAR(10)                     snapshot
  color_mode      ENUM('bw','color')
  sides           ENUM('single','double')
  page_count      INT               CHECK (page_count > 0)
  copies          INT               CHECK (copies > 0)
  printed_sides   INT
  sheets          INT
  print_rate_id   BIGINT UNSIGNED   FK → print_rates (SET NULL), NULL   reference only
  unit_price      DECIMAL(8,2)                    snapshot of the rate used
  base_amount     DECIMAL(12,2)
  extras_amount   DECIMAL(12,2)     default 0
  min_charge_applied DECIMAL(12,2)  default 0
  total_amount    DECIMAL(12,2)
  price_status    ENUM('calculated','needs_review','confirmed')  default 'calculated'
  instructions    VARCHAR(500)      NULL
  status          ENUM('queued','printing','done','cancelled')   default 'queued'
  printed_by      BIGINT UNSIGNED   FK → users, NULL
  printed_at      DATETIME          NULL
  created_at, updated_at
  IX (status, created_at)

print_job_extras
  id              BIGINT UNSIGNED   PK
  print_job_id    BIGINT UNSIGNED   FK → print_jobs (CASCADE)
  print_extra_id  BIGINT UNSIGNED   FK → print_extras (SET NULL), NULL
  name_snapshot   VARCHAR(100)
  charge_type     ENUM('per_order','per_copy','per_side','per_sheet')
  unit_price      DECIMAL(8,2)
  quantity        INT
  amount          DECIMAL(12,2)
  IX (print_job_id)

order_status_history                              append-only
  id              BIGINT UNSIGNED   PK
  order_id        BIGINT UNSIGNED   FK → orders (CASCADE)
  from_status     VARCHAR(20)       NULL
  to_status       VARCHAR(20)
  note            VARCHAR(255)      NULL
  is_customer_visible TINYINT(1)    default 1
  changed_by      BIGINT UNSIGNED   FK → users, NULL (system)
  created_at      DATETIME
  IX (order_id, created_at)
```

### 3.6 Files

```
uploaded_files
  id              BIGINT UNSIGNED   PK
  user_id         BIGINT UNSIGNED   FK → users
  order_item_id   BIGINT UNSIGNED   FK → order_items (SET NULL), NULL until ordered
  purpose         ENUM('print','service_document')
  original_name   VARCHAR(255)
  stored_name     CHAR(40)          UQ            random; the name on disk
  mime_type       VARCHAR(100)
  size_bytes      INT UNSIGNED
  page_count      INT               NULL
  sha256          CHAR(64)
  status          ENUM('temp','attached','deleted')   default 'temp'
  delete_after    DATETIME          NULL          set by retention rules
  deleted_at      DATETIME          NULL
  created_at      DATETIME
  IX (status, delete_after), IX (user_id), IX (order_item_id)
```

Downloads are recorded in `audit_logs` (`action = 'file.download'`). The row
outlives the file so there is always a record of what was held and when it was
removed.

### 3.7 Payments

```
payments
  id              BIGINT UNSIGNED   PK
  order_id        BIGINT UNSIGNED   FK → orders
  method          ENUM('cash','bkash','nagad')
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  sender_number   VARCHAR(15)       NULL
  trx_id          VARCHAR(30)       NULL          upper-cased, trimmed
  status          ENUM('submitted','verified','rejected','refunded')  default 'submitted'
  submitted_by    BIGINT UNSIGNED   FK → users
  verified_by     BIGINT UNSIGNED   FK → users, NULL
  verified_at     DATETIME          NULL
  reject_reason   VARCHAR(255)      NULL
  note            VARCHAR(255)      NULL
  active_trx_key  VARCHAR(40)       GENERATED, stored:
                    method + ':' + trx_id  when trx_id is set and status is
                    'submitted' or 'verified'; otherwise NULL
  created_at, updated_at
  UQ (active_trx_key)
  IX (order_id), IX (status, created_at)
```

The generated key makes a transaction ID unique among live payments, while a
rejected entry (for example a typing mistake, or someone entering another person's
TrxID) releases it for the rightful order.

### 3.8 Expenses, settings, notifications

```
expense_categories                                phase 2 screens
  id              SMALLINT UNSIGNED PK
  name            VARCHAR(80)       UQ
  is_active       TINYINT(1)        default 1

expenses                                          phase 2 screens
  id              BIGINT UNSIGNED   PK
  expense_category_id SMALLINT UNSIGNED  FK → expense_categories
  expense_date    DATE
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  description     VARCHAR(255)
  payment_method  ENUM('cash','bkash','nagad','bank')
  reference_no    VARCHAR(50)       NULL
  status          ENUM('active','void')           default 'active'
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  IX (expense_date), IX (expense_category_id, expense_date)

settings
  setting_key     VARCHAR(100)      PK            e.g. shop.phone, payment.bkash_number,
                                                  files.retention_days, delivery.areas
  value           JSON
  is_public       TINYINT(1)        default 0     1 = may be sent to the browser
  description     VARCHAR(255)      NULL
  updated_by      BIGINT UNSIGNED   FK → users, NULL
  updated_at      DATETIME

notifications
  id              BIGINT UNSIGNED   PK
  order_id        BIGINT UNSIGNED   FK → orders (CASCADE), NULL
  user_id         BIGINT UNSIGNED   FK → users, NULL
  channel         ENUM('email','sms')
  template        VARCHAR(60)
  recipient       VARCHAR(190)
  status          ENUM('queued','sent','failed')  default 'queued'
  error           VARCHAR(255)      NULL
  created_at      DATETIME
  sent_at         DATETIME          NULL
  IX (status, created_at), IX (order_id)
```

## 4. Integrity rules

All of the following run inside a single database transaction each. If any step
fails, the whole operation rolls back and nothing is half-saved.

### 4.1 Correct stock quantities

`products.stock_qty` is the current balance; `inventory_movements` is the history
that explains it. They are changed together or not at all.

1. **One code path.** Only one function may change `stock_qty`. It always updates
   the product and inserts the ledger row in the same transaction.
2. **Atomic deduction.** Stock is reduced with a conditional update —
   `UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?` —
   and the operation is abandoned if no row was changed. Two customers buying the
   last item cannot both succeed.
3. **Database backstop.** `CHECK (stock_qty >= 0)` rejects a negative balance even
   if application code is wrong.
4. **Lock order.** Products in one order are processed in ascending `id` so two
   simultaneous orders cannot deadlock each other; a deadlock error is retried once.
5. **Cancellation.** Returning stock is a new `order_cancel` ledger row, guarded so
   it can happen only once per order (the status change from a non-cancelled state
   is itself a conditional update).
6. **Reconciliation.** An admin report compares `SUM(quantity)` per product with
   `stock_qty`. Any difference is a bug to investigate, not something to overwrite.

### 4.2 No duplicate orders

1. The checkout page generates a UUID once when it loads and sends it with the order.
2. `UQ (user_id, idempotency_key)` lets only the first insert succeed.
3. When a repeat arrives (double click, retry after a dropped connection), the API
   catches the duplicate-key error and returns the order that already exists.
4. The submit button is disabled while a request is in flight; this is a courtesy,
   the unique key is the guarantee.

Placing an order is one transaction: validate every line against current data →
insert order → insert lines, print jobs and extras → deduct stock and write ledger
rows → attach uploaded files → write first status-history row → set `order_no` →
commit.

### 4.3 Consistent payment status

`orders.paid_amount` and `orders.payment_status` are never set directly. They are
recalculated from the `payments` rows every time a payment changes.

1. Lock the order row (`SELECT … FOR UPDATE`).
2. Change the payment with a conditional update, e.g.
   `… SET status = 'verified' WHERE id = ? AND status = 'submitted'`. If no row
   changed, another staff member already handled it; stop.
3. Recalculate: `paid_amount` = sum of verified payments;
   `payment_status` = `paid` if that covers the total, `partial` if above zero,
   `pending_verification` if any payment is still submitted, otherwise `unpaid`.
4. Insert the audit-log row with the before and after values.
5. Commit.

Two staff clicking Verify at the same moment produce exactly one verification and
one audit entry.

### 4.4 Order status changes

Allowed transitions are a fixed table in code. A change is a conditional update on
the current status plus an `order_status_history` row, in one transaction. An order
with `needs_quote = 1` cannot leave `pending`, and cannot receive payments, until
staff have priced every line.

### 4.5 Limits of database-level protection

On cPanel shared hosting the application normally connects as a single database
user with rights over the whole database, so "append-only" for `audit_logs`,
`inventory_movements` and `order_status_history` is enforced by the application
having no code that updates or deletes them, not by MySQL privileges. Whether
per-table privileges are available is a Milestone 0 check.

## 5. Indexing notes

- Product search uses the `FULLTEXT` index for words of three or more characters
  and falls back to a prefix `LIKE` for shorter input. The minimum word length is
  a server setting that cannot be changed on shared hosting.
- Admin lists filter by status and date; the composite indexes above match those
  filters.
- `login_attempts`, expired `sessions` and old `notifications` are trimmed by a
  daily cron job so they stay small.
