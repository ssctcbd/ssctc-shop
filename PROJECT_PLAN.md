# SSCTC Shop — Project Plan

Internal shop management system for a computer shop that also provides printing,
photocopying and online services. Used by the shop's own staff only.

Status: **Milestones 1, 2 and the first part of 3 (customers, POS, sales, invoices, payment verify/void) built and tested locally; nothing after Milestone 1 is deployed. Milestone 0 (hosting verification) is partly done.**

Still open in Milestone 3: sale returns, QR code on invoices, bills in the customer portal, customer advance balance. Provisional defaults in use until the owner decides otherwise: D2 (only verified payments reduce a due), D3 (a due needs a saved customer), D4 (Staff sells and records payments; only the Owner verifies, voids, edits prices and back-dates). Any seller may give a sale-level discount; it is recorded in the audit log.
Last revised: 2026-10-10 (scope update: internal management system; see §2)

Companion documents:

- [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) — tables, constraints, transaction rules
- [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) — hosting verification, deployment, backups
- [old_plans_reference/2026-10-09-public-shop-plan/](old_plans_reference/2026-10-09-public-shop-plan/) — the previous plan (public shop with online ordering), kept for reference

Labels used throughout:

| Label | Meaning |
|---|---|
| **Confirmed** | Reported by the owner or directly observed |
| **Assumption** | Believed true, not yet checked; the plan changes if it is wrong |
| **Verify** | Must be confirmed by the hosting provider or by a live test (Milestone 0) |
| **Decision** | Needs the owner's approval; a provisional default is given |

---

## 1. Facts, assumptions and open items

### Confirmed

- Hosting is a Hosting Bangladesh shared cPanel account.
- cPanel has a Node.js page with a **Create Application** button.
- `SELECT VERSION();` returns MySQL `8.0.46`.
- The application will live at `shop.sscomputertrainingcentre.com`.
- Stack: Next.js + React (JavaScript), Node.js + Express, MySQL.
- The application consists of an internal staff management POS system plus a lightweight read-only Customer Portal (`/portal`). There is no public storefront, cart, or customer file upload.
- No payment gateway of any kind. All payments are typed in by staff.
- Implementation status (2026-10-11): Milestone 1 (schema migration, seeds, staff login, customer portal login, roles, branded layout) and Milestone 2 (categories, products, services, stock-in, adjustments, movement history, low stock, reconciliation, suppliers, purchases) are built in `api/` and `web/` with automated tests. See [README.md](README.md).
- Milestone 0 results reported by the owner (2026-10-11): Node 22 available; `/api` routing beside static files works; MySQL connection works; environment variables reach the app; HTTPS redirect works; static deep links work. Not yet reported: resource limits, memory and concurrency, idle and crash behaviour, restart, client IP, cron, database dump, migrations on the host (DEPLOYMENT_PLAN.md §2).

### Assumptions

- The Node.js page is CloudLinux "Node.js Selector" running apps under Phusion Passenger.
- The plan's resource limits are too small to run `next build` on the server.
- Free SSL is available for the subdomain.
- One shop location, prices in BDT, no VAT line on invoices.
- The shop has a working internet connection at the counter during opening hours.

### Verify (Milestone 0 — see DEPLOYMENT_PLAN.md §2)

- Node.js versions offered and the account's memory / process / CPU limits.
- Whether an app can be mounted at `/api` beside static files on the same subdomain.
- How the app starts, restarts, and behaves when idle or crashed.
- Whether environment variables set in cPanel reach the app, and where they are stored.
- Whether SSH, cron jobs and remote MySQL are available on this package.

---

## 2. Scope update of 2026-10-10

### 2.1 Removed

