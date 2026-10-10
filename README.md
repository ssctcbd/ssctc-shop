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

Business screens (products, POS, payments, reports) come in later milestones.

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
