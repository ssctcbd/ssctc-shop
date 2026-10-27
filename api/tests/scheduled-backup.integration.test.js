// The nightly backup started by cron through the scheduled-backup endpoint,
// with Google Drive played by a fake that answers the same requests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssctc-test-backups-'));
const KEY = 'test-backup-key-0123456789abcdefghijkl';
Object.assign(process.env, {
  BACKUP_DIR,
  BACKUP_CRON_KEY: KEY,
  GDRIVE_CLIENT_ID: 'client-id',
  GDRIVE_CLIENT_SECRET: 'client-secret',
  GDRIVE_REFRESH_TOKEN: 'refresh-token',
  GDRIVE_FOLDER_ID: 'folder-1',
});

const { resetDatabase, startApp } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const OWNER = { username: 'owner', password: 'owner-password-1' };

let app;
let db;
let owner;
let skipReason = false;

/** A pretend Google Drive: a token endpoint, resumable uploads, list and delete. */
const drive = { files: new Map(), nextId: 1, failSignIn: false, requests: [] };
const realFetch = globalThis.fetch;
async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!/googleapis\.com$/.test(url.hostname)) return realFetch(input, init);
  drive.requests.push(`${init.method || 'GET'} ${url.pathname}`);
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  if (url.hostname === 'oauth2.googleapis.com') {
    if (drive.failSignIn) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'refresh-token');
    return json(200, { access_token: 'access-1' });
  }
  assert.equal(init.headers.Authorization || 'Bearer access-1', 'Bearer access-1');
  if (url.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
    const meta = JSON.parse(init.body);
    assert.deepEqual(meta.parents, ['folder-1']);
    return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${encodeURIComponent(meta.name)}` } });
  }
  if (url.pathname.startsWith('/upload/session/') && init.method === 'PUT') {
    const name = decodeURIComponent(url.pathname.split('/').pop());
    const id = `f${drive.nextId++}`;
    const bytes = Buffer.from(init.body);
    drive.files.set(id, { name, bytes });
    return json(200, { id, name, size: String(bytes.length) });
  }
  if (url.pathname === '/drive/v3/files' && (init.method || 'GET') === 'GET') {
    assert.match(url.searchParams.get('q'), /'folder-1' in parents/);
    return json(200, { files: [...drive.files].map(([id, f]) => ({ id, name: f.name })) });
  }
  if (url.pathname.startsWith('/drive/v3/files/') && init.method === 'DELETE') {
    drive.files.delete(decodeURIComponent(url.pathname.split('/').pop()));
    return new Response(null, { status: 204 });
  }
  return json(404, { error: { message: `fake drive: no route for ${url.pathname}` } });
}

test.before(async () => {
  try {
    await resetDatabase();
  } catch (err) {
    skipReason = `MySQL test database not reachable (${err.code || err.message}); see tests/helpers/setup.js`;
    return;
  }
  globalThis.fetch = fakeFetch;
  app = await startApp();
  db = require('../src/db/pool');
  const { hashSecret } = require('../src/lib/crypto');
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (1, 'Owner', ?, ?)", [OWNER.username, await hashSecret(OWNER.password)]);
  owner = app.client();
  await owner.post('/auth/login', OWNER);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  if (app) await app.stop();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const lastRun = async () => (await db.query("SELECT value FROM settings WHERE setting_key = 'backup.last_run'"))[0]?.value;
const run = (headers = { 'X-Backup-Key': KEY }) => app.client().post('/system/scheduled-backup', undefined, headers);

it('the scheduled backup needs the cron key, and refuses anything else', async () => {
  assert.equal((await run({})).status, 403);
  assert.equal((await run({ 'X-Backup-Key': 'not-the-key' })).status, 403);
  assert.equal(await lastRun(), undefined);
  assert.equal(drive.requests.length, 0);
});

it('a run writes the dump to the backup folder and copies the same file to Google Drive', async () => {
  const res = await run();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.drive.ok, true);

  const local = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sql.gz'));
  assert.deepEqual(local, [res.body.file]);
  const onDrive = [...drive.files.values()];
  assert.deepEqual(onDrive.map((f) => f.name), [res.body.file]);
  // Byte for byte the file on the server, and a complete dump.
  assert.ok(onDrive[0].bytes.equals(fs.readFileSync(path.join(BACKUP_DIR, res.body.file))));
  assert.match(zlib.gunzipSync(onDrive[0].bytes).toString('utf8'), /-- SSCTC-DUMP-COMPLETE tables=\d+ rows=\d+\n$/);

  const recorded = await lastRun();
  assert.deepEqual([recorded.ok, recorded.file, recorded.drive.ok, recorded.drive.fileId], [true, res.body.file, true, res.body.drive.fileId]);
  const status = (await owner.get('/system/status')).body.backup;
  assert.deepEqual([status.scheduled, status.drive, status.lastRun.drive.ok], [true, true, true]);
  assert.ok((await owner.get('/dashboard')).body.backup.lastDriveAt);
  const log = await db.query("SELECT actor_user_id FROM audit_logs WHERE action = 'system.backup_scheduled'");
  assert.deepEqual(log.map((l) => l.actor_user_id), [null]);
});

it('old copies in Google Drive are thinned like the local ones: 14 days, then 8 weeks', async () => {
  // Sixty earlier nights, one file each.
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  for (let n = 1; n <= 60; n += 1) drive.files.set(`old${n}`, { name: `ssctc-shop-${day(n)}-180000.sql.gz`, bytes: Buffer.alloc(0) });
  drive.files.set('other', { name: 'notes.txt', bytes: Buffer.alloc(0) });

  const res = await run();
  assert.equal(res.status, 200);
  const names = [...drive.files.values()].map((f) => f.name);
  const backups = names.filter((n) => n.endsWith('.sql.gz'));
  // 14 most recent days (tonight among them) and up to 8 older weekly copies.
  assert.ok(backups.length >= 14 && backups.length <= 22, String(backups.length));
  assert.ok(backups.includes(res.body.file));
  assert.ok(!backups.includes(`ssctc-shop-${day(59)}-180000.sql.gz`));
  // A file with another name is never touched.
  assert.ok(names.includes('notes.txt'));
});

it('when Google Drive refuses, the local copy is kept, the run is recorded as failed and the job is told', async () => {
  drive.failSignIn = true;
  const res = await run();
  assert.equal(res.status, 502);
  assert.match(res.body.error.message, /^Backup failed: Google Drive: sign-in failed/);
  const recorded = await lastRun();
  assert.equal(recorded.ok, false);
  assert.match(recorded.drive.error, /sign-in failed \(HTTP 400: Token has been expired or revoked\.\)/);
  // Tonight's dump is on the server all the same.
  assert.ok(fs.readdirSync(BACKUP_DIR).includes(recorded.file));
  assert.equal((await owner.get('/dashboard')).body.backup.lastRunOk, false);
  drive.failSignIn = false;
});
