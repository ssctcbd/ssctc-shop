# SSCTC Shop — Database Schema

Design document for MySQL 8.0.46, revised 2026-10-10 for the internal shop
management scope. This is a specification, not a migration; the migration is
written in Milestone 1 after approval.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for scope. The previous schema (public shop
with online orders) is in [old_plans_reference/2026-10-09-public-shop-plan/](old_plans_reference/2026-10-09-public-shop-plan/).

## 1. Changes from the previous schema

No database has been created yet, so these are design changes only; there is no
data to migrate.

| Table | Change |
|---|---|
| `roles`, `role_permissions`, `sessions`, `login_attempts`, `audit_logs`, `categories`, `settings` | Kept |
| `users` | Kept, staff only; logs in with a username |
| `products` | Kept; storefront columns removed |
| `inventory_movements` | Kept; movement types updated (added `purchase`, `sale_return`) |
| `services` | Simplified to a rate list |
| `customers` | **New** (tracks `current_due`, `advance_balance`, and portal login PIN) |
| `customer_sessions` | **New** (lightweight read-only portal sessions) |
| `sales`, `sale_items` | **New**, replacing `orders`, `order_items`; items support warranty & serial, sales support QR token |
| `payments` | **Redesigned** (supports partial, allocation, advance balance, receipts) |
| `payment_allocations` | **New** |
| `suppliers`, `purchases`, `purchase_items`, `supplier_payments` | **New** (Accounts Payable & purchase inventory) |
| `expense_categories`, `expenses` | **New** (Daily shop expense tracking) |
| `daily_cash_closings` | **New** (Day-end physical vs expected cash reconciliation) |
| `sale_returns`, `sale_return_items` | **New** (Product return, restock, cash/advance refund) |
| `document_counters` | **New** (sequential invoice, receipt, purchase, expense, return nos) |
| `orders`, `order_items`, `order_status_history`, `print_jobs`, `print_job_extras`, `print_rates`, `print_extras`, `paper_sizes`, `service_rates`, `uploaded_files`, `product_images`, `notifications` | Removed |

## 2. Conventions

| Topic | Rule |
|---|---|
| Engine / charset | InnoDB, `utf8mb4`, collation `utf8mb4_0900_ai_ci` |
| Primary keys | `id BIGINT UNSIGNED AUTO_INCREMENT` unless stated |
| Money | `DECIMAL(12,2)`, BDT. Never floating point |
| Time | `DATETIME` stored in UTC; shown in Asia/Dhaka by the application |
| Timestamps | `created_at` on every table; `updated_at` where rows change |
| Deletion | Business records are never deleted; they are voided or deactivated |
| Foreign keys | `ON DELETE RESTRICT` unless stated |
| Snapshots | Sale lines copy names and prices at sale time |

Notation: `PK`, `FK → table`, `UQ` unique, `IX` index. Columns are `NOT NULL`
unless marked `NULL`.

## 3. Relationships

```
roles ─< role_permissions
roles ─< users ─< sessions

categories ─< products ─< inventory_movements
suppliers ─< purchases ─< purchase_items >─ products
suppliers ─< supplier_payments
expense_categories ─< expenses
daily_cash_closings (recorded by users)

customers ─< customer_sessions
customers ─< sales ─< sale_items >─ products / services
customers ─< payments ─< payment_allocations >─ sales
sales ─< sale_returns ─< sale_return_items >─ products
```

## 4. Tables

### 4.1 Access

