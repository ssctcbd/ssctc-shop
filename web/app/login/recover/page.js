'use client';

import { useState } from 'react';
import Link from 'next/link';
import AuthShell from '@/components/AuthShell';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';

// For an Owner who forgot the password: one of the recovery codes made on the
// Password screen sets a new one. Staff passwords are reset by an Owner.
export default function RecoverPasswordPage() {
  const [values, setValues] = useState({ username: '', code: '', newPassword: '', again: '' });
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (name) => (event) => setValues((v) => ({ ...v, [name]: event.target.value }));

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    if (values.newPassword !== values.again) return setFields({ again: 'The two passwords do not match.' });
    setFields({});
    setBusy(true);
    try {
      await api.post('/auth/recover', { username: values.username, code: values.code, newPassword: values.newPassword });
      setDone(true);
    } catch (err) {
      setFields(err.fields || {});
      setError(err.fields && Object.keys(err.fields).length ? '' : err.message);
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Forgot password"
      subtitle="For the Owner, with a recovery code"
      footer={
        <>
          Remembered it? <Link href="/login/">Back to the login</Link>
        </>
      }
    >
      {done ? (
        <>
          <Notice kind="success">Your new password is set. That recovery code is used up; you are logged out everywhere else.</Notice>
          <Link className="btn btn-primary btn-block" href="/login/">
            Log in
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <p className="field-hint" style={{ marginBottom: 14 }}>
            Use one of the recovery codes you saved from the Password screen. Each code works once. Staff: ask the Owner to set a new password for you.
          </p>
          <Notice>{error}</Notice>
          <Field label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required value={values.username} error={fields.username} onChange={set('username')} />
          <Field label="Recovery code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX" required value={values.code} error={fields.code} onChange={set('code')} />
          <Field label="New password" type="password" autoComplete="new-password" required hint="At least 10 characters." value={values.newPassword} error={fields.newPassword} onChange={set('newPassword')} />
          <Field label="New password again" type="password" autoComplete="new-password" required value={values.again} error={fields.again} onChange={set('again')} />
          <SubmitButton busy={busy} busyText="Saving…">
            Set new password
          </SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}