| Removed requirement | Was in the previous plan as |
|---|---|
| Payment gateway integration of any kind (SSLCOMMERZ, bKash/Nagad APIs, hosted checkout, webhooks, merchant setup, gateway keys) | Phase 2 milestone 13 |
| Public home, contact and service pages | §3.1 |
| Public product catalog and search | §3.2 |
| Online print ordering with customer file upload | §3.3 |
| Online service request forms | §3.4 |
| Cart and checkout, pickup/delivery | §3.5 |
| Customer self-registration | §3.6 |
| Customer-submitted bKash/Nagad TrxID | §3.10 |
| Order status tracking and customer notifications (email, SMS) | §3.11 |
| Print pricing matrix (paper size × colour × sides × tiers, extras) | §4 |
| Private customer-file storage, retention and deletion | §5.1 |
| Product images | §3.2 |

**Confirmation: payment gateway integration is excluded.** Nothing in this plan, the
schema, the endpoint list or the environment template refers to a gateway, and no
time is allocated to one.

### 2.2 Modified

| Area | Before | Now |
|---|---|---|
| Who logs in | Public customers and staff | Staff (full management) & Customers (read-only portal for own dues, bills & warranties) |
| Selling | Online orders placed by customers | Sales entered by staff at the counter (POS) |
| Customers | Self-registered user accounts | Accounts created by staff; required for customers with dues; credentials sent via invoice QR / WhatsApp |
| Payments | Customer submits TrxID; staff verify | Staff record every payment; staff mark verified / unverified |
| Payment methods | Cash, bKash, Nagad | Cash, bKash, Nagad, Bank Transfer, Customer Advance, Other |
| Dues | Not modelled | Customer balances, partial payments, due collection, advance deposit wallet |
| Printing, photocopy, online services | Ordered online with calculated prices | Sold at the counter as service lines with a dynamic rate list |
| Counter sales | Phase 2 | The core of the system |

### 2.3 Unchanged

- Architecture: static Next.js front end + one Express API (§3).
- Stock ledger design, atomic stock deduction, audit logging, staff roles.
- Password, session and rate-limiting design.
- Milestone 0 hosting verification before any deployment-dependent work.
- Backup and restore approach.

### 2.4 Deferred — not planned in initial release, can be approved separately later

SMS notifications / gateway, a public customer website or storefront, customer self-registration,
online payment gateway (bKash/Nagad direct API / SSLCOMMERZ), Bangla UI localization (i18n),
barcode hardware drivers (though barcodes/SKUs can be typed/scanned into search input as text).

*Scope update (2026-10-10): Suppliers, purchases, daily expenses, cash drawer closing,
profit & loss calculations, customer advance balances, sale returns, warranty/serial tracking,
and thermal POS printer layouts (58mm/80mm) have been approved and moved from Deferred into Active Launch Scope (§4).*

### 2.5 Conflicts found with the previous design

| Conflict | Resolution |
|---|---|
| `orders` carried online status flow, delivery fields and customer-chosen payment method | Replaced by a simpler `sales` table |
| Customers were rows in `users` with passwords | New `customers` table, separate from staff. Customers cannot register themselves; staff create the record, and the customer gets read-only portal access with mobile number + 6-digit PIN through a separate session (`customer_sessions`). `users` is staff only |
| One payment belonged to one order | A payment can now be split across several sales, so due collection needs `payment_allocations` |
| Payment status values `submitted / verified / rejected` described customer submissions | Replaced by a `is_verified` flag set by staff, plus `void` for mistakes |
| No concept of customer balance | `customers.current_due`, derived from sales and payments |
| Print pricing tables, print jobs, uploaded files, notifications | Dropped |
| Private file storage and its hosting tests | Dropped; the application now stores no files at all |
| Public-site drawbacks of the static architecture (product URLs, search-engine visibility) | No longer relevant |

No architectural conflict was found: the chosen architecture suits an internal tool
better than it suited the public shop.

---

## 3. Architecture — **Decision D1 (unchanged)**

```
https://shop.sscomputertrainingcentre.com/        static files (Next.js export): staff screens + customer portal
https://shop.sscomputertrainingcentre.com/api/*   one Express app run by cPanel Node.js (Passenger)
MySQL 8.0.46                                      cPanel database, reached from Express only
```

