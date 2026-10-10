'use client';

import { useState } from 'react';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { useStaff } from '@/lib/session';

export default function AccountPage() {
  const user = useStaff();
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
    </>
  );
}