```
roles
  id              TINYINT UNSIGNED  PK
  code            VARCHAR(30)       UQ            owner | staff
  name            VARCHAR(60)
  created_at      DATETIME

role_permissions
  role_id         TINYINT UNSIGNED  FK → roles (CASCADE)
  permission      VARCHAR(60)                     e.g. sales.create, sales.void,
                                                  payments.verify, inventory.adjust
  PK (role_id, permission)

users                                             staff only
  id              BIGINT UNSIGNED   PK
  role_id         TINYINT UNSIGNED  FK → roles
  name            VARCHAR(120)
  username        VARCHAR(60)       UQ
  phone           VARCHAR(15)       NULL
  password_hash   VARCHAR(255)
  status          ENUM('active','blocked')        default 'active'
  must_change_password TINYINT(1)   default 0
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
  created_at, last_seen_at, expires_at   DATETIME
  revoked_at      DATETIME          NULL
  IX (user_id), IX (expires_at)

login_attempts
  id              BIGINT UNSIGNED   PK
  identifier      VARCHAR(60)                     username as typed, lower-cased
  ip              VARCHAR(45)
  success         TINYINT(1)
  created_at      DATETIME
  IX (identifier, created_at), IX (ip, created_at)

audit_logs                                        append-only
  id              BIGINT UNSIGNED   PK
  actor_user_id   BIGINT UNSIGNED   FK → users, NULL (system / cron)
  action          VARCHAR(60)                     e.g. payment.verify, sale.void
  entity_type     VARCHAR(40)
  entity_id       BIGINT UNSIGNED   NULL
  old_values      JSON              NULL
  new_values      JSON              NULL
  ip              VARCHAR(45)       NULL
  created_at      DATETIME
  IX (entity_type, entity_id), IX (actor_user_id, created_at), IX (action, created_at)

settings
  setting_key     VARCHAR(100)      PK            e.g. shop.name, shop.address, shop.logo_url,
                                                  invoice.footer, payment.bkash_number
  value           JSON
  description     VARCHAR(255)      NULL
  updated_by      BIGINT UNSIGNED   FK → users, NULL
  updated_at      DATETIME
```

### 4.2 Catalog

```
categories
  id              BIGINT UNSIGNED   PK
  parent_id       BIGINT UNSIGNED   FK → categories, NULL
  name            VARCHAR(100)
  sort_order      INT               default 0
  is_active       TINYINT(1)        default 1
  created_at, updated_at
  UQ (parent_id, name), IX (parent_id, sort_order)

products
  id              BIGINT UNSIGNED   PK
  category_id     BIGINT UNSIGNED   FK → categories
  sku             VARCHAR(50)       UQ            code typed or scanned at the counter
  name            VARCHAR(200)
  brand           VARCHAR(100)      NULL
  unit            VARCHAR(20)       default 'pcs'
  price           DECIMAL(12,2)     CHECK (price >= 0)
  cost_price      DECIMAL(12,2)     default 0     latest stock-in cost
  track_stock     TINYINT(1)        default 1
  stock_qty       INT               default 0, CHECK (stock_qty >= 0)
  low_stock_threshold INT           default 5
  status          ENUM('active','archived')       default 'active'
  note            VARCHAR(255)      NULL
  created_at, updated_at
  IX (category_id, status), IX (status, name)
  FULLTEXT (name, brand)

services                                          printing, photocopy, online services
  id              BIGINT UNSIGNED   PK
  service_type    ENUM('print','photocopy','online','other')
  name            VARCHAR(150)      UQ            e.g. "Photocopy A4 B/W (per page)"
  unit            VARCHAR(20)       default 'pcs' page, copy, application, …
  default_price   DECIMAL(12,2)     CHECK (default_price >= 0)
  price_editable  TINYINT(1)        default 1     may the price be changed at the counter
  is_active       TINYINT(1)        default 1
  sort_order      INT               default 0
  created_at, updated_at
  IX (service_type, is_active)
```

### 4.3 Inventory

```
inventory_movements                               append-only ledger
  id              BIGINT UNSIGNED   PK
  product_id      BIGINT UNSIGNED   FK → products
  movement_type   ENUM('opening','stock_in','purchase','sale','sale_void',
                       'sale_return','adjustment_in','adjustment_out')
  quantity        INT               CHECK (quantity <> 0)   signed: + in, − out (only zero is refused)
  balance_after   INT               CHECK (balance_after >= 0)
  unit_cost       DECIMAL(12,2)     NULL
  reference_type  ENUM('sale','purchase','return','manual')
  reference_id    BIGINT UNSIGNED   NULL          sale / purchase / return id
  note            VARCHAR(255)      NULL          required for adjustments
  created_by      BIGINT UNSIGNED   FK → users
  created_at      DATETIME
  IX (product_id, created_at), IX (reference_type, reference_id), IX (movement_type, created_at)
```