**Primary:** Next.js exported as static files, one Express API at `/api` on the same
subdomain. **Fallback:** the same, with the API on its own subdomain if `/api`
cannot coexist with the static files.

Why this remains right:

- It needs the least from a hosting plan whose limits are still unknown.
- Next.js is built on the development PC, so the server's Node version only has to
  satisfy Express.
- An internal tool gains nothing from server-rendered pages; the earlier
  search-engine and link-preview drawbacks no longer apply.

Alternatives considered and not chosen: Next.js running its own server with API
routes (heavier on shared hosting, and the whole tool goes down with the Node
process), and Next.js plus Express as two Node apps (double the load).

If Express cannot run reliably on this plan, the choice is a higher package or a
small VPS (**Decision D7**), taken only if Milestone 0 fails.

Design rules:

- Nothing important is kept in server memory; sessions and rate limits live in MySQL.
- No background timers in the app; scheduled work runs from cPanel Cron.
- The site tells search engines not to index it. The only screens open without a
  session are the two login pages (`/login` for staff, `/portal/login` for
  customers). Management screens require a staff session; `/portal` screens
  require a customer session, which never grants access to staff data. Every data
  request is authorised by the API.
- Pure-JavaScript dependencies only, to avoid compiling on the server.
- No paid services and no third-party APIs.

**Operational risk to accept:** the POS depends on the internet connection and on
the hosting being up. If either fails, sales are written on paper and entered
afterwards; staff with permission may set the sale date when doing so.

---

## 4. Requirements

**L** = launch. Everything not listed here is out of scope (§2.4).

### 4.1 Dashboard

| Feature | |
|---|---|
| Today's sales total, amount collected, new dues | L |
| Today's expenses, estimated gross profit, and cash drawer status | L |
| Total outstanding customer dues and the customers owing most | L |
| Total outstanding supplier payables | L |
| Payments awaiting verification | L |
| Low-stock products | L |
| Recent sales | L |

### 4.2 Sales / POS

| Feature | |
|---|---|
| Add products and services by search or scanning QR code / Barcode via hardware scanner (instant auto-add) or camera scanner | L |
| Quantity, unit price (editable with permission), sale-level discount | L |
| Optional warranty period (e.g. 1 Year, 6 Months) and serial number per item | L |
| Walk-in sale without a customer, or sale to a saved customer | L |
| Take full, partial, advance wallet deduction, or no payment at time of sale | L |
| A sale that leaves a due requires a saved customer | L |
| One-click 'Share to WhatsApp' button: sends pre-formatted invoice summary, due amount, and portal link to customer's WhatsApp | L |
| Stock is reduced when the sale is completed, never while it is a draft | L |
| Void a sale with a reason; stock is returned; nothing is deleted | L |
| Sales list filtered by date, customer, payment method and payment status | L |
| Protection against saving the same sale twice | L |

### 4.3 Products, categories and services

| Feature | |
|---|---|
| Categories; products with code (SKU), price, cost price, unit, low-stock threshold | L |
| Activate / archive products instead of deleting | L |
| Unlimited dynamic services: Owner can add, edit and manage any new printing, photocopy, binding, lamination, photo print, or online service at any time | L |
| Service attributes: name, service category/type, billing unit (page, copy, file, set), default rate, and counter price-edit permission | L |

Printing, photocopy, and online services are sold as service lines from a dynamic rate list
(e.g., "Photocopy A4 B/W" × 40, "NID Card Online Application" × 1). The owner can freely create
new services whenever the shop offers new facilities.

### 4.4 Inventory and stock movement history

| Feature | |
|---|---|
| Current stock per product | L |
| Stock-in entry linked to a purchase or standalone adjustment | L |
| Stock adjustment (in / out) with a mandatory reason | L |
| Automatic movement on sale, purchase, sale return and on void | L |
| Movement history per product: date, type, quantity, balance after, user, reference | L |
| Low-stock list | L |
| Reconciliation check (ledger total equals current stock) | L |

