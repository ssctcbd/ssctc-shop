'use client';

import { useState } from 'react';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan, useStaff } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

/**
 * Owner only: one-time codes for the login page's Forgot password. Making a
 * new set asks for the password again and cancels the old set. The codes are
 * shown once, here, and never again.
 */
function MakeCodesForm({ status, onMade }) {
  const form = useForm({ currentPassword: '' }, async (v) => {
    const res = await api.post('/auth/recovery-codes', { currentPassword: v.currentPassword });
    onMade(res.codes);
  });
  const s = status;

  return (
    <form onSubmit={form.onSubmit} noValidate>
      {s && <p className="field-hint" style={{ marginBottom: 12 }}>{s.total === 0 ? 'You have no recovery codes yet.' : `${s.unused} of ${s.total} codes unused, made ${formatDateTime(s.createdAt)}.`}</p>}
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field label="Your current password" type="password" autoComplete="current-password" required value={form.values.currentPassword} error={form.fields.currentPassword} onChange={form.set('currentPassword')} />
      <SubmitButton busy={form.busy} busyText="Making codes…">
        {s && s.total > 0 ? 'Make new codes (the old ones stop working)' : 'Make recovery codes'}
      </SubmitButton>
    </form>
  );
}

function RecoveryCodes() {
  const status = useFetch('/auth/recovery-codes');
  const [codes, setCodes] = useState(null);

  return (
    <div className="card card-narrow" style={{ marginTop: 20 }}>
      <h2>Recovery codes</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        If you forget your password, one of these codes lets you set a new one from the login page. Keep them somewhere safe, away from this computer: on paper, or in your phone.
      </p>
      <Notice>{status.error?.message}</Notice>
      {codes ? (
        <>
          <Notice kind="warning">Write these down or print this page now. They will not be shown again. Each works once.</Notice>
          <ul className="recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="page-actions">
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setCodes(null)}>
              I have saved them
            </button>
          </div>
        </>
      ) : (
        <MakeCodesForm
          status={status.data}
          onMade={(made) => {
            setCodes(made);
            status.reload();
          }}
        />
      )}
    </div>
  );
}

export default function AccountPage() {
  const user = useStaff();
  const can = useCan();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    if (newPassword !== confirm) {
      setFields({ confirm: 'The two passwords do not match.' });
      return;
    }
    setFields({});
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      // Reload so the shell re-reads the user (clears the must-change state).
      window.location.assign('/dashboard/');
    } catch (err) {
      setFields(err.fields);
      if (Object.keys(err.fields).length === 0) setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Change password</h1>
        <p>
          {user.name} · {user.username}
        </p>
      </div>

      <div className="card card-narrow">
        {user.mustChangePassword && <Notice kind="warning">Your password was set by the Owner. Choose your own before continuing.</Notice>}
        <form onSubmit={onSubmit} noValidate>
          <Notice>{error}</Notice>
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            error={fields.currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            hint="At least 10 characters."
            value={newPassword}
            error={fields.newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Field
            label="New password again"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            error={fields.confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <SubmitButton busy={busy}>Change password</SubmitButton>
        </form>
        <p className="field-hint">Other devices where you are logged in will be logged out.</p>
      </div>
      {can('users.manage') && !user.mustChangePassword && <RecoveryCodes />}
    </>
  );
}
