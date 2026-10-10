# SSCTC Shop — Project Plan

Computer shop, printing, photocopy and online services web application for
`shop.sscomputertrainingcentre.com`.

Status: **plan awaiting approval — no application code has been written.**
Last revised: 2026-10-09

Companion documents:

- [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) — tables, constraints, transaction rules
- [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) — hosting verification, deployment, backups

Every statement in these documents carries one of four labels:

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
- The main domain is `sscomputertrainingcentre.com`; the shop will use the subdomain `shop.`.
- Preferred stack: Next.js + React (JavaScript), Node.js + Express, MySQL.
- The owner is not a web developer; day-to-day operation must be possible from an admin panel only.

### Assumptions

- The Node.js page is CloudLinux "Node.js Selector" running apps under Phusion Passenger (the usual setup on cPanel shared hosting).
- The account has per-account limits on memory, CPU and process count that are too small to run `next build` on the server.
- Free SSL (AutoSSL / Let's Encrypt) is available for the subdomain.
- The hosting can send email through its own SMTP server.
- One shop location, prices in BDT, no VAT line on invoices.

### Verify (all covered by Milestone 0 — see DEPLOYMENT_PLAN.md §2)

- Which Node.js versions are offered, and the account's memory / process / CPU limits.
- Whether an app can be mounted at `/api` on the subdomain while static files are served from the same subdomain.
- How the app is started, restarted and what happens when it is idle or crashes.
- Whether environment variables set in cPanel reach the app, and where cPanel stores them.
- Whether files written outside `public_html` persist, and the maximum upload size.
- Whether SSH, cron jobs, remote MySQL and SMTP are available on this package.

---

## 2. Architecture

### 2.1 Options compared

| | A. Next.js full-stack | B. Static Next.js + Express API | C. Next.js server + Express, two apps |
|---|---|---|---|
| What runs on Node | One Next.js server (pages + API routes) | One Express app (API only) | Two Node apps |
| Who serves pages | Node, on every request | The web server, as plain files | Node (Next.js) |
| Memory on shared hosting | High; Next.js server is heavy | Low; one small Express process | Highest; two processes share one limit |
| If the Node app is down or restarting | Whole site is down | Pages still load; only login/ordering fail | Whole site is down |
| Cold start after idle | Slow first page load | Only the first API call is slow | Slow, twice |
| Product pages visible to Google / Facebook previews | Yes | Weak — product data loads in the browser | Yes |
| Uses Express | No | Yes | Yes |
| Deployment | Build locally, upload build, custom start file | Upload static files + upload API | Two separate deployments |
| Host Node version constraint | Must satisfy Next.js | Only Express; Next.js is built on the dev PC | Must satisfy both |
| Risk on this hosting | Medium–high | Low | High |

### 2.2 Recommendation — **Decision D1**

**Primary: Option B, same origin.**

```
https://shop.sscomputertrainingcentre.com/        static files (Next.js export) served by the web server
https://shop.sscomputertrainingcentre.com/api/*   one Express app run by cPanel Node.js (Passenger)
MySQL 8.0.46                                      cPanel database, reached from Express only
/home/<user>/ssctc-shop-storage/                  private file storage, outside public_html
```

Why: it puts the least load on a hosting plan whose limits are unknown, keeps the
public site up even when the Node process is restarting, and removes the server's
Node version from the Next.js equation. The API and the pages share one origin, so
login cookies work without cross-site configuration.

**Fallback: Option B, API on its own subdomain** (`shop-api.sscomputertrainingcentre.com`).
Used if mounting an app at `/api` conflicts with the static files on this hosting.
Same code; only CORS and cookie settings change through environment variables.

**If Express itself cannot run reliably on this plan** (Node too old, process killed
under normal load), no architecture will work on it. The choice is then a higher
hosting package or a small VPS — the same code deploys unchanged. This is a cost
decision for the owner, taken only if Milestone 0 fails.

Option A is not the fallback because it needs strictly more from the hosting than
B does. It remains a possible later upgrade if Milestone 0 shows plenty of headroom.
Option C is rejected for shared hosting.

### 2.3 What Option B costs

- **Product URLs use a query string** (`/product/?slug=a4-paper-500`), because a static
  site cannot generate a new page each time a product is added in the admin panel.
- **Weak search-engine and Facebook-preview support for individual products.** The home,
  services and category landing pages are fully static and index normally. A later
  fix is a small Express-rendered share page per product.
- **No Next.js server features**: no server components fetching live data, no
  middleware, no built-in image optimisation. Product images are resized once at
  upload time instead.
- **Admin pages are downloadable by anyone** as empty shells. This is acceptable
  because every piece of data and every action is authorised by the API, never by
  the page.

### 2.4 Design rules that follow from shared hosting

- The Express app must not rely on staying alive. Sessions, rate-limit counters and
  anything else that matters live in MySQL, not in memory.
- No background timers inside the app. Scheduled work (file deletion, expiring
  unpaid orders, backups) runs from cPanel Cron Jobs.
- The API's base path and allowed origin are configuration, so primary and fallback
  need no code change.
- Dependencies that need compiling on the server are avoided (for example the
  pure-JavaScript `bcryptjs` and `mysql2`).
- Customer files are stored outside `public_html` and outside the app folder, so a
  redeploy can never delete or expose them.

---

## 3. Functional requirements

**L** = required for launch. **P2** = phase 2, after launch. The database schema
covers both from the start so phase 2 needs no restructuring.

### 3.1 Public site

| Feature | |
|---|---|
| Home page: shop introduction, services, featured products, offers | L |
| Contact page: address, map, phone, WhatsApp link, opening hours (all editable in settings) | L |
| Service list with current rates | L |
| Bangla / English switch | P2 (see question Q3) |

### 3.2 Product catalog

| Feature | |
|---|---|
| Categories (two levels), product list, product detail, multiple images | L |
| Search by name; filter by category; sort by price / newest | L |
| Stock shown as In stock / Low stock / Out of stock (not exact numbers) | L |
| Out-of-stock products cannot be added to the cart | L |
| Discount price ("was / now") | L |
| Coupons, product reviews | P2 |

### 3.3 Printing and photocopy ordering

| Feature | |
|---|---|
| Upload PDF, JPG or PNG; pages counted automatically | L |
| Choose paper size, colour mode, sides, copies, extras; live price | L |
| DOC/DOCX accepted with "price confirmed by staff" (page count is unreliable) | L |
| Free-text instructions per file | L |
| Staff print queue with secure download and "printed" marking | L |
| Page ranges and mixed colour within one file | P2 |

Pricing rules are in §4.

### 3.4 Online application and digital services

| Feature | |
|---|---|
| Admin-defined service list, each with its own rate entries | L |
| Three pricing modes: fixed, "starting from", quote by staff | L |
| Customer request form with details and optional document upload | L |
| Staff sets the final price on quoted requests before payment | L |
| Per-service custom form fields | P2 |

### 3.5 Cart and checkout

| Feature | |
|---|---|
| One cart holding products, print jobs and service requests | L |
| Cart kept in the browser; every price and stock level re-checked by the server at checkout | L |
| Pickup from shop | L |
| Home delivery with a flat charge per area | L (see question Q2) |
| Payment choice: cash on pickup/delivery, bKash, Nagad | L |
| Protection against double submission | L |

### 3.6 Customer accounts — **Decision D3**

| Feature | |
|---|---|
| Register and log in with mobile number + password; email optional | L |
| An account is required to place an order (needed to protect uploaded files) | L |
| Order history, order detail, live status | L |
| Password reset by shop staff issuing a temporary password | L |
| Self-service reset by SMS code | P2 |

### 3.7 Admin dashboard and roles

| Feature | |
|---|---|
| Dashboard: new orders, payments awaiting verification, print queue, low stock | L |
| Roles: Owner (everything), Manager (no user/role/settings changes), Staff (orders, print queue, stock view) | L |
| Permission list per role stored in the database | L |
| Staff user management by the Owner | L |
| Editable permission matrix in the UI | P2 |

### 3.8 Inventory, purchases, stock adjustments

| Feature | |
|---|---|
| Stock movement ledger: every change recorded with reason and user | L |
| Manual stock-in / stock-out adjustments with a note | L |
| Automatic deduction on order, automatic return on cancellation | L |
| Low-stock list | L |
| Suppliers and purchase entries that add stock and record cost | P2 |
| Counter (walk-in) sales entry | P2 (see question Q1) |

### 3.9 Invoices, receipts, expenses, reports

| Feature | |
|---|---|
| Printable invoice / receipt per order | L |
| Daily and monthly sales summary; sales by category; order list export (CSV) | L |
| Expense entry by category | P2 |
| Profit report (sales − cost of goods − expenses) | P2 |
| Supplier dues | P2 |

### 3.10 Manual bKash / Nagad verification

| Feature | |
|---|---|
| Checkout shows the shop's bKash / Nagad number and the amount | L |
| Customer submits sender number and transaction ID (TrxID) | L |
| Staff verify or reject against the shop's own bKash/Nagad statement | L |
| A TrxID cannot be used on two orders | L |
| Every verify / reject is logged with user, time and before/after values | L |
| Partial payment and advance payment | L |
| Automatic gateway (bKash merchant API, SSLCommerz) | P2 |

### 3.11 Order status and notifications

Status flow:

```
pending → confirmed → processing → ready → completed
                                     └→ out_for_delivery → completed
any state before completed → cancelled
```

| Feature | |
|---|---|
| Status timeline visible to the customer | L |
| Email to the shop on every new order and payment submission | L |
| Email to the customer on status change, when an email is on file | L |
| WhatsApp click-to-chat link on the order page | L |
| SMS notifications (paid per message) | P2 |

---

## 4. Printing and photocopy pricing

### 4.1 Configurable elements (all editable in the admin panel)

| Element | Example values | Stored in |
|---|---|---|
| Service | Printing, Photocopy | `services` |
| Paper size | A4, Legal, Letter, A3 | `paper_sizes` |
| Colour mode | Black-and-white, Colour | `print_rates.color_mode` |
| Sides | Single, Double | `print_rates.sides` |
| Quantity tier | 1–20, 21–100, 101+ | `print_rates.min_qty` / `max_qty` |
| Price per printed side | set by the owner | `print_rates.unit_price` |
| Minimum charge per job | set by the owner | `services.min_charge` |
| Extras | Stapling, spiral binding, lamination, thick paper, urgent | `print_extras` |

A rate is one row for a combination of *service + paper size + colour mode + sides +
quantity tier*. A combination with no active rate is not offered to customers.

### 4.2 Calculation

```
printed sides  = pages × copies
sheets         = pages × copies                 (single-sided)
               = round-up(pages ÷ 2) × copies   (double-sided)

unit price     = the active rate whose tier contains "printed sides"
base amount    = printed sides × unit price

extras amount  = sum over chosen extras:
                   per order  → price
                   per copy   → price × copies
                   per side   → price × printed sides
                   per sheet  → price × sheets

subtotal       = base amount + extras amount
job total      = the larger of subtotal and the service's minimum charge,
                 rounded up to a whole taka
```

Worked example with **illustrative** rates (not the shop's real prices): a 15-page
PDF, 3 copies, A4, black-and-white, double-sided, stapled. Rate 2.50 per side,
stapling 5.00 per copy, minimum charge 10.00.

```
printed sides = 15 × 3 = 45        sheets = 8 × 3 = 24
base   = 45 × 2.50 = 112.50
extras = 5.00 × 3  = 15.00
total  = 127.50 → 128 taka
```

Rounding up to a whole taka is **Decision D6**.

### 4.3 Keeping historical orders stable

- The browser's price is a preview only. The server recalculates from the current
  rates at the moment the order is placed and ignores any price sent by the browser.
- The result is copied into the order: page count, copies, options, the unit price
  used, each extra's name and price, the minimum charge applied and the totals.
- Orders are always displayed, invoiced and reported from these stored copies, never
  recalculated. Changing or deleting a rate later cannot alter an existing order.
- Product and service lines follow the same rule: name, unit price and cost price
  are copied into the order line.
- Rate changes are recorded in the audit log.

---

## 5. Security and privacy

| Area | Approach |
|---|---|
| Passwords | bcrypt, cost 12, minimum 8 characters; never logged, never emailed |
| Sessions | Random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only its SHA-256 hash is stored in MySQL; can be revoked individually. Customers: 30 days. Staff: 12 hours, 2 hours idle |
| CSRF | `SameSite=Lax` plus an `Origin` header check on every state-changing request; JSON bodies only |
| Authorisation | Checked in the API on every request by permission code. Customers can read only their own orders, files and payments |
| Login rate limiting | Counted in MySQL: 5 failures per mobile number in 15 minutes locks that number for 15 minutes; 20 failures per IP in 15 minutes blocks that IP. Same generic error for wrong number and wrong password |
| Input validation | A schema per endpoint; unknown fields rejected; length and range limits everywhere |
| SQL injection | Parameterised queries only; sort and filter columns chosen from fixed allow-lists |
| Output | React escapes by default; no raw HTML from user input; security headers and Content-Security-Policy |
| Transport | HTTPS only, HTTP redirected, HSTS |
| Secrets | Environment variables only; `.env` never committed; separate values for local and live |
| Audit | Payment actions, price/rate changes, stock adjustments, role changes and file downloads recorded with user, time, IP |

### 5.1 Customer file handling

Customers will upload ID cards, certificates and similar documents. Rules:

1. Files are written to a folder **outside `public_html`** that no URL maps to.
2. Stored names are random; the original name is kept only in the database.
3. Accepted types are an allow-list (PDF, JPG, PNG, DOC, DOCX), checked by file
   content as well as by extension. Size limit 20 MB per file (setting).
4. The only way to read a file is an API endpoint that checks the session: the
   customer who uploaded it, or staff holding the file-download permission.
   Files are sent as downloads, never rendered inline from the shop's domain.
5. Every staff download is logged.
6. Retention (**Decision D5**): files are deleted 7 days after the order is completed
   or cancelled; uploads never attached to an order are deleted after 24 hours.
   Both periods are settings. The database keeps the record that a file existed
   and when it was deleted, not the file.
7. Customer files are excluded from backups, so deletion is final.

Remaining risk: shared hosting normally offers no virus scanning of uploads. Staff
should open customer files in a PDF/image viewer and never enable macros in Word
documents.

Backup and restore are described in DEPLOYMENT_PLAN.md §6.

---

## 6. Project structure and workflow

### 6.1 Folder structure (proposed — nothing created yet)

```
SSCTC Shop/
├─ PROJECT_PLAN.md
├─ DATABASE_SCHEMA.md
├─ DEPLOYMENT_PLAN.md
├─ web/                         Next.js, static export
│  ├─ app/
│  │  ├─ (public)/              home, services, products, product, contact
│  │  ├─ (shop)/                cart, checkout, print, service-request
│  │  ├─ account/               login, register, orders, order
│  │  └─ admin/                 dashboard, orders, print-queue, payments,
│  │                            products, categories, inventory, services,
│  │                            rates, reports, users, settings
│  ├─ components/
│  ├─ lib/                      API client, cart store, price preview, formatting
│  └─ public/
├─ api/                         Express
│  ├─ app.js                    startup file named in cPanel
│  ├─ src/
│  │  ├─ config/                environment loading and validation
│  │  ├─ db/                    connection pool, transaction helper
│  │  ├─ middleware/            session, permission, validation, rate limit, errors
│  │  ├─ modules/               auth, users, catalog, inventory, services, pricing,
│  │  │                         orders, payments, files, reports, settings
│  │  │                         (each: routes, service, queries, schemas)
│  │  └─ lib/                   mail, audit, money, pdf page count
│  ├─ migrations/               numbered schema changes
│  ├─ seeds/                    roles, permissions, settings, owner account
│  ├─ scripts/                  cron jobs: cleanup-files, expire-orders, backup-db
│  └─ tests/
└─ .gitignore
```

Local development needs real MySQL 8.0 on the PC. XAMPP ships MariaDB, which
behaves differently in places this schema relies on, so it should not be used.

### 6.2 API endpoints

All under `/api/v1`. Access: **P** public, **C** logged-in customer, **S** staff with
the relevant permission.

| Area | Endpoints | Access |
|---|---|---|
| Health | `GET /health` | P |
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` | P / C |
| Public content | `GET /settings/public` · `GET /categories` · `GET /products` · `GET /products/:slug` · `GET /services` · `GET /services/:slug` · `GET /print/options` | P |
| Print | `POST /print/quote` · `POST /files` · `GET /files/:id/download` · `DELETE /files/:id` | C |
| Checkout | `POST /cart/validate` · `POST /orders` | C |
| My orders | `GET /orders` · `GET /orders/:orderNo` · `POST /orders/:orderNo/payments` · `POST /orders/:orderNo/cancel` | C |
| Admin: dashboard | `GET /admin/dashboard` | S |
| Admin: orders | `GET /admin/orders` · `GET /admin/orders/:id` · `PATCH /admin/orders/:id/status` · `PATCH /admin/orders/:id/quote` · `GET /admin/orders/:id/invoice` | S |
| Admin: print queue | `GET /admin/print-jobs` · `PATCH /admin/print-jobs/:id` | S |
| Admin: payments | `GET /admin/payments` · `POST /admin/payments/:id/verify` · `POST /admin/payments/:id/reject` · `POST /admin/orders/:id/payments` (cash) | S |
| Admin: catalog | CRUD on `/admin/categories`, `/admin/products`, `/admin/products/:id/images` | S |
| Admin: inventory | `GET /admin/inventory/movements` · `POST /admin/inventory/adjustments` · `GET /admin/inventory/low-stock` · `GET /admin/inventory/reconcile` | S |
| Admin: services and rates | CRUD on `/admin/services`, `/admin/service-rates`, `/admin/paper-sizes`, `/admin/print-rates`, `/admin/print-extras` | S |
| Admin: reports | `GET /admin/reports/sales` · `GET /admin/reports/orders.csv` | S |
| Admin: users | CRUD on `/admin/users` · `POST /admin/users/:id/reset-password` · `GET /admin/roles` | S (Owner) |
| Admin: system | `GET/PUT /admin/settings` · `GET /admin/audit-logs` | S (Owner) |
| Phase 2 | `/admin/suppliers` · `/admin/purchases` · `/admin/expenses` · `/admin/reports/profit` · `/admin/counter-sales` | S |

### 6.3 Environment variable template

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
SESSION_CUSTOMER_DAYS=30
SESSION_STAFF_HOURS=12

STORAGE_PRIVATE_DIR=/home/<user>/ssctc-shop-storage/private
STORAGE_PUBLIC_DIR=/home/<user>/public_html/<subdomain-root>/media
UPLOAD_MAX_MB=20

SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
SHOP_NOTIFY_EMAIL=

CRON_SECRET=

# --- web (build time, public — never put secrets here) ---
NEXT_PUBLIC_API_URL=/api/v1
NEXT_PUBLIC_SITE_URL=https://shop.sscomputertrainingcentre.com
```

Business values (rates, bKash number, retention days, delivery charges, opening
hours) are **not** environment variables; they live in the `settings` table so the
owner can change them.

### 6.4 Migrations and seeds

- Schema changes are numbered migration files, applied in order and recorded in a
  migrations table. A migration that has run on the live database is never edited;
  corrections are new migrations.
- Seeds, safe to run repeatedly: roles and permissions, default settings, paper
  sizes, the two print services, and the first Owner account (password supplied at
  run time, never stored in a file).
- Demo data (sample products and rates) is a separate seed for local use only.
- How migrations are run on the live server depends on Milestone 0 (SSH, the cPanel
  script runner, or remote MySQL) — see DEPLOYMENT_PLAN.md §4.
- A database backup is taken before every live migration.

### 6.5 Testing plan

| Level | What | When |
|---|---|---|
| Unit | Print price calculation, rounding, order status transitions, payment status derivation, input schemas | Every change |
| Integration (API + real MySQL test database) | Auth and lockout, permissions per role, order placement, stock movement, payment verification, file access | Every change |
| Concurrency | 20 simultaneous orders for a product with stock 5 → exactly 5 succeed, stock ends at 0, ledger matches; repeated submission with one key → one order; two staff verifying one payment → one verification | Milestones 4 and 7 |
| Security checks | Customer A cannot read customer B's order or file; staff role limits; upload of disguised file types; direct URL guesses for uploads return nothing | Milestones 5 and 8 |
| Live acceptance | Checklist run by the owner on the real hosting, on a phone and a PC | End of every milestone |
| Restore drill | Restore the latest backup into a scratch database and compare row counts | Before launch |

---

## 7. Milestones

Durations are effort estimates and are **provisional**. The earlier seven-week
figure covered a smaller scope and should not be relied on. Milestone 0 can change
everything after it.

### Launch set

| # | Milestone | Deliverables | Depends on | Acceptance criteria | Tests | Estimate |
|---|---|---|---|---|---|---|
| 0 | Hosting verification | Throwaway test app and static page on the subdomain; completed checklist in DEPLOYMENT_PLAN.md §2; go / fallback / upgrade decision | Subdomain created; owner's cPanel access | Every checklist row has a recorded result; primary or fallback proven end to end, including a database read and a private file write | The checklist itself | 2–4 days |
| 1 | Foundation | Repository, `web` and `api` skeletons, all launch migrations, seeds, sessions, login, roles and permissions, audit log, error handling, deploy routine | M0 | Owner logs in on the live site; a Staff user is refused Owner-only endpoints; lockout triggers after 5 bad passwords; migrations run on live from empty | Unit and integration for auth and permissions | 1–1.5 weeks |
| 2 | Catalog | Admin categories, products, images; public home, product list, search, product page, contact; settings screen | M1 | Owner adds a product with images from a phone and sees it publicly without developer help; archived products disappear; search finds by partial name | Integration for catalog; image upload type and size checks | 1.5–2 weeks |
| 3 | Inventory | Movement ledger, adjustments, low-stock list, reconciliation report | M2 | Every stock change has a ledger row with user and reason; stock can never go below zero; reconciliation shows no difference | Integration and concurrency on adjustments | 3–5 days |
| 4 | Cart, checkout, orders | Cart, checkout, pickup/delivery, order placement, customer order pages, admin order list and status changes, status history | M3 | Order of mixed products reduces stock once; cancelling returns it; double-click creates one order; price changed mid-checkout is caught; invalid status jumps refused | Concurrency suite; integration for all transitions | 1.5–2 weeks |
| 5 | Printing and photocopy | Rate, paper size and extras admin; private upload; page counting; price preview; print jobs in orders; staff print queue; retention job | M4; real rates from the owner | Price matches a hand calculation for 10 agreed cases; rate change leaves old orders unchanged; another customer and a logged-out visitor cannot fetch a file; files vanish after the retention period | Unit for pricing; security checks on files | 1.5–2 weeks |
| 6 | Online services | Service and rate admin; request form with documents; staff quoting; services in cart and orders | M4; service list from the owner | Fixed, starting-from and quote services each complete an order; a quoted order cannot be paid before staff set the price | Integration per pricing mode | 1 week |
| 7 | Payments, invoices, reports | bKash/Nagad submission; verification screen; cash recording; partial payments; printable invoice; sales reports; CSV export | M4 | A TrxID cannot be accepted twice; order payment status always equals the sum of verified payments; every verification appears in the audit log; daily report total equals the sum of that day's invoices | Concurrency on verification; integration for payment states | 1–1.5 weeks |
| 8 | Notifications, hardening, launch | Emails; cron jobs live; backups and restore drill; security headers; mobile polish; real content loaded; owner training notes | M5, M6, M7 | Full acceptance checklist passes on live; a restore drill succeeds; the owner completes one order of each kind unaided | Full security checklist; restore drill | 1–1.5 weeks |

Provisional total for the launch set: **roughly 9–13 weeks of effort**, plus the
owner's review time between milestones. After Milestone 2 the site can already go
live as an online catalog if an early public presence is wanted.

### Phase 2 (order to be agreed after launch)

| # | Milestone | Depends on |
|---|---|---|
| 9 | Suppliers and purchases | M3 |
| 10 | Counter sales entry | M4, M7 |
| 11 | Expenses and profit report | M7, M9 |
| 12 | SMS notifications and self-service password reset | M8; SMS provider account |
| 13 | Payment gateway | M7; merchant account |
| 14 | Bangla / English switch, coupons, product share pages | M8 |

---

## 8. Decisions requiring approval

| # | Decision | Provisional default |
|---|---|---|
| D1 | Architecture | Static Next.js + one Express API at `/api`; fallback API on its own subdomain |
| D2 | Launch scope | The **L** items in §3; purchases, counter sales, expenses, profit reports, SMS and gateway in phase 2 |
| D3 | Customer login | Mobile number + password; account required to order; reset by staff |
| D4 | Stock timing | Stock is deducted when the order is placed; unpaid bKash/Nagad orders are cancelled automatically after 24 hours and stock returned |
| D5 | File rules | PDF/JPG/PNG/DOC/DOCX, 20 MB, deleted 7 days after completion |
| D6 | Print rounding | Each print job rounded up to a whole taka |
| D7 | Advance payment for print orders | Not required; cash on pickup allowed |
| D8 | If Milestone 0 fails | Owner chooses between a higher hosting package and a VPS |

## 9. Business questions

Only these three change the design. Everything else has a default above.

- **Q1. Walk-in sales.** Will stationery and gadgets sold at the counter be entered
  into this system? If not, website stock will drift from the shelf, and the site
  should show availability as "confirm by phone" rather than promise stock. If yes,
  counter sales entry should move from phase 2 into the launch set.
- **Q2. Delivery.** Pickup only, or home delivery too? If delivery: which areas and
  what charge?
- **Q3. Language.** Should the site launch in Bangla, in English, or with both?

Needed later, not now: the real print/photocopy rates and the list of online
services with charges (before Milestones 5 and 6), the shop's bKash/Nagad numbers,
logo and colours.