### 4.5 Customers, dues and advance balance

| Feature | |
|---|---|
| Customer records: name, mobile, address, note | L |
| Mandatory customer account for anyone leaving a due balance | L |
| Portal credentials: auto-generated 6-digit PIN; staff can view or reset PIN | L |
| Opening due or opening advance for existing customers at system start | L |
| Customer advance balance (wallet): deposit advance, spend on sales, refund to advance | L |
| Customer page: outstanding due, advance balance, unpaid sales, full history | L |
| Due list: all customers with a balance, oldest unpaid sale, total | L |
| Collect a due: one payment applied to one or several earlier sales | L |
| Printable customer statement | L |

### 4.6 Payments

| Feature | |
|---|---|
| Methods: Cash, bKash, Nagad, Bank Transfer, Customer Advance, Other | L |
| Full and partial payments; several payments against one sale | L |
| Reference / transaction ID for bKash, Nagad and bank payments | L |
| Verified / unverified flag, changed only by staff with permission | L |
| Entering a transaction ID never marks a payment verified | L |
| Sale total, paid and due calculated automatically | L |
| Customer balance and advance updated automatically | L |
| Payment history: date, amount, method, reference, verification status, recorded by | L |
| Filter by date, customer, method and verification status | L |
| Void a wrongly entered payment with a reason | L |
| A receipt for every payment | L |

How verification affects balances is **Decision D2**, described in §5.

### 4.7 Invoices and receipts

| Feature | |
|---|---|
| Standard full-page invoice (A4/Letter) printable from the browser | L |
| Thermal POS receipt layout (58mm / 80mm roll) for counter sales & services | L |
| Dynamic QR code on invoice and thermal receipt: scanning opens the customer's portal bill instantly | L |
| Prominent shop logo header, contact info, item warranty & serial numbers, payment breakdown, remaining due | L |
| Receipt per payment, listing sales applied to and remaining balance | L |
| Reprint at any time; reprints always show the amounts stored at the time | L |

### 4.8 Suppliers and purchases (Accounts Payable)

| Feature | |
|---|---|
| Supplier records: name, company, mobile, address, note, current payable balance | L |
| Opening payable for existing supplier dues at launch | L |
| Purchase bill entry: supplier, date, challan/memo no, items, quantity, unit cost | L |
| Automatic stock-in from purchase; updates product latest cost price | L |
| Supplier payment entry (Cash, Bank, bKash, Other) and reference tracking | L |
| Supplier list and statement: purchase history, payments, outstanding balance | L |

### 4.9 Daily expenses and cash drawer closing

| Feature | |
|---|---|
| Expense categories (Rent, Electricity, Internet, Paper/Toner, Tea/Snacks, Salary, Other) | L |
| Record daily expense: date, category, amount, payment method, voucher no, note | L |
| Daily cash drawer tracking: opening cash float, cash sales in, cash due collections in | L |
| Cash out tracking: cash expenses paid, cash supplier payments paid | L |
| Day-end closing: expected cash vs actual physical cash counted, discrepancy log | L |
| Daily closing history and audit trail | L |

### 4.10 Sale returns and exchanges

| Feature | |
|---|---|
| Return items from an existing completed sale with mandatory reason | L |
| Returned items automatically re-credited to inventory ledger | L |
| Refund issued as cash or credited to customer's advance balance | L |
| Return receipt / credit note generated | L |

### 4.11 Reports

| Feature | |
|---|---|
| Sales: daily, monthly, custom date range; by product/service and category | L |
| Profit & Loss: Gross Profit (Sale − Cost) and Net Profit (Gross Profit − Expenses) | L |
| Expenses: daily, monthly, categorized summary | L |
| Payments collected by method and by day | L |
| Outstanding customer dues list & aging | L |
| Outstanding supplier payables list | L |
| Daily cash closing logs and cash-in-hand history | L |
| Stock: current levels, low stock, movements in a period | L |
| CSV export of every report | L |

### 4.12 Customer Self-Service Portal (`/portal`)

