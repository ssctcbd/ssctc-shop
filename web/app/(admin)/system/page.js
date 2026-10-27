'use client';

import { Notice } from '@/components/Form';
import { API_BASE } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

const daysSince = (stamp) => (stamp ? Math.floor((Date.now() - new Date(stamp).getTime()) / 86400000) : null);
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export default function SystemPage() {
  const { data: s, error, reload } = useFetch('/system/status');
  const downloadAge = s ? daysSince(s.backup.lastDownload?.at) : null;
  const drive = s?.backup.lastRun?.drive;
  // A copy in Google Drive is away from the server, as a download is.
  const driveAge = drive && drive.ok ? daysSince(drive.at) : null;
  const problems = s ? s.checks.filter((c) => c.problems > 0) : [];

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Backup and health</h1>
          <p>Keep a copy of the shop&apos;s records away from the server, and see that the figures still add up.</p>
        </div>
        <button className="btn btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      <Notice>{error?.message}</Notice>
      {s && (
        <div className="cash-columns">
          <div className="card">
            <h2>Backup</h2>
            {driveAge !== null && driveAge <= 1 ? (
              <Notice kind="success">Last night&apos;s backup is in Google Drive ({formatDateTime(drive.at)}). A download is still useful now and then, to keep a copy on the shop computer.</Notice>
            ) : downloadAge === null ? (
              <Notice kind="warning">No backup has been downloaded yet. If the hosting account is lost, every sale and every due is lost with it.</Notice>
            ) : downloadAge > 7 ? (
              <Notice kind="warning">The last backup was downloaded {downloadAge} days ago. Download one every week.</Notice>
            ) : (
              <Notice kind="success">A backup was downloaded {downloadAge === 0 ? 'today' : `${downloadAge} day(s) ago`}.</Notice>
            )}
            <div className="kv">
              <div>
                <span>Last download</span>
                {s.backup.lastDownload ? `${formatDateTime(s.backup.lastDownload.at)} · ${s.backup.lastDownload.by}` : 'Never'}
              </div>
              <div>
                <span>Last automatic backup on the server</span>
                {!s.backup.lastRun ? (s.backup.scheduled ? 'Set up; has not run yet' : 'Not set up yet') : s.backup.lastRun.ok ? formatDateTime(s.backup.lastRun.at) : `Failed ${formatDateTime(s.backup.lastRun.at)}: ${s.backup.lastRun.error}`}
              </div>
              <div>
                <span>Copy in Google Drive</span>
                {!s.backup.drive ? 'Not connected' : !drive ? 'Connected; no copy yet' : drive.ok ? formatDateTime(drive.at) : `Failed ${formatDateTime(drive.at)}: ${drive.error}`}
              </div>
            </div>
            <a className="btn btn-primary" href={`${API_BASE}/system/backup`} onClick={() => setTimeout(reload, 4000)}>
              Download a backup now
            </a>
            <p className="field-hint">
              Save the file on the shop computer or a personal cloud drive, not only on this website. It holds every customer&apos;s name, number and balance, so keep it as carefully as cash. Each download is recorded in the audit log.
            </p>
          </div>

          <div className="card">
            <h2>Do the records agree?</h2>
            {problems.length === 0 ? (
              <Notice kind="success">Yes. Every balance matches the records behind it.</Notice>
            ) : (
              <Notice>Something does not add up. Do not correct it by hand: note which line below is marked, and get it looked at.</Notice>
            )}
            <ul className="checklist">
              {s.checks.map((c) => (
                <li key={c.key}>
                  <span>{c.label}</span>
                  <span className={`badge ${c.problems === 0 ? 'badge-ok' : 'badge-danger'}`}>{c.problems === 0 ? 'OK' : `${c.problems} wrong`}</span>
                </li>
              ))}
            </ul>

            <h2 style={{ marginTop: 22 }}>Database</h2>
            <div className="kv">
              <div>
                <span>Size</span>
                {megabytes(s.database.bytes)}
              </div>
              <div>
                <span>Bills</span>
                {s.database.sales}
              </div>
              <div>
                <span>Payments</span>
                {s.database.payments}
              </div>
              <div>
                <span>Customers</span>
                {s.database.customers}
              </div>
              <div>
                <span>Products</span>
                {s.database.products}
              </div>
            </div>
            <div className="kv">
              <div>
                <span>Database server</span>
                MySQL {s.server.mysql}
              </div>
              <div>
                <span>Your address, as the server sees it</span>
                {s.server.clientIp}
              </div>
            </div>
            {/^(127\.|::1$|::ffff:127\.)/.test(s.server.clientIp) && (
              <Notice kind="warning">The server sees every visitor as itself. Until the TRUST_PROXY setting is corrected, a few wrong passwords from anyone can lock everybody out for 15 minutes.</Notice>
            )}
            {s.server.isolationFallback && <Notice kind="warning">The database server does not allow the preferred transaction mode, so a safe fallback is in use. Ask the host whether binlog_format can be ROW or MIXED.</Notice>}
            {s.migrations.tracked && s.migrations.files.length > 0 && <Notice kind="warning">Database updates not yet run: {s.migrations.files.join(', ')}. Some screens may not work until they are.</Notice>}
          </div>
        </div>
      )}
    </>
  );
}
