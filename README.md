# SSCTC Shop

Shop management system for SS Computer Training Centre: an Express API (`api/`)
and a Next.js front end exported as static files (`web/`), on MySQL 8.

Plans: [PROJECT_PLAN.md](PROJECT_PLAN.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md)

## What exists (Milestone 1 — Foundation)

- Full database schema as one SQL migration, plus base data (roles, permissions, settings, expense categories, document counters).
- Staff login with username + password; Owner and Staff roles with permissions.
- Customer portal login with mobile number + 6-digit PIN.
- Sessions, login lockout, audit log, request hardening.
- Branded layout: login screens, staff shell with the full menu, dashboard placeholder, customer portal home.

## What exists (Milestone 2 — Catalog, inventory, suppliers, purchases)

- Categories (two levels), products, and the service rate list.
- Stock-in, stock adjustments with a mandatory reason, movement history, low-stock list, ledger reconciliation. Stock can never go below zero.
- Suppliers with opening payable; purchase bills that add stock, update cost price and track what is owed. A bill is stored once even if saved twice, and an unpaid bill can be voided with a reason.
- A user whose password was set by the Owner can do nothing until they change it.
- Owner manages everything; Staff can view products and stock only, and never sees cost prices.
- Screens: Products, Categories, Services, Inventory, Suppliers, Purchases, New purchase.

## What exists (Milestone 3, part 1 — Customers, POS, sales)

- Customers with an automatically issued 6-digit portal PIN, PIN reset, and opening due.
- POS: products and services on one bill, scan or type a code, warranty and serial number, discount, split payment, walk-in or saved customer.
- Sales list and detail; verify, unverify and void payments; void a sale (stock returns).
- Printable invoice in A4, 80mm and 58mm thermal layouts; share the bill to WhatsApp.
- Screens: New sale, Sales, Invoice, Customers.

## What exists (Milestone 3, part 2 — Returns, advance, QR, portal)

- Sale returns: products come back into stock; their value cancels the due first and the rest is refunded in cash or as advance credit.
- Customer advance balance: deposits with a receipt, paying a bill from the balance, full history.
- QR code on every invoice that opens that one bill without logging in.
- Customer portal: own bills, payment receipts, warranties with days left, advance history. Read-only.

Still to come: due collection, payments list, expenses and cash closing
(Milestone 4), dashboard figures and reports (5).

To package a release for cPanel: `powershell -File scripts\package-release.ps1`,
then follow DEPLOYMENT_PLAN.md §9.

## Requirements

- Node.js 20 or newer (22+ preferred)
- MySQL 8.0 — real MySQL, not XAMPP's MariaDB

## Run locally

```
# 1. Database: create an empty database and a user for it in MySQL, then
cd api
copy .env.example .env        # fill in DB_NAME, DB_USER, DB_PASSWORD
npm install
npm run migrate               # creates every table
npm run seed                  # base data; asks for the first Owner's username and password
npm run dev                   # API on http://localhost:4000

# 2. Front end, in a second terminal
cd web
copy .env.example .env.development.local
npm install
npm run dev                   # site on http://localhost:3000
```

Staff log in at `/login/`, customers at `/portal/login/`.
`npm run seed -- --demo-customer` (in `api/`) creates a customer for trying the portal and prints the PIN.

## Check it the way production serves it

```
cd web
npm run build                 # static files in web/out
npm run preview               # serves web/out and passes /api to the API, on one address
```

## Tests

```
cd api
npm test
```

Integration tests need a MySQL server and **drop and re-create** the database named
by `TEST_DB_NAME` (default `ssctc_shop_test`; the name must end in `_test`).
Connection settings: `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`.
Without a reachable server those tests are skipped and only unit tests run.

## Deploying

Not done yet. Follow [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md): the hosting checks in
§2 come first. `web/out` is what gets uploaded for the site; `api/` (without
`node_modules` and `.env`) is the Node.js application. `api/migrations/001_initial_schema.sql`
and `api/seeds/001_base_data.sql` can also be run directly in phpMyAdmin.