| Feature | |
|---|---|
| Dedicated customer portal area (`/portal`) accessible on mobile and desktop | L |
| Login via Mobile number + 6-digit PIN (or instant tokenized access via invoice QR code) | L |
| Current Due balance summary & outstanding memos breakdown | L |
| Advance Wallet balance & history | L |
| Full service & purchase history: items bought, services taken (printing, photocopy, online services), rates, dates | L |
| Product warranty tracking: active warranties, serial numbers, warranty expiry countdown | L |
| Digital receipts for every verified payment made | L |
| Change PIN / Security settings | L |
| Strict isolation: customers can never see admin data, cost prices, shop profits, or other customers' records | L |

### 4.13 Users and settings

| Feature | |
|---|---|
| Roles: Owner (everything) and Staff (sell, record payments, view stock, record daily expenses) | L |
| Owner-only: verify payments, void sales/payments, edit prices, adjust stock, manage suppliers/purchases, day closing adjustments, manage users, settings | L |
| Branding & Settings: shop logo (used on invoice/receipt headers & navbar), browser favicon, shop name, address, phone, invoice footer, bKash / Nagad numbers | L |
| Audit log of sensitive actions | L |

Which actions Staff may perform is **Decision D4**.

---

## 5. Payment and due rules

1. **A payment is a record made by staff.** The system never contacts bKash, Nagad
   or a bank.
2. **Verification is a separate, deliberate step.** Cash is verified when recorded,
   because staff hold the money. bKash, Nagad, Bank Transfer and Other are recorded
   as *unverified* until someone with permission confirms the money arrived.
3. **Only verified payments reduce what is owed** (**Decision D2**).

   ```
   sale total  = sum of lines − discount
   paid        = sum of verified, non-void payment amounts applied to the sale
   due         = sale total − paid
   customer balance = sum of "due" over that customer's completed sales
   ```

   Unverified amounts are shown beside the due as "awaiting verification", so staff
   can see that money has been claimed but not confirmed.

   Consequence for walk-in sales: because an unverified payment leaves a due, and a
   due needs a saved customer (D3), a walk-in buyer paying by bKash, Nagad or bank
   must either have the payment verified at the counter or be saved as a customer.
4. **A payment can be split.** A due collection of 1,000 may clear one sale of 600
   and put 400 toward another. The system proposes oldest-first; staff may change it.
5. **Customer advances supported.** If a customer pays more than their current due,
   or deposits money in advance, the excess is stored in `customers.advance_balance`.
   Advance funds can be applied to future sales at the POS or used for due settlement.
6. **Marking unverified again** is allowed with permission; balances are recalculated
   and the change is logged.
7. **Nothing is deleted.** Mistakes are voided with a reason and stay in the history.
8. **A bKash or Nagad transaction ID can be recorded once.** A second entry with the
   same ID is refused unless the first was voided.
9. **Amounts on invoices and receipts are stored copies.** Later price changes do not
   alter past sales.

---

## 6. Security

| Area | Approach |
|---|---|
| Passwords | bcrypt, cost 12, minimum 10 characters |
| Sessions | Random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only its hash stored in MySQL; 12 hours, 2 hours idle; revocable |
| CSRF | `SameSite=Lax` plus an `Origin` check on every state-changing request; JSON only |
| Authorisation | Permission checked in the API on every request |
| Login rate limiting | Stored in MySQL: 5 failures per account in 15 minutes locks it for 15 minutes; 20 per IP blocks the IP |
| Input validation | A schema per endpoint; unknown fields rejected |
| SQL injection | Parameterised queries only; sort and filter columns from fixed allow-lists |
| Transport | HTTPS only, HSTS, security headers |
| Exposure | No public pages except the staff login and the customer portal login; `noindex`; no self-registration — staff accounts are created by the Owner, customer records and their portal PINs by staff |
| Customer portal | Mobile number + 6-digit PIN checked against a bcrypt hash; same lockout as staff login; separate cookie and session table; read-only; every query filtered by the logged-in customer's id, so cost prices, profits and other customers' records are never reachable |
| Secrets | Environment variables only; `.env` never committed |
| Audit | Payment verification changes, voids, price edits, stock adjustments, user and role changes — with user, time and before/after values |
| Files | The application accepts no uploads and stores no files |
| Backups | DEPLOYMENT_PLAN.md §6 |

