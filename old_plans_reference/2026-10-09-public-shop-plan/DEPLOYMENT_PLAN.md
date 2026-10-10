# SSCTC Shop — Deployment Plan

How the application will be verified, deployed, operated and backed up on the
Hosting Bangladesh shared cPanel account.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the architecture decision and
[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) for the data model.

Nothing in this document has been executed yet. Paths containing `<user>` are
placeholders for the cPanel username.

## 1. Target layout

Primary architecture (static site + Express API on one subdomain):

```
/home/<user>/
├─ public_html/<subdomain-root>/      document root of shop.sscomputertrainingcentre.com
│  ├─ index.html, _next/, …           exported Next.js site
│  ├─ media/                          public product images (written by the API)
│  └─ api/                            created by cPanel for the Node app; holds only
│                                     cPanel's own .htaccess — never overwritten
├─ ssctc-shop-api/                    Express application root (outside public_html)
│  ├─ app.js                          startup file
│  └─ tmp/restart.txt                 touched to restart the app
├─ ssctc-shop-storage/
│  └─ private/                        customer uploads — no URL reaches this folder
└─ ssctc-shop-backups/                database dumps
```

The exact subdomain document root is chosen when the subdomain is created in cPanel.

Fallback: the API is attached to `shop-api.sscomputertrainingcentre.com` instead of
the `/api` path. Folders are otherwise the same.

## 2. Milestone 0 — hosting verification checklist

The presence of a **Create Application** button proves only that the feature is
switched on. Each row below must be tested with a small throwaway app before any
real development depends on it. The "Result" column is filled in during Milestone 0.

### 2.1 Questions for Hosting Bangladesh support

| # | Question | Why it matters | Result |
|---|---|---|---|
| H1 | What are my plan's limits: memory, CPU, number of processes, entry processes, I/O, inodes, disk? | Decides whether a Node app can run reliably at all | |
| H2 | Is SSH / Terminal access available on my plan? | Easiest way to deploy and run migrations | |
| H3 | Is Remote MySQL allowed? | Alternative way to run migrations from the PC | |
| H4 | What backups do you keep, how often, how long, and can I restore them myself? | Decides how much we must do ourselves | |
| H5 | Is there an outgoing email limit per hour? | Order notifications | |
| H6 | Is there a maximum HTTP upload size? | Print file uploads | |
| H7 | Are uploaded files scanned for malware? | Customer document handling | |

### 2.2 Live tests

| # | Area | Test | Pass condition | If it fails | Result |
|---|---|---|---|---|---|
| T1 | Node version | Open the version list on the Create Application page | Node 22 or newer offered. Node 20 is workable but past end-of-life | Below 20: ask the host to add a newer version, or upgrade | |
| T2 | Startup | Create an app with root `ssctc-shop-api`, startup file `app.js`, a minimal Express "hello" | Responds over HTTPS | Read the Passenger error log; try the startup conventions the host documents | |
| T3 | Dependencies | Upload `package.json`, press **Run NPM Install** | Packages install; app can `require` them | Check for native-build errors; confirm no `node_modules` folder was uploaded by hand | |
| T4 | `/api` routing | Set Application URL to `shop…/api`; put a static `index.html` in the subdomain root | `/` shows the static page **and** `/api/v1/health` reaches Express | Use the fallback subdomain for the API | |
| T5 | Path seen by the app | Log `req.originalUrl` for a request to `/api/v1/health` | Known either way — records whether Passenger passes `/api/…` or strips it; `API_BASE_PATH` is set to match | — (informational) | |
| T6 | Static deep links | Upload a folder `test/index.html`; open `/test/` and `/test/?x=1` | Both load; an unknown path shows our 404 page | Add rewrite rules to the root `.htaccess` | |
| T7 | Environment variables | Add a variable in the cPanel form; return it from a test endpoint | Value reaches `process.env` after restart | Load a `.env` file from the app root (outside `public_html`, permission 600) | |
| T8 | Where variables are stored | Inspect the `.htaccess` cPanel generated in the `api` folder | Secrets are not readable over HTTP (request the file directly; expect 403/404) | Use the `.env` file method instead of the cPanel form | |
| T9 | Database | Connect from the app to MySQL with a dedicated user; create, read, drop a test table; run a transaction with `SELECT … FOR UPDATE` | All succeed; `CHECK` constraint rejects a bad row | Review user privileges in cPanel | |
| T10 | Memory | Report `process.memoryUsage()` at idle and after 200 requests | Stays well under the plan's limit (H1) | Reduce pool size; consider upgrade | |
| T11 | Concurrency | Send 20 simultaneous requests that each query MySQL | All succeed; no 503 / 508 "resource limit" errors | Note the limit; lower DB pool; consider upgrade | |
| T12 | Idle behaviour | Leave the app untouched for 30+ minutes, then time the first request | First response within a few seconds | Accept; optionally a cron ping every few minutes | |
| T13 | Crash recovery | Call a test endpoint that exits the process, then request again | App is restarted automatically | Ask the host; this is a blocker if it stays down | |
| T14 | Restart | Use the cPanel **Restart** button and `tmp/restart.txt` | New code is served afterwards | Document whichever works | |
| T15 | Private storage | Write a file to `ssctc-shop-storage/private`, restart, redeploy the app, read it back | File survives; no URL returns it | Blocker for print ordering until solved | |
| T16 | Upload size | POST a 20 MB file to a test endpoint | Accepted and saved intact | Lower the limit in settings to what works | |
| T17 | Client IP | Return `req.ip` and the forwarded headers | The visitor's real IP is identifiable | Adjust `TRUST_PROXY`; without it, per-IP rate limiting is unreliable | |
| T18 | Cron | Add a cPanel cron job that runs a Node script writing a timestamp | Runs on schedule using the app's Node version | Trigger jobs by an authenticated HTTP call from cron (`curl` + `CRON_SECRET`) | |
| T19 | Email | Send a message through the hosting SMTP to a Gmail address | Delivered, not in spam | Check SPF/DKIM in cPanel Email Deliverability | |
| T20 | SSL | Open the subdomain over HTTPS; request HTTP | Valid certificate; HTTP redirects to HTTPS | Run AutoSSL; add redirect rule | |
| T21 | Migrations | Run one migration by whichever of SSH / cPanel **Run JS script** / Remote MySQL is available | A table is created and recorded | Last resort: generate SQL locally and run it in phpMyAdmin | |
| T22 | Table privileges | Try to create a second DB user with fewer rights | Informational — records whether read-only or per-table rights are possible | — | |