### 4.4 Customers

```
customers
  id              BIGINT UNSIGNED   PK
  name            VARCHAR(120)
  phone           VARCHAR(15)       UQ, NULL      normalised to 01XXXXXXXXX
  address         VARCHAR(255)      NULL
  note            VARCHAR(255)      NULL
  current_due     DECIMAL(12,2)     default 0, CHECK (current_due >= 0)   derived — see §5.3
  advance_balance DECIMAL(12,2)     default 0, CHECK (advance_balance >= 0) customer deposit / wallet
  portal_pin      VARCHAR(10)       NULL          auto-generated 6-digit PIN for portal login
  portal_password_hash VARCHAR(255) NULL
  portal_enabled  TINYINT(1)        default 1
  last_portal_login_at DATETIME     NULL
  is_active       TINYINT(1)        default 1
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  IX (name), IX (current_due), IX (advance_balance)

customer_sessions                                 sessions for read-only customer portal
  id              BIGINT UNSIGNED   PK
  customer_id     BIGINT UNSIGNED   FK → customers (CASCADE)
  token_hash      CHAR(64)          UQ            SHA-256 of session cookie
  ip              VARCHAR(45)
  user_agent      VARCHAR(255)
  created_at, last_seen_at, expires_at DATETIME
  IX (customer_id), IX (expires_at)
```

Walk-in buyers are not stored; their sales have no customer.

Portal PIN handling, as implemented in Milestone 1:

- Login always checks the PIN against `portal_password_hash` (bcrypt).
- `portal_pin` holds the shop-issued PIN in readable form so staff can view it and
  tell the customer. When the customer chooses their own PIN it is set to `NULL`;
  a PIN the customer chose is never stored readably, and staff can then only reset it.
- Portal login attempts are recorded in `login_attempts` with the identifier
  `portal:<phone>` (staff logins use `staff:<username>`), so the same lockout applies.

### 4.5 Sales

```
sales
  id              BIGINT UNSIGNED   PK
  invoice_no      VARCHAR(20)       UQ            e.g. INV-000123
  sale_type       ENUM('sale','opening_due')      default 'sale'
  customer_id     BIGINT UNSIGNED   FK → customers, NULL (walk-in)
  customer_name   VARCHAR(120)      NULL          snapshot, or a typed walk-in name
  customer_phone  VARCHAR(15)       NULL          snapshot
  qr_token        CHAR(32)          UQ, NULL      secure token embedded in QR code for 1-click view
  sale_date       DATETIME                        normally now; back-dating needs permission
  status          ENUM('completed','void')        default 'completed'
  subtotal        DECIMAL(12,2)
  discount_amount DECIMAL(12,2)     default 0, CHECK (discount_amount >= 0)
  total_amount    DECIMAL(12,2)     CHECK (total_amount >= 0)
  paid_amount     DECIMAL(12,2)     default 0     derived — verified payments only
  unverified_amount DECIMAL(12,2)   default 0     derived — recorded but not yet verified
  due_amount      DECIMAL(12,2)                   derived — total_amount − paid_amount
  payment_status  ENUM('unpaid','partial','paid') derived
  note            VARCHAR(500)      NULL
  idempotency_key CHAR(36)          UQ            UUID created by the POS screen
  void_reason     VARCHAR(255)      NULL
  voided_by       BIGINT UNSIGNED   FK → users, NULL
  voided_at       DATETIME          NULL
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  CHECK (paid_amount >= 0 AND paid_amount <= total_amount)
  CHECK (due_amount = total_amount - paid_amount)
  CHECK (status = 'void' OR due_amount = 0 OR customer_id IS NOT NULL)
  IX (customer_id, sale_date), IX (sale_date), IX (status, payment_status, sale_date), IX (qr_token)

sale_items
  id              BIGINT UNSIGNED   PK
  sale_id         BIGINT UNSIGNED   FK → sales
  item_type       ENUM('product','service')
  product_id      BIGINT UNSIGNED   FK → products, NULL
  service_id      BIGINT UNSIGNED   FK → services, NULL
  name_snapshot   VARCHAR(200)
  sku_snapshot    VARCHAR(50)       NULL
  unit_snapshot   VARCHAR(20)
  unit_price      DECIMAL(12,2)     CHECK (unit_price >= 0)
  cost_price_snapshot DECIMAL(12,2) NULL
  quantity        INT               CHECK (quantity > 0)
  warranty        VARCHAR(50)       NULL          e.g. '1 Year', '6 Months'
  serial_no       VARCHAR(100)      NULL          hardware serial number
  line_total      DECIMAL(12,2)
  created_at      DATETIME
  IX (sale_id), IX (product_id), IX (service_id)
  CHECK ((item_type = 'product' AND product_id IS NOT NULL AND service_id IS NULL)
      OR (item_type = 'service' AND service_id IS NOT NULL AND product_id IS NULL))
```

