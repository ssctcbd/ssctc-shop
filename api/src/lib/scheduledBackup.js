const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { env } = require('../config/env');
const { writeCompressedDump, dumpFileName, filesToDelete } = require('./backup');
const gdrive = require('./gdrive');

/**
 * The nightly backup (DEPLOYMENT_PLAN.md §5–6), shared by `npm run backup` and
 * the scheduled-backup endpoint that a cPanel cron job calls:
 *
 * 1. Dump the database to BACKUP_DIR (or, without one, a temporary folder),
 *    under a temporary name, so a file called *.sql.gz is always complete.
 * 2. If Google Drive is set up, upload the file into the backup folder.
 * 3. Thin out old copies in both places: the newest of each of the last 14
 *    days, and beyond those the newest of each of the last 8 weeks.
 *
 * The outcome is stored with `record(result)`; the System screen and the
 * dashboard read it. A Drive failure is recorded and thrown after the local
 * copy is safe, so the cron job reports it.
 */
async function runScheduledBackup({ record, dir = env.BACKUP_DIR, log = () => {} } = {}) {
  const keepLocal = Boolean(dir);
  if (keepLocal && (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) throw new Error(`Backup folder not found: ${dir}`);
  if (!keepLocal && !gdrive.driveConfigured()) throw new Error('Nowhere to keep the backup. Set BACKUP_DIR, or set up Google Drive (npm run gdrive-setup).');
  const folder = keepLocal ? dir : fs.mkdtempSync(path.join(os.tmpdir(), 'ssctc-backup-'));

  const at = new Date();
  const name = dumpFileName(at);
  const file = path.join(folder, name);
  const partial = `${file}.part`;
  const result = { ok: false, at: at.toISOString(), file: name };

  try {
    const done = await writeCompressedDump(fs.createWriteStream(partial, { mode: 0o600 }));
    fs.renameSync(partial, file);
    Object.assign(result, { bytes: fs.statSync(file).size, rows: done.rows });

    if (keepLocal) {
      const removed = filesToDelete(fs.readdirSync(folder));
      for (const old of removed) fs.unlinkSync(path.join(folder, old));
      result.localRemoved = removed.length;
    }

    if (gdrive.driveConfigured()) {
      try {
        const token = await gdrive.accessToken();
        const uploaded = await gdrive.uploadFile(token, file, name);
        const files = await gdrive.listFolder(token);
        const stale = new Set(filesToDelete(files.map((f) => f.name)));
        // Drive allows two files with one name; a backup run twice in the same second replaces the first copy.
        const old = files.filter((f) => stale.has(f.name) || (f.name === name && f.id !== uploaded.id));
        for (const f of old) await gdrive.deleteFile(token, f.id);
        result.drive = { ok: true, at: new Date().toISOString(), fileId: uploaded.id, removed: old.length };
      } catch (err) {
        result.drive = { ok: false, at: new Date().toISOString(), error: String(err.message).slice(0, 200) };
      }
    }

    result.ok = !result.drive || result.drive.ok;
    if (!result.ok) result.error = result.drive.error;
    log(`${result.ok ? 'OK' : 'FAILED'} ${name} ${result.bytes} bytes, ${result.rows} rows${keepLocal ? `, removed ${result.localRemoved} old file(s)` : ''}${result.drive ? ` · Drive: ${result.drive.ok ? `uploaded, removed ${result.drive.removed} old` : result.drive.error}` : ''}`);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    Object.assign(result, { ok: false, error: String(err.message).slice(0, 200) });
    log(`FAILED ${err.message}`);
  } finally {
    // Without BACKUP_DIR the file was only on its way to Drive.
    if (!keepLocal) fs.rmSync(folder, { recursive: true, force: true });
  }

  await record(result);
  if (!result.ok) throw new Error(result.error);
  return result;
}

module.exports = { runScheduledBackup };