---

## 7. Project structure and workflow

### 7.1 Folder structure (proposed — nothing created yet)

```
SSCTC Shop/
├─ PROJECT_PLAN.md
├─ DATABASE_SCHEMA.md
├─ DEPLOYMENT_PLAN.md
├─ old_plans_reference/         previous plan
├─ web/                         Next.js, static export
│  ├─ app/
│  │  ├─ login/
│  │  ├─ portal/                customer self-service portal: login, dashboard,
│  │  │                         invoices, due balance, payments, warranty status
│  │  └─ (admin)/               dashboard, pos, sales, returns, customers, dues, payments,
│  │                            suppliers, purchases, expenses, cash-register,
│  │                            products, categories, services, inventory,
│  │                            reports, users, settings
│  ├─ components/
│  └─ lib/                      API client, formatting, print layouts (A4 & thermal), QR generator
├─ api/                         Express
│  ├─ app.js                    startup file named in cPanel
│  ├─ src/
│  │  ├─ config/  db/  middleware/
│  │  ├─ modules/               auth, portal, users, catalog, inventory, suppliers, purchases,
│  │  │                         customers, sales, returns, payments, expenses,
│  │  │                         cash-register, reports, settings
│  │  └─ lib/                   audit, money, whatsapp, qr
│  ├─ migrations/
│  ├─ seeds/
│  ├─ scripts/                  cron jobs: backup-db, prune-logs
│  └─ tests/
└─ .gitignore
```

Local development needs real MySQL 8.0 on the PC, not XAMPP's MariaDB.

### 7.2 Modules affected by the scope update

No code exists, so nothing needs rewriting. Relative to the previous plan:

| Module | Change |
|---|---|
| `orders`, `files`, `pricing`, notifications | Removed |
| `sales`, `customers`, `returns` | New |
| `suppliers`, `purchases` | New (Accounts Payable & purchase stock-in) |
| `expenses`, `cash-register` | New (Daily expense tracking & cash drawer reconciliation) |
| `portal` | New (Read-only customer self-service portal via mobile+PIN & QR) |
| `payments` | Redesigned (allocations, advance balance, verification flag, receipts) |
| `services` | Simplified to a dynamic rate list |
| `catalog`, `inventory`, `auth`, `users`, `reports`, `settings` | Kept, trimmed to internal use, enhanced with P&L and serial/warranty |
| Web: `(public)`, `(shop)` areas | Removed |
| Web: `portal`, `pos`, `customers`, `dues`, `suppliers`, `expenses`, `cash-register` screens | New |
| All plan documents | Rewritten; previous versions archived |

### 7.3 API endpoints

All under `/api/v1`. Staff endpoints require staff session; portal endpoints require customer session or QR token.