An `opening_due` sale has no lines; it records what a customer already owed when
the system started, so that old dues are collected exactly like any other.

The third `CHECK` on `sales` enforces, in the database itself, that a sale cannot
carry a due without a saved customer. Since only verified payments reduce a due,
a walk-in sale paid by bKash, Nagad or bank must be verified at the counter or
attached to a saved customer before it can be completed.

### 4.6 Payments

```
payments                                          one row per receipt
  id              BIGINT UNSIGNED   PK
  receipt_no      VARCHAR(20)       UQ            e.g. RCP-000456
  customer_id     BIGINT UNSIGNED   FK → customers, NULL (walk-in sale paid on the spot)
  payment_date    DATETIME
  method          ENUM('cash','bkash','nagad','bank_transfer','customer_advance','other')
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  reference       VARCHAR(60)       NULL          TrxID / bank reference, trimmed, upper-cased
  is_verified     TINYINT(1)        default 0
  verified_by     BIGINT UNSIGNED   FK → users, NULL
  verified_at     DATETIME          NULL
  status          ENUM('active','void')           default 'active'
  void_reason     VARCHAR(255)      NULL
  voided_by       BIGINT UNSIGNED   FK → users, NULL
  voided_at       DATETIME          NULL
  note            VARCHAR(255)      NULL
  idempotency_key CHAR(36)          UQ
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  active_ref_key  VARCHAR(70)       GENERATED, stored:
                    method + ':' + reference  when status = 'active', reference is set
                    and method is bkash or nagad; otherwise NULL
  UQ (active_ref_key)
  IX (customer_id, payment_date), IX (payment_date), IX (method, payment_date),
  IX (is_verified, status, payment_date)

payment_allocations                               how a payment is split across sales
  id              BIGINT UNSIGNED   PK
  payment_id      BIGINT UNSIGNED   FK → payments
  sale_id         BIGINT UNSIGNED   FK → sales
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  created_at      DATETIME
  UQ (payment_id, sale_id)
  IX (sale_id)
```

- The allocations of a payment always add up to its `amount`.
- A payment taken at the counter for one sale has exactly one allocation.
- A due collection may have several.
- `active_ref_key` makes a bKash or Nagad transaction ID unique among active
  payments. Voiding the mistaken entry frees the ID to be recorded correctly.
  Bank and "other" references are not forced unique, since they are free text.
- `is_verified` is set only by an explicit staff action. Recording a reference
  never sets it. Cash payments are created already verified, by the person
  recording them.
- When `method = 'customer_advance'`, `is_verified` is automatically 1 and the amount
  is deducted from `customers.advance_balance`.

### 4.7 Suppliers and purchases (Accounts Payable)

