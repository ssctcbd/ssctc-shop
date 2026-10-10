# SSCTC Shop — Deployment Plan

How the internal shop management system will be verified, deployed, operated and
backed up on the Hosting Bangladesh shared cPanel account. Revised 2026-10-10.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) and [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).

Nothing in this document has been executed yet. `<user>` stands for the cPanel
username.

Changes from the previous version: the application no longer stores uploaded files
or sends email, so the tests, cron jobs and risks for private storage, upload size,
file retention and SMTP are removed. There is no payment-gateway configuration.

## 1. Target layout

```
/home/<user>/
├─ public_html/<subdomain-root>/      document root of shop.sscomputertrainingcentre.com
│  ├─ index.html, _next/, …           exported Next.js site
│  └─ api/                            created by cPanel for the Node app; holds only
│                                     cPanel's own .htaccess — never overwritten
├─ ssctc-shop-api/                    Express application root (outside public_html)
│  ├─ app.js                          startup file
│  └─ tmp/restart.txt                 touched to restart the app
└─ ssctc-shop-backups/                database dumps (outside public_html)
```

Fallback: the API is attached to `shop-api.sscomputertrainingcentre.com` instead of
the `/api` path.

## 2. Milestone 0 — hosting verification checklist

A **Create Application** button proves only that the feature is switched on. Each
row is tested with a small throwaway app before development depends on it. Results
are filled in during Milestone 0.

### 2.1 Questions for Hosting Bangladesh support

| # | Question | Why it matters | Result |
|---|---|---|---|
| H1 | What are my plan's limits: memory, CPU, number of processes, entry processes, I/O? | Decides whether a Node app can run reliably | |
| H2 | Is SSH / Terminal access available on my plan? | Easiest way to deploy and run migrations | |
| H3 | Is Remote MySQL allowed? | Alternative way to run migrations | |
| H4 | What backups do you keep, how often, how long, and can I restore them myself? | Decides how much we must do ourselves | |

### 2.2 Live tests

| # | Area | Test | Pass condition | If it fails | Result |
|---|---|---|---|---|---|
| T1 | Node version | Open the version list on the Create Application page | Node 22 or newer offered; Node 20 is workable but past end-of-life | Ask the host for a newer version, or upgrade | |
| T2 | Startup | Create an app with root `ssctc-shop-api`, startup `app.js`, a minimal Express "hello" | Responds over HTTPS | Read the Passenger log; follow the host's startup conventions | |
| T3 | Dependencies | Upload `package.json`, press **Run NPM Install** | Packages install and load | Check for native-build errors; never upload `node_modules` by hand | |
| T4 | `/api` routing | Application URL `shop…/api`; a static `index.html` in the subdomain root | `/` shows the static page **and** `/api/v1/health` reaches Express | Use the fallback API subdomain | |
| T5 | Path seen by the app | Log `req.originalUrl` for `/api/v1/health` | Recorded either way; `API_BASE_PATH` is set to match | — (informational) | |
| T6 | Static deep links | Upload `test/index.html`; open `/test/` and `/test/?x=1` | Both load; unknown paths show our 404 page | Add rewrite rules to the root `.htaccess` | |
| T7 | Environment variables | Add one in the cPanel form; return it from a test endpoint | Reaches `process.env` after restart | Load a `.env` file from the app root (permission 600) | |
| T8 | Where variables are stored | Inspect the `.htaccess` cPanel generated; request it over HTTP | Not readable from the web (403/404) | Use the `.env` method | |
| T9 | Database | Connect with a dedicated user; create, read, drop a table; run a transaction with `SELECT … FOR UPDATE`; insert a row that violates a `CHECK` | All succeed; the bad row is rejected | Review the user's privileges | |
| T10 | Memory | Report `process.memoryUsage()` at idle and after 200 requests | Well under the plan's limit | Reduce pool size; consider upgrade | |
| T11 | Concurrency | 20 simultaneous requests that each query MySQL | All succeed; no 503 / 508 errors | Lower DB pool; consider upgrade | |
| T12 | Idle behaviour | Leave idle 30+ minutes, then time the first request | Responds within a few seconds | Optional cron ping during shop hours | |
| T13 | Crash recovery | Call an endpoint that exits the process, then request again | App restarts automatically | Blocker if it stays down; ask the host | |
| T14 | Restart | cPanel **Restart** button and `tmp/restart.txt` | New code is served | Document whichever works | |
| T15 | Client IP | Return `req.ip` and forwarded headers | The visitor's real IP is identifiable | Adjust `TRUST_PROXY`; otherwise per-IP rate limiting is unreliable | |
| T16 | Cron | A cPanel cron job running a Node script that writes a timestamp | Runs on schedule with the app's Node version | Trigger by authenticated HTTP call from cron | |
| T17 | Database dump | Run `mysqldump` from cron into `ssctc-shop-backups` | A valid compressed dump appears | Dump from the Node script instead; or rely on cPanel backup plus manual export | |
| T18 | SSL | Open the subdomain over HTTPS; request HTTP | Valid certificate; HTTP redirects | Run AutoSSL; add redirect rule | |
| T19 | Migrations | Run one migration by SSH, cPanel **Run JS script**, or Remote MySQL | Table created and recorded | Last resort: generate SQL locally, run in phpMyAdmin | |

### 2.3 Outcome

| Result | Action |
|---|---|
| All blocking tests pass with `/api` | Proceed with the primary layout |
| T4 fails, the rest pass | Proceed with the fallback API subdomain |
| T1, T2, T9, T10, T11 or T13 fail and the host cannot fix them | Stop; the owner decides between a higher package and a VPS (Decision D7) |

