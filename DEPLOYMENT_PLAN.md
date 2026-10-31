# SSCTC Shop — Deployment Plan

How the internal shop management system will be verified, deployed, operated and
backed up on the Hosting Bangladesh shared cPanel account. Revised 2026-10-10.

See [PROJECT_PLAN.md](PROJECT_PLAN.md) and [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).

Sections 1 to 4 and 7 are the plan as written before development. Sections 5, 6
and 8 to 10 describe what was actually built. Nothing after Milestone 1 has been
deployed. `<user>` stands for the cPanel username.

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

As built (Milestone 6):

| Job | Command, run in the application root | Writes |
|---|---|---|
| `backup-db` | `npm run backup` | `BACKUP_DIR/ssctc-shop-YYYYMMDD-HHMMSS.sql.gz`, a line in `BACKUP_DIR/backup.log`, and the result in the database |
| `prune-logs` | `npm run prune` | One line of output: how many expired sessions and old login attempts were removed |

- The backup result is stored in the database, so a failed backup shows as a
  warning on the Owner's dashboard and on the Backup & health screen.
- A cron line has to enter the application's Node environment first. cPanel
  shows the exact command at the top of the Node.js application page ("Enter
  to the virtual environment"). The cron command is that line followed by the
  job, for example:

  ```
  source /home/<user>/nodevenv/ssctc-shop-api/22/bin/activate && cd /home/<user>/ssctc-shop-api && npm run backup >> /home/<user>/ssctc-shop-backups/cron.log 2>&1
  ```

  Suggested times: backup 23:30, prune 04:00 (server time; check what time
  zone the server uses). **Not yet tried on this hosting** (test T16).
- `BACKUP_DIR` must be set in the application's environment variables to
  `/home/<user>/ssctc-shop-backups`, a folder outside `public_html`.
- If cron cannot be made to work, the weekly download below is still a
  complete backup routine on its own.

### Nightly backup to Google Drive (2026-10-27)

A cron job cannot see the variables set on the Node.js page, so the nightly
backup is not run with `npm run backup` there. The cron job asks the running
application to do it, with a secret:

```
curl -fsS -X POST -H "X-Backup-Key: <BACKUP_CRON_KEY>" https://shop.sscomputertrainingcentre.com/api/v1/system/scheduled-backup
```

The application dumps the database to `BACKUP_DIR`, uploads the same file to
the "SSCTC Shop backups" folder in Google Drive, and thins old copies in both
places (14 days, then 8 weeks). A failure answers HTTP 502 with the reason, so
cron mails it, and shows on the dashboard and the Backup & health screen.

One-time setup:

1. **Google Cloud** (console.cloud.google.com, logged in as the shop's Google
   account): create a project; enable **Google Drive API**; under **Google Auth
   Platform** fill in the app name and emails with audience **External**, then
   on **Audience** press **Publish app** (otherwise the token stops working
   after 7 days); under **Clients** create a client of type **Desktop app** and
   copy its client ID and secret. The only access asked for is `drive.file`:
   the application sees only the files it made.
2. **On the PC**, in `api`: `npm run gdrive-setup`. Paste the ID and secret,
   allow access in the browser (Google may warn that the app is not verified:
   Advanced → continue). It creates the folder and prints four lines.
3. **cPanel → Node.js app → Edit**, environment variables: the four `GDRIVE_*`
   lines, `BACKUP_DIR=/home/<user>/ssctc-shop-backups` (create the folder
   first) and `BACKUP_CRON_KEY` (a random string of 32+ characters). Save, Restart.
4. **cPanel → Cron Jobs**: once a day, after closing, the curl line above.
   Check the server's time zone (cPanel shows it on the Cron Jobs page).
5. Run the curl line once by hand (cPanel Terminal, or the cron "every minute"
   setting for one minute), then open Backup & health: "Copy in Google Drive"
   shows the time.

Done on the live account (2026-10-31):

- The server's clock is Asia/Dhaka (+06), so cron times are shop times.
- `BACKUP_DIR` and `BACKUP_CRON_KEY` are in `/home/sscompu2/ssctc-shop-api/.env`
  (mode 0600), not on the Node.js page; `src/config/env.js` reads that file and
  the page's variables still win. The four `GDRIVE_*` lines go in the same file.
- `/home/sscompu2/ssctc-shop-backups` (0700) holds the dumps and `cron.log`.
- Cron: `50 23 * * *`, the curl line, appending to `cron.log`. A test run from
  cron at 18:06 wrote a backup.
- Google Drive is connected to the shop's account (Google Cloud project
  `ssctc-shop-backup`, app published, client "backup"). The first copy reached
  the "SSCTC Shop backups" folder on 2026-10-31. The branding page needs
  `https://shop.sscomputertrainingcentre.com/privacy/` (`web/public/privacy/`).
- In a crontab `%` means a new line: never put a bare `%` in a cron command.
- Owner password codes (2026-11-01): mailbox `noreply@sscomputertrainingcentre.com`, `SMTP_*` in the same `.env`, migration 006 run by hand, `nodemailer` installed with Run NPM Install. Gmail delivers to the inbox. The username asked for is the login username, not the email address.

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

As built (Milestone 6):

- **The application writes the dump itself**, so it does not depend on
  `mysqldump` being available (T17). The file is plain SQL, one statement per
  line, gzip-compressed, taken inside one read-only transaction with a
  consistent snapshot. Its last line says how many rows it holds; a file
  without that line was cut short and is refused.
- **Off-server copy:** the Owner's menu has **Backup & health → Download a
  backup now**. Each download is written to the audit log. The dashboard warns
  when none has been downloaded for 7 days.