```
suppliers
  id              BIGINT UNSIGNED   PK
  name            VARCHAR(120)
  company         VARCHAR(150)      NULL
  phone           VARCHAR(15)       NULL
  address         VARCHAR(255)      NULL
  note            VARCHAR(255)      NULL
  current_payable DECIMAL(12,2)     default 0, CHECK (current_payable >= 0)
  is_active       TINYINT(1)        default 1
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  IX (name), IX (current_payable)

purchases
  id              BIGINT UNSIGNED   PK
  purchase_no     VARCHAR(20)       UQ            e.g. PUR-000045
  supplier_id     BIGINT UNSIGNED   FK → suppliers
  purchase_date   DATETIME
  supplier_memo_no VARCHAR(60)      NULL          challan / invoice no from supplier
  total_amount    DECIMAL(12,2)     CHECK (total_amount >= 0)
  paid_amount     DECIMAL(12,2)     default 0, CHECK (paid_amount >= 0 AND paid_amount <= total_amount)
  due_amount      DECIMAL(12,2)                   derived — total_amount - paid_amount
  payment_status  ENUM('unpaid','partial','paid') derived
  status          ENUM('active','void')           default 'active'      (migration 002)
  note            VARCHAR(500)      NULL
  idempotency_key CHAR(36)          UQ, NULL      UUID from the purchase form (migration 002)
  void_reason     VARCHAR(255)      NULL          (migration 002)
  voided_by       BIGINT UNSIGNED   FK → users, NULL                    (migration 002)
  voided_at       DATETIME          NULL          (migration 002)
  created_by      BIGINT UNSIGNED   FK → users
  created_at, updated_at
  CHECK (due_amount = total_amount - paid_amount)
  IX (supplier_id, purchase_date), IX (purchase_date), IX (supplier_id, status)

purchase_items
  id              BIGINT UNSIGNED   PK
  purchase_id     BIGINT UNSIGNED   FK → purchases
  product_id      BIGINT UNSIGNED   FK → products
  quantity        INT               CHECK (quantity > 0)
  unit_cost       DECIMAL(12,2)     CHECK (unit_cost >= 0)
  line_total      DECIMAL(12,2)     CHECK (line_total >= 0)
  created_at      DATETIME
  IX (purchase_id), IX (product_id)

supplier_payments
  id              BIGINT UNSIGNED   PK
  voucher_no      VARCHAR(20)       UQ            e.g. SPAY-000123
  supplier_id     BIGINT UNSIGNED   FK → suppliers
  purchase_id     BIGINT UNSIGNED   FK → purchases, NULL
  payment_date    DATETIME
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  method          ENUM('cash','bkash','nagad','bank_transfer','other') default 'cash'
  reference       VARCHAR(60)       NULL
  note            VARCHAR(255)      NULL
  created_by      BIGINT UNSIGNED   FK → users
  created_at      DATETIME
  IX (supplier_id, payment_date), IX (payment_date)
```

### 4.8 Daily shop expenses and cash drawer

```
expense_categories
  id              BIGINT UNSIGNED   PK
  name            VARCHAR(100)      UQ            e.g. Rent, Electricity, Internet, Paper/Toner, Tea, Salary, Other
  is_active       TINYINT(1)        default 1
  created_at      DATETIME

expenses
  id              BIGINT UNSIGNED   PK
  voucher_no      VARCHAR(20)       UQ            e.g. EXP-000123
  category_id     BIGINT UNSIGNED   FK → expense_categories
  expense_date    DATETIME
  amount          DECIMAL(12,2)     CHECK (amount > 0)
  payment_method  ENUM('cash','bkash','nagad','bank_transfer','other') default 'cash'
  title           VARCHAR(200)
  note            VARCHAR(500)      NULL
  created_by      BIGINT UNSIGNED   FK → users
  created_at      DATETIME
  IX (category_id, expense_date), IX (expense_date)

daily_cash_closings
  id              BIGINT UNSIGNED   PK
  closing_date    DATE              UQ
  opening_cash    DECIMAL(12,2)     default 0, CHECK (opening_cash >= 0)
  cash_sales      DECIMAL(12,2)     default 0, CHECK (cash_sales >= 0)
  cash_dues_collected DECIMAL(12,2) default 0, CHECK (cash_dues_collected >= 0)
  cash_expenses   DECIMAL(12,2)     default 0, CHECK (cash_expenses >= 0)
  cash_supplier_paid DECIMAL(12,2)  default 0, CHECK (cash_supplier_paid >= 0)
  expected_closing_cash DECIMAL(12,2)
  actual_closing_cash DECIMAL(12,2) CHECK (actual_closing_cash >= 0)
  difference      DECIMAL(12,2)                   actual - expected (shortage or surplus)
  note            VARCHAR(500)      NULL
  closed_by       BIGINT UNSIGNED   FK → users
  closed_at       DATETIME
```

### 4.9 Sale returns