| Area | Endpoints |
|---|---|
| Health, auth | `GET /health` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` |
| Customer Portal | `POST /portal/login` · `POST /portal/logout` · `GET /portal/me` · `GET /portal/invoices` · `GET /portal/invoices/:id` · `GET /portal/payments` · `POST /portal/change-pin` · `GET /portal/view/:token` (QR token auto-view) |
| Dashboard | `GET /dashboard` |
| Catalog | CRUD on `/categories`, `/products`, `/services` · `GET /catalog/search` (POS lookup) |
| Inventory | `GET /inventory/movements` · `POST /inventory/stock-in` · `POST /inventory/adjustments` · `GET /inventory/low-stock` · `GET /inventory/reconcile` |
| Suppliers | CRUD on `/suppliers` · `GET /suppliers/:id/statement` · `POST /suppliers/:id/opening-payable` · `GET/POST /purchases` · `GET /purchases/:id` · `POST /supplier-payments` |
| Customers | CRUD on `/customers` · `GET /customers/:id/statement` · `POST /customers/:id/opening-balance` · `POST /customers/:id/advance-deposit` · `POST /customers/:id/reset-pin` · `GET /dues` |
| Sales & POS | `GET /sales` · `POST /sales` · `GET /sales/:id` · `POST /sales/:id/void` · `GET /sales/:id/invoice` (HTML/PDF & thermal) · `POST /sales/:id/returns` · `GET /sales/:id/whatsapp-link` |
| Payments | `GET /payments` · `POST /payments` · `GET /payments/:id` · `POST /payments/:id/verify` · `POST /payments/:id/unverify` · `POST /payments/:id/void` · `GET /payments/:id/receipt` |
| Expenses & Cash | CRUD on `/expenses` · `GET/POST /expense-categories` · `GET /cash-register/current` · `POST /cash-register/close` · `GET /cash-register/history` |
| Reports | `GET /reports/sales` · `/reports/profit-loss` · `/reports/expenses` · `/reports/payments` · `/reports/dues` · `/reports/suppliers` · `/reports/cash-closings` · `/reports/stock` (each with `?format=csv`) |
| System | CRUD on `/users` · `GET /roles` · `GET/PUT /settings` · `GET /audit-logs` · `GET /system/backup` (Owner downloads the latest database dump) |

### 7.4 Environment variable template

```
# --- api ---
NODE_ENV=production
APP_BASE_URL=https://shop.sscomputertrainingcentre.com
API_BASE_PATH=/api
CORS_ORIGIN=https://shop.sscomputertrainingcentre.com
TRUST_PROXY=1

DB_HOST=localhost
DB_PORT=3306
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_POOL_MAX=5

SESSION_COOKIE_NAME=ssctc_sid
SESSION_COOKIE_DOMAIN=
SESSION_HOURS=12
SESSION_IDLE_HOURS=2

BACKUP_DIR=/home/<user>/ssctc-shop-backups