### 2.3 Outcome

| Result | Action |
|---|---|
| All blocking tests pass with `/api` | Proceed with the primary architecture |
| T4 fails, the rest pass | Proceed with the fallback API subdomain |
| T1, T2, T10, T11, T13 or T15 fail and the host cannot fix them | Stop; owner decides between a higher package and a VPS (Decision D8) |

The throwaway test app and its endpoints are deleted when Milestone 0 ends.

## 3. Runtime behaviour to design around

| Topic | Expectation on Passenger shared hosting | Consequence |
|---|---|---|
| Process manager | Passenger starts, stops and restarts the app; PM2 and similar are not used | The startup file simply creates the Express app and listens |
| Lifetime | The process may be stopped when idle and started on the next request | Nothing important is kept in memory; no in-process schedulers |
| Instances | More than one process may run at once | Sessions and rate limits are stored in MySQL |
| Building | `next build` is too heavy for shared limits | The site is always built on the development PC |
| `node_modules` | Managed by cPanel in its own environment | Never uploaded; installed with **Run NPM Install** |
| Native modules | May fail to compile | Pure-JavaScript libraries are preferred |
| Logs | Passenger writes a log file whose location is set in the cPanel form | Application logs go to stdout/stderr and a dated file in the app folder; no secrets or personal data in logs |

## 4. Deployment procedure

### 4.1 First deployment (Milestone 1)

1. Create the subdomain and confirm SSL.
2. Create the MySQL database and a dedicated user with a generated password.
3. Create `ssctc-shop-storage/private` and `ssctc-shop-backups` with owner-only permissions.
4. Create the Node.js application (root `ssctc-shop-api`, URL per Milestone 0, startup `app.js`).
5. Enter environment variables (method per T7/T8).
6. Upload the API source, run **Run NPM Install**, run migrations and seeds.
7. Build the site locally and upload the exported files to the subdomain root.
8. Create the Owner account; confirm login on the live site.
9. Add cron jobs (§5).

### 4.2 Routine release

1. Run the automated tests locally.
2. Take a database backup if the release contains a migration.
3. Upload changed API files. Install dependencies only if `package.json` changed.
4. Run migrations.
5. Restart the app.
6. Build the site locally and upload the export. **Do not delete the `api/` and
   `media/` folders or the root `.htaccess`** in the subdomain root.
7. Check `/api/v1/health` and run the short smoke checklist (home page, login, one
   product page, admin dashboard).

Upload method: SSH/rsync if H2 allows, otherwise a zip uploaded and extracted with
cPanel File Manager. A small deploy script will be written in Milestone 1 once the
method is known.

### 4.3 Rollback

- Each release is kept as a dated zip on the development PC.
- Code rollback: re-upload the previous zip and restart.
- Data rollback: migrations are written so the previous code still runs against
  the new schema (add columns first, remove later). Restoring a backup is the last
  resort because it loses orders placed since the backup.