```
sale_returns
  id              BIGINT UNSIGNED   PK
  return_no       VARCHAR(20)       UQ            e.g. RET-000045
  sale_id         BIGINT UNSIGNED   FK → sales
  customer_id     BIGINT UNSIGNED   FK → customers, NULL
  return_date     DATETIME
  total_refund    DECIMAL(12,2)     CHECK (total_refund >= 0)
  refund_method   ENUM('cash','advance_credit') default 'cash'
  reason          VARCHAR(255)
  created_by      BIGINT UNSIGNED   FK → users
  created_at      DATETIME
  IX (sale_id), IX (customer_id, return_date)

sale_return_items
  id              BIGINT UNSIGNED   PK
  return_id       BIGINT UNSIGNED   FK → sale_returns
  sale_item_id    BIGINT UNSIGNED   FK → sale_items
  product_id      BIGINT UNSIGNED   FK → products
  quantity        INT               CHECK (quantity > 0)
  unit_price      DECIMAL(12,2)     CHECK (unit_price >= 0)
  line_total      DECIMAL(12,2)
  created_at      DATETIME
  IX (return_id), IX (product_id)
```

### 4.10 Numbering

```
document_counters
  doc_type        VARCHAR(25)       PK            invoice | receipt | purchase | supplier_payment | expense | return
  last_number     INT UNSIGNED      default 0
```

Invoice, receipt, purchase, voucher and return numbers are taken from here with a row lock inside the same
transaction that creates the document, so numbers are sequential, never duplicated,
and never consumed by a failed save.

## 5. Integrity rules

Each operation below is a single database transaction. If any step fails, all of
it is rolled back.

### 5.1 Stock

`products.stock_qty` is the current balance; `inventory_movements` explains it.

1. Only one function changes stock. It updates the product and inserts the ledger
   row together.
2. Stock is reduced with a conditional update —
   `UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_qty >= ?` —
   and the sale is abandoned if no row changed. Two tills cannot both sell the last
   item.
3. `CHECK (stock_qty >= 0)` is the backstop.
4. Products in a sale are processed in ascending `id` to avoid deadlocks; a
   deadlock error is retried once.
5. Voiding a sale adds `sale_void` rows that return the stock. The void itself is a
   conditional update (`… WHERE status = 'completed'`), so it can happen only once.
6. A reconciliation report compares `SUM(quantity)` per product with `stock_qty`.
   A difference is a bug to investigate, not a number to overwrite.

Completing a sale: take invoice number → insert sale → insert lines → reduce stock
and write ledger rows → insert the payment and allocation, if any was taken →
recalculate sale and customer totals → commit.

### 5.2 Duplicate submissions

The POS and payment screens generate a UUID when opened and send it with the save.
The unique `idempotency_key` lets only the first insert succeed; a repeat (double
click, retry after a dropped connection) is answered with the record already saved.

### 5.3 Payment, due and balance consistency

`sales.paid_amount`, `unverified_amount`, `due_amount`, `payment_status` and
`customers.current_due` are never typed in or set directly. One function
recalculates them, and it runs inside every transaction that touches a payment or
a sale:

```
for each affected sale:
  paid_amount       = Σ allocations whose payment is active and verified
  unverified_amount = Σ allocations whose payment is active and not verified
  due_amount        = total_amount − paid_amount
  payment_status    = paid     if due_amount = 0
                      partial  if paid_amount > 0
                      unpaid   otherwise

for the customer:
  current_due       = Σ due_amount of their completed sales
```

Order of locking, the same everywhere so two operations cannot deadlock or
interleave: the customer row first (`SELECT … FOR UPDATE`), then the sales in
ascending `id`, then the payment.

| Operation | Guard |
|---|---|
| Record a payment | With the sales locked, each allocation is checked against that sale's remaining due *minus amounts already awaiting verification*; anything larger is refused. Two people cannot collect the same due twice |
| Verify | `UPDATE payments SET is_verified = 1 … WHERE id = ? AND is_verified = 0 AND status = 'active'`; if no row changed, someone else already did it |
| Unverify | The mirror of verify; dues go back up |
| Void a payment | Conditional on `status = 'active'`; dues go back up; allocations are kept as history |
| Void a sale | Refused while the sale has active payments; they are voided first, deliberately, so money is never silently detached from a sale |