# --- web (build time, public — never put secrets here) ---
NEXT_PUBLIC_API_URL=/api/v1
```

There are no payment-gateway, SMS or email variables.

### 7.5 Migrations and seeds

- Numbered migration files, applied in order and recorded in a migrations table. A
  migration that has run on the live database is never edited.
- Seeds, safe to re-run: roles and permissions, default settings, the first Owner
  account (password supplied at run time).
- Demo data is a separate local-only seed.
- A backup is taken before every live migration.

**Migration plan for this scope update:** none is needed. No database has been
created, so the revised schema simply becomes the first migration in Milestone 1.

### 7.6 Testing plan

| Level | What | When |
|---|---|---|
| Unit | Sale totals, payment allocation, due and balance derivation, cash drawer calculations, P&L formulas, validation schemas | Every change |
| Integration (API + real MySQL test database) | Login and lockout, permissions, sale completion, stock movement, purchases, payments, expenses, cash closing, voids | Every change |
| Concurrency | 20 simultaneous sales of a product with stock 5 → exactly 5 succeed; one sale submitted twice → one sale; two users verifying one payment → one change; two payments against one due → never overpaid | Milestones 3 and 4 |
| Reconciliation | After a scripted day of sales, payments, purchases, expenses and voids: ledger equals stock, customer balances equal sum of sale dues, cash drawer math equals actual physical counts | Milestones 4 and 5 |
| Live acceptance | Checklist run by the owner on the real hosting, on the shop PC and a phone | End of every milestone |
| Restore drill | Restore the latest backup into a scratch database | Before launch |

---

## 8. Milestones

Estimates are provisional effort figures, not commitments. Milestone 0 can change
what follows it.

| # | Milestone | Deliverables | Depends on | Acceptance criteria | Tests | Estimate |
|---|---|---|---|---|---|---|
| 0 | Hosting verification | Throwaway test app; completed checklist in DEPLOYMENT_PLAN.md §2; go / fallback / upgrade decision | Subdomain created; cPanel access | Every checklist row has a recorded result; chosen layout proven end to end with a database transaction | The checklist | 2–3 days |
| 1 | Foundation | `web` and `api` skeletons; first migration (full schema); seeds; login; roles and permissions; audit log; deploy routine | M0 | Owner logs in on the live site; Staff is refused Owner-only actions; lockout after 5 bad passwords; logged-out visitors see only the login page | Unit and integration for auth and permissions | 1–1.5 weeks |
| 2 | Catalog, inventory, suppliers & purchases | Categories, products, services; stock-in, adjustments, movement history; suppliers, purchase bills, stock-in from purchase, supplier payables | M1 | Owner adds products/services and suppliers; stock updates automatically on purchase bill; cost price tracked; stock cannot go negative | Integration and concurrency on stock & purchases | 1.5–2 weeks |
| 3 | Customers, POS & sales | Customers (due + advance wallet); POS screen (A4 + 58mm/80mm thermal receipts, warranty/serial notes); sale completion; sale returns & voids | M2 | POS sale completes cleanly; stock reduces; thermal receipt formats correctly; sale return restocks inventory and refunds/credits customer | Concurrency suite; integration for sale and return | 1.5–2 weeks |
| 4 | Payments, dues, expenses & cash closing | Payment entry; allocation; verify/unverify; due collection; supplier payments; daily expenses; daily cash drawer closing & discrepancy log | M3 | Cash drawer reconciles expected cash vs physical cash; expenses deduct from cash float; customer dues & supplier payables update cleanly | Concurrency and reconciliation suites | 1.5–2 weeks |
| 5 | Dashboard & financial reports | Dashboard (sales, expenses, profit, cash status, dues); P&L report; sales, expense, due, and supplier reports; CSV export | M4 | Net profit matches Gross Profit minus Expenses; report totals match manual sums of invoices and expense vouchers | Reconciliation suite | 1–1.5 weeks |
| 6 | Hardening and launch | Backups and restore drill; security headers; real products, opening dues & payables entered; short user guide | M5 | Launch checklist passes; restore drill succeeds; owner completes a full day of sales, expenses, cash closing and reports unaided | Full acceptance and security checks | 0.5–1 week |

Provisional total: **roughly 7–10 weeks of effort**, plus the owner's review time
between milestones.

**Recommended next milestone: Milestone 0.** It needs no application code, costs a
few days, and is the only way to learn whether this hosting plan can run the system.

---

## 9. Decisions requiring approval

| # | Decision | Provisional default |
|---|---|---|
| D1 | Architecture | Static Next.js + one Express API at `/api`; fallback API subdomain |
| D2 | Effect of unverified payments | They do not reduce the due; shown separately as "awaiting verification". Cash is verified on entry |
| D3 | Dues and walk-in customers | A sale can only be left with a due if a saved customer is attached |
| D4 | Staff role | Staff can sell, record payments, view stock and enter daily expenses. Only the Owner verifies payments, voids, edits prices, adjusts stock, manages suppliers/purchases, closes cash drawer and manages users |
| D5 | Customer advances & overpayment | Supported; surplus payments are stored in `customers.advance_balance` for future purchases or due settlement |
| D6 | Printing and photocopy | Sold as service lines from a rate list; no automatic price calculator |
| D7 | If Milestone 0 fails | Owner chooses between a higher hosting package and a VPS |

## 10. Business questions

- **Q1. Unverified payments (D2).** When a customer says they sent bKash and it has
  not been checked yet, should the due stay open until verified (the default), or
  drop immediately and be flagged for checking?
- **Q2. Users (D4).** Will anyone besides the owner use the system? If yes, is the
  Staff permission split above right?
- **Q3. Existing dues.** Do customers already owe money that must be entered as
  opening balances at launch? Roughly how many customers?

Needed before Milestone 6, not now: the product list with stock counts, the service
rate list, shop details for the invoice header.