### 4.4 Test environment

A second subdomain (for example `shop-test.`) with its own database is recommended
once the site is live, so changes can be tried without touching real orders. Until
launch the real subdomain serves as the test site behind a "coming soon" page.
Whether the plan's resource limits allow a second Node app is known after H1.

## 5. Scheduled jobs (cPanel Cron)

| Job | Schedule | Purpose |
|---|---|---|
| `cleanup-files` | Daily, 03:00 | Delete expired customer files from disk and mark them deleted |
| `expire-orders` | Hourly | Cancel unpaid bKash/Nagad orders older than the configured limit and return stock |
| `backup-db` | Daily, 02:00 | Dump and compress the database; prune old dumps |
| `prune-logs` | Daily, 03:30 | Trim old sessions, login attempts and notification rows |
| `send-notifications` | Every 5 minutes | Send queued emails and retry failures |

Each job writes a line to a log with its result. A failed backup or cleanup sends
an email to the owner.

## 6. Backup and restore

### 6.1 What is backed up

| Data | Backed up | Notes |
|---|---|---|
| MySQL database | Yes, daily | Orders, customers, payments, stock, settings |
| Product images (`media/`) | Yes, weekly | Can also be re-uploaded, but slow to redo |
| Application code | Not from the server | The development PC and its Git history are the source |
| Customer uploads (`private/`) | **No** | Short-lived and sensitive; excluding them makes deletion final |
| Environment values | Kept by the owner in a password manager | Never inside a backup stored on the server |

### 6.2 Schedule and retention

- Daily dump to `ssctc-shop-backups/`, compressed, readable only by the account.
- Keep 14 daily and 8 weekly dumps on the server.
- **Off-server copy:** a backup that lives only on the same hosting account is lost
  together with the account. Provisional default: the owner downloads the latest
  weekly dump every week to a PC or personal cloud drive. An automated off-server
  copy is added if Milestone 0 shows a workable method.
- The host's own backups (H4) are a bonus, not the plan.
- Backups contain customers' names, phone numbers and order history and must be
  stored as carefully as the live database.

### 6.3 Restore

1. Create an empty database.
2. Import the chosen dump (phpMyAdmin import, or the `mysql` command over SSH).
3. Point the app's `DB_NAME` at it and restart.
4. Check the health endpoint, log in, open the most recent order.

A restore drill into a scratch database is performed once before launch and then
every three months. A backup that has never been restored is not yet a backup.

## 7. Deployment risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Node version on the host is too old | Unknown until T1 | Blocks everything | Checked first; host can often add versions on request |
| R2 | `/api` path cannot coexist with static files | Medium | Low | Fallback API subdomain; configuration only |
| R3 | Process or memory limits kill the app under normal use | Medium | High | Small footprint by design; measured in T10/T11; upgrade path agreed (D8) |
| R4 | Slow first request after idle | High | Low | Static pages are unaffected; optional keep-warm cron |
| R5 | A deploy overwrites cPanel's `.htaccess` or the `api/` folder | Medium | High, but quick to fix | Deploy script excludes them; smoke check after every release |
| R6 | Customer files exposed by misconfiguration | Low | Very high | Storage outside `public_html`; access only through the authorised endpoint; explicit test in Milestones 0, 5 and 8 |
| R7 | No SSH, so migrations are awkward | Medium | Medium | Three alternatives tested in T21 |
| R8 | Account-level failure loses data | Low | Very high | Off-server weekly copy; restore drill |
| R9 | Emails land in spam or hit the hourly limit | Medium | Medium | SPF/DKIM check; queue with retry; WhatsApp link as a second channel |
| R10 | Upload size capped below what customers need | Medium | Medium | Measured in T16; limit shown to customers before upload |
| R11 | Malicious file uploaded as a "document" | Low | Medium | Type allow-list by content; never served inline; staff handling guidance |
| R12 | Shared hosting outgrown as orders increase | Low at launch | Medium | Architecture moves unchanged to a VPS |

## 8. Launch checklist (Milestone 8)

- [ ] All Milestone 0 results recorded and still valid
- [ ] HTTPS enforced; security headers present
- [ ] Test accounts, test orders and demo data removed
- [ ] Owner account uses a strong, unique password; staff accounts created
- [ ] Real rates, services, bKash/Nagad numbers and contact details entered
- [ ] All cron jobs running and logging
- [ ] Backup taken, downloaded off-server and restored once successfully
- [ ] A logged-out browser and a second customer account both fail to fetch an uploaded file
- [ ] One complete order of each kind (product, print, online service) placed, paid, verified and completed on a phone
- [ ] Privacy notice on the site states what happens to uploaded documents and when they are deleted