The throwaway app is deleted when Milestone 0 ends.

## 3. Runtime behaviour to design around

| Topic | Expectation on Passenger shared hosting | Consequence |
|---|---|---|
| Process manager | Passenger starts, stops and restarts the app | No PM2; the startup file just creates the Express app |
| Lifetime | The process may be stopped when idle | Nothing important in memory; no in-process schedulers |
| Instances | More than one process may run | Sessions and rate limits stored in MySQL |
| Building | `next build` is too heavy for shared limits | Always built on the development PC |
| `node_modules` | Managed by cPanel | Never uploaded; installed with **Run NPM Install** |
| Logs | Passenger log location is set in the cPanel form | No passwords or session tokens in logs |

## 4. Deployment procedure

### 4.1 First deployment (Milestone 1)

1. Create the subdomain and confirm SSL.
2. Create the MySQL database and a dedicated user with a generated password.
3. Create `ssctc-shop-backups` with owner-only permissions.
4. Create the Node.js application (root `ssctc-shop-api`, URL per Milestone 0, startup `app.js`).
5. Enter environment variables (method per T7/T8).
6. Upload the API, run **Run NPM Install**, run the migration and seeds.
7. Build the site locally and upload the export to the subdomain root.
8. Create the Owner account; confirm login on the live site.
9. Add cron jobs (§5).

### 4.2 Routine release

1. Run the automated tests locally.
2. Take a database backup if the release contains a migration.
3. Upload changed API files; install dependencies only if `package.json` changed.
4. Run migrations; restart the app.
5. Build the site locally and upload the export. **Do not delete the `api/` folder
   or the root `.htaccess`** in the subdomain root.
6. Check `/api/v1/health`, log in, open the dashboard and the POS screen.

Releases are done outside shop hours, since the POS is unavailable during a restart.

### 4.3 Rollback

- Each release is kept as a dated zip on the development PC; rollback is re-upload
  and restart.
- Migrations are written so the previous code still runs against the new schema.
- Restoring a backup is the last resort, because it loses sales entered since.

## 5. Scheduled jobs (cPanel Cron)

| Job | Schedule | Purpose |
|---|---|---|
| `backup-db` | Daily, after closing time | Dump and compress the database; prune old dumps |
| `prune-logs` | Daily | Trim expired sessions and old login attempts |

Each job appends its result to a log file that the dashboard reads, so a failed
backup shows as a warning the next morning.

## 6. Backup and restore

This system holds the shop's sales, dues and payment records. Losing it means
losing the record of who owes what.

| Data | Backed up | Notes |
|---|---|---|
| MySQL database | Yes, daily | Everything of value is here |
| Application code | Not from the server | The development PC and Git history are the source |
| Environment values | Kept by the owner in a password manager | Never inside a backup on the server |

- Daily dump to `ssctc-shop-backups/`, compressed, readable only by the account.
- Keep 14 daily and 8 weekly dumps on the server.
- **Off-server copy:** a backup that exists only on the hosting account is lost
  with the account. Default: an Owner-only "Download backup" button in the admin
  panel, used weekly, saved to the shop PC or a personal cloud drive. The
  dashboard shows the date of the last download.
- The host's own backups (H4) are a bonus, not the plan.
- Backups contain customer names, phone numbers and balances and are handled as
  carefully as the live database.

Restore: create an empty database → import the dump → point `DB_NAME` at it →
restart → log in and open the latest sale. A restore drill is done once before
launch and every three months after.

## 7. Deployment risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Node version on the host is too old | Unknown until T1 | Blocks everything | Checked first |
| R2 | `/api` cannot coexist with static files | Medium | Low | Fallback API subdomain; configuration only |
| R3 | Process or memory limits kill the app in normal use | Medium | High | Small footprint by design; measured in T10/T11; upgrade path agreed (D7) |
| R4 | Hosting or internet outage during shop hours stops the POS | Medium | Medium | Paper fallback with later entry; back-dated sales by permission |
| R5 | Slow first request after idle | High | Low | Optional keep-warm cron during shop hours |
| R6 | A deploy overwrites cPanel's `.htaccess` or the `api/` folder | Medium | High, quick to fix | Deploy script excludes them; smoke check after every release |
| R7 | No SSH, so migrations are awkward | Medium | Medium | Alternatives tested in T19 |
| R8 | Account-level failure loses the financial records | Low | Very high | Weekly off-server copy; restore drill |
| R9 | An internal tool on a public URL attracts login attempts | High | Medium | Strong passwords; lockout; no self-registration; `noindex`; audit log |
| R10 | Shared hosting outgrown | Low | Medium | The same code moves unchanged to a VPS |

## 8. Launch checklist (Milestone 6)

- [ ] All Milestone 0 results recorded and still valid
- [ ] HTTPS enforced; security headers present; site not indexable
- [ ] Test users, test sales and demo data removed
- [ ] Owner account has a strong, unique password; staff accounts created
- [ ] Real products with stock counts, services with rates, and shop details entered
- [ ] Customers and their opening dues entered; due-list total checked against the shop's existing records
- [ ] Cron jobs running and logging
- [ ] Backup taken, downloaded off-server and restored once successfully
- [ ] A logged-out browser reaches nothing but the login page, and API requests without a session are refused
- [ ] The owner completes a sale with partial payment, a later due collection, a payment verification and a day-end report on the shop PC