Every one of these writes an `audit_logs` row with before and after values in the
same transaction.

As implemented in Milestone 3:

- **Voiding a sale that has payments.** The rule above ("payments are voided
  first") cannot work for a walk-in sale: voiding its payment would leave a due
  with no customer, which the table forbids. So `POST /sales/:id/void` accepts an
  explicit `voidPayments: true`. The sale is marked void and its payments are
  voided in the same transaction, each with its own audit row. Without the flag
  the request is refused and reports how many payments and how much money are
  involved. It needs both `sales.void` and `payments.void`. A payment that also
  covers another sale is never voided this way.
- **A walk-in sale can never carry a due.** The sale is refused at the counter
  unless it is fully paid with verified money, and unverifying or voiding its
  payment on its own is refused; the sale is voided instead.
- **Verified at the counter.** Cash is always verified. For other methods the
  seller's "the money has arrived" tick is honoured only from a user holding
  `payments.verify`; from anyone else the payment is stored unverified.
- **Payments taken with a sale** get a server-made idempotency key; the sale's
  own key is what prevents a duplicate.
- Recording a payment after the sale (due collection) is not built yet.

**Isolation level.** The application's connections run at READ COMMITTED, not
MySQL's default REPEATABLE READ. Under REPEATABLE READ a transaction's plain
reads all see the database as of its first read, which happens before it has
waited for its row locks; a transaction that queued behind another would lock
the sale and still count returns or payments from before the other committed.
A test (five returns racing for the last unit) caught exactly this. With READ
COMMITTED, "take the lock, then read" always reads committed truth.

**Returns and refunds (migration 003).** New columns `sales.returned_amount`,
`sales.refunded_amount`, `sale_returns.return_amount`,
`sale_returns.idempotency_key`. The money checks on `sales` become:

```
returned  = Σ sale_returns.return_amount     value of goods that came back
refunded  = Σ sale_returns.total_refund      the part given back to the customer
paid      = verified payments − refunded
due       = total − returned − paid

CHECK (due_amount = total_amount − returned_amount − paid_amount)
CHECK (paid_amount ≥ 0 AND paid_amount ≤ total_amount − returned_amount)
CHECK (returned_amount ≤ total_amount AND refunded_amount ≤ returned_amount)
```

- The value of a returned line is its price less the sale's discount in
  proportion; rounding can never return more than the sale was worth.
- That value first cancels what is still due on the sale. Only the rest is
  refunded, in cash or as advance credit (`refund_method`).
- Only products can be returned, never more than was sold less what already
  came back. Stock returns with a `sale_return` ledger row.
- Refused while a payment on the sale is unverified. A sale with a return
  cannot be voided, and a payment cannot be removed if that would leave less
  paid than was already refunded. A return itself cannot be voided.

**Customer advance balance (migration 003).** `customer_advance_movements` is
the ledger behind `customers.advance_balance`, as `inventory_movements` is for
stock: signed `amount`, `balance_after`, and one function that writes both.

```
customer_advance_movements
  id, customer_id FK, movement_type ENUM('deposit','sale_payment','payment_void','return_credit'),
  amount DECIMAL(12,2) signed, balance_after DECIMAL(12,2) CHECK ≥ 0,
  method (deposits), reference, receipt_no UQ, payment_id FK, sale_return_id FK,
  note, idempotency_key UQ, created_by FK, created_at
```

- A deposit joins the balance at once, so it must be certain money: cash, or a
  transfer recorded by someone holding `payments.verify`.
- Paying a sale with method `customer_advance` is verified by nature and is
  refused, with the whole sale, if the balance does not cover it (conditional
  update, so two tills cannot spend the same money).
- Voiding such a payment, or the sale it paid, puts the money back.
- Money tendered above the sale total is not turned into an advance
  automatically; a deposit is always a deliberate entry.

**Customer portal reads.** Bills are read through one function with an
`audience` argument; for a customer it withholds cost, internal notes, void
reasons, staff names on payments, internal ids and the QR token, and hides
voided payments. Every portal query is filtered by the customer id from the
session. `GET /portal/view/:token` returns the single bill whose 128-bit
`qr_token` matches, without a session, and nothing else.

The `CHECK` constraints on `sales` (`paid_amount ≤ total_amount`,
`due_amount = total_amount − paid_amount`, no due without a customer) and on
`customers` (`current_due ≥ 0`, `advance_balance ≥ 0`) make MySQL reject a wrong result even if
application code is at fault.

### 5.4 Purchases and supplier payables

1. A purchase bill inserts `purchases` and `purchase_items` rows in one transaction.
2. For each item, stock is added with a `purchase` ledger row, and `products.cost_price`
   is updated to the latest unit cost.
3. `suppliers.current_payable` is derived: `Σ (total_amount - paid_amount)` over active purchases.
4. Supplier payments reduce `due_amount` on specific purchases or oldest first, and update
   `suppliers.current_payable` atomically.

As implemented in Milestone 2:

- Money paid with the bill is stored as a `supplier_payments` row linked to that
  purchase, so the cash-drawer figures of Milestone 4 will include it. Paying off
  a bill later (a payment not entered with the bill) is Milestone 4.
- An opening payable is a purchase with no lines and `supplier_memo_no =
  'OPENING BALANCE'`; one per supplier.
- The supplier row is locked first (`SELECT … FOR UPDATE`), then products in
  ascending id, so simultaneous bills queue instead of deadlocking.
- `suppliers.current_payable` counts active purchases only.
- **Duplicate saves (migration 002):** the purchase form sends a UUID as
  `idempotency_key`. A repeat of the same save, whether it arrives later or at
  the same moment, is answered with the bill already stored; the unique key is
  the guarantee.
- **Void (migration 002):** a bill is never edited or deleted. Voiding it is one
  transaction: lock supplier → lock the bill → take each product back out of
  stock with an `adjustment_out` ledger row (`reference_type = 'purchase'`) →
  set `status = 'void'` with reason, user and time, by a conditional update so
  it happens once → recalculate the payable → audit. A product's cost price
  returns to the cost of its latest remaining stock entry, unless it was changed
  after the bill.
- Void is refused for an opening payable, for a bill whose products are no
  longer all in stock, and for a bill with a payment recorded. `supplier_payments`
  has no void status yet, so a payment cannot be reversed; that belongs with
  supplier payments in Milestone 4.
- Stock-in and adjustments still have no idempotency key; their forms disable
  the Save button while saving.

### 5.5 Customer advance balances (Wallets)

1. When a customer deposits money or overpays, `customers.advance_balance` increases.
2. Paying by `customer_advance` in POS checks `advance_balance >= amount`, creates a verified
   payment row, and deducts the balance in the same transaction.
3. If a sale return refunds via `advance_credit`, `advance_balance` is credited.

### 5.6 Daily cash drawer reconciliation

1. `daily_cash_closings` captures the physical cash counted by the owner at the end of the day.
2. The system computes expected cash from verified cash transactions on that date:
   `expected_closing_cash = opening_cash + cash_sales + cash_dues_collected - cash_expenses - cash_supplier_paid`.
3. `difference = actual_closing_cash - expected_closing_cash`. Any difference (shortage/surplus)
   is permanently recorded along with the user ID and closing note.

### 5.7 Sale returns

1. Items from a completed sale can be returned with a mandatory reason.
2. Returns write `sale_return` rows to `inventory_movements`, restoring stock.
3. The refund amount is either paid in cash (reducing cash drawer) or credited to the customer's
   advance balance.

### 5.8 Limits of database-level protection

On shared cPanel hosting the application normally connects as one database user
with rights over the whole database. "Append-only" for `audit_logs` and
`inventory_movements` is therefore enforced by the application containing no code
that updates or deletes them, not by MySQL privileges.

## 6. Indexing notes

- POS lookup uses the `sku` unique index for exact codes and the `FULLTEXT` index
  for names, falling back to a prefix `LIKE` for inputs under three characters.
- Sales and payment lists filter by date, customer and method; the composite
  indexes above match those filters.
- Expired `sessions` and old `login_attempts` are trimmed daily by cron.