- **Restore with the script** (needs SSH or the Node.js "Run JS script" button):
  `npm run restore -- <file.sql.gz> --database <name>`. It refuses a database
  that already has tables, counts the restored rows against the file, and runs
  the consistency checks.
- **Restore without SSH:** un-zip the file on the PC (7-Zip opens `.gz`),
  create an empty database in cPanel, and import the `.sql` file in
  phpMyAdmin (Import tab).
- Then set `DB_NAME` to the restored database in the Node.js application's
  environment variables and restart. The old database is left untouched until
  the restored one has been checked.
- **Restore drill:** automated in the test suite. A backup is downloaded,
  restored into a second database, and every table is compared with the
  original by row count and checksum, including text with quotes, line breaks,
  Bangla and emoji. This proves the method; **a drill on the hosting account
  itself is still to be done once before launch**.

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

What a program can check is checked by `npm run launch-check` in the
application root: production mode, HTTPS address, password hashing cost,
left-over first-Owner variables, migrations and base data, an active Owner, test
accounts, shop details, cost prices, every consistency check, the backup folder
and the age of the last backups. It changes nothing. Lines marked FAIL must be
fixed before launch; WARN lines are for the owner to judge.

The same consistency checks are on the **Backup & health** screen at any time.

## 9. Deploying a release with cPanel File Manager

A procedure that needs no SSH. It assumes the Milestone 0 results reported on
2026-10-11: the Node.js application already exists, `/api` reaches it, and its
environment variables are set. Do it outside shop hours.

**On the PC**

1. In the project folder run `powershell -File scripts\package-release.ps1`.
   It builds the site and writes `release\ssctc-shop-web.zip` and
   `release\ssctc-shop-api.zip`, and lists the migrations in the release.

**Database (phpMyAdmin)**

2. Export the database first (Export -> Quick -> SQL) and keep the file.
3. Open the database, choose the SQL tab, and run each migration file that has
   not been run on this database yet, in number order: paste the content of
   `api\migrations\001_initial_schema.sql`, then `002_...`, and so on.
   Migration 001 is run once only, on the empty database. From 002 onward the
   files check before changing anything, so running one twice does no harm.
4. First deployment only: run `api\seeds\001_base_data.sql` the same way.

**API (File Manager + Node.js page)**

5. Upload `ssctc-shop-api.zip` into the Node.js application root and Extract,
   replacing existing files. The zip contains no `node_modules` and no `.env`.
6. On the cPanel Node.js page: press **Run NPM Install** if `package.json`
   changed (always on the first deployment), then **Restart**.
7. First deployment only, create the Owner account: use **Run JS script** ->
   `seed`, with `OWNER_NAME`, `OWNER_USERNAME` and `OWNER_PASSWORD` added to
   the environment variables beforehand. Remove those three variables
   afterwards and restart. (If SSH is available: `npm run seed` asks for them.)
8. Open `https://shop.sscomputertrainingcentre.com/api/v1/health`. It must
   show `{"status":"ok","database":"ok"}`.

**Site (File Manager)**

9. Upload `ssctc-shop-web.zip` into the subdomain's document root and Extract,
   replacing existing files. **Do not delete the `api` folder or the
   `.htaccess` file there**: cPanel's Node.js routing lives in them.
10. Open the site, log in, open Products and Purchases, and log in to
    `/portal/login/` once.

**If something is wrong**

- Health shows `database: unavailable`: check the `DB_*` environment variables.
- A page shows "Something went wrong" after an update: a migration was missed.
- To go back: extract the previous release's two zips the same way and restart.
  Restore the database export only as a last resort; it loses everything
  entered since.

Still unverified on this hosting (Section 2): resource limits (H1), memory
(T10), concurrency (T11), idle and crash recovery (T12, T13), client IP (T15),
cron (T16), database dump (T17) and the **Run JS script** route for migrations
(T19). Until T15 is checked, per-IP login blocking may count every visitor as
one address; the per-account lockout is unaffected.

## 10. What is left before launch

Built and tested locally, waiting to be put on the hosting account:

1. Run migrations `002`, `003` and `004` on the live database (Section 9, step 3).
   Only `001` has been run there.
2. Upload the current release (Section 9). `scripts\package-release.ps1` builds it.
3. Add `BACKUP_DIR` to the environment variables, create that folder, and add the
   two cron jobs (Section 5).
4. Run `npm run launch-check` and clear every FAIL.
   Then open **Backup & health** on the live site and read two lines there:
   "Your address, as the server sees it" must be your own internet address,
   not `127.0.0.1`. If it is `127.0.0.1`, set `TRUST_PROXY=1` in the
   environment variables and restart (this is test T15); until then one
   person's wrong passwords can lock everybody out for 15 minutes. And if a
   warning about the transaction mode appears, the system still works; ask the
   host whether `binlog_format` can be ROW or MIXED.
5. Do the restore drill once on the hosting account (Section 6).
6. Finish the hosting checks still open in Section 2: H1, T10 to T13, T15 to T17, T19.
7. Work through the checklist in Section 8 with real products, customers and
   opening dues.

**Security headers on the pages.** Responses from the API already carry the
usual security headers (set by the application). The pages themselves are plain
files served by the web server, so their headers can only be set in the
`.htaccess` of the subdomain's document root, which belongs to cPanel and is
not touched by a release. If the host confirms that adding lines to it is safe,
these are the lines; they have **not** been applied or tested on the hosting:

```
<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=31536000"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "same-origin"
</IfModule>
```

The site already tells search engines not to index it (`robots.txt` and a
`noindex` tag on every page).
