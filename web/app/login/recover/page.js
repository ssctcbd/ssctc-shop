'use client';

import { useState } from 'react';
import Link from 'next/link';
import AuthShell from '@/components/AuthShell';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';

// For an Owner who forgot the password: a six-digit code sent to the email set
// on the Password screen, or one of the saved recovery codes if the email cannot
// be reached. Staff passwords are reset by an Owner.
export default function RecoverPasswordPage() {
  const [mode, setMode] = useState('email'); // email | recovery
  const [codeSent, setCodeSent] = useState(false);
  const [values, setValues] = useState({ username: '', code: '', newPassword: '', again: '' });
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (name) => (event) => setValues((v) => ({ ...v, [name]: event.target.value }));

  function showError(err) {
    setFields(err.fields || {});
    setError(err.fields && Object.keys(err.fields).length ? '' : err.message);
    setBusy(false);
  }

  function clear() {
    setError('');
    setFields({});
  }

  async function sendCode(event) {
    event?.preventDefault();
    clear();
    if (!values.username.trim()) return setFields({ username: 'Enter your username.' });
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { username: values.username });
      setCodeSent(true);
      setBusy(false);
    } catch (err) {
      showError(err);
    }
  }

  async function setPassword(event) {
    event.preventDefault();
    clear();
    if (values.newPassword !== values.again) return setFields({ again: 'The two passwords do not match.' });
    setBusy(true);
    try {
      await api.post(mode === 'email' ? '/auth/reset-password' : '/auth/recover', { username: values.username, code: values.code, newPassword: values.newPassword });
      setDone(true);
    } catch (err) {
      showError(err);
    }
  }

  function switchMode(next) {
    clear();
    setMode(next);
    setCodeSent(false);
    setValues((v) => ({ ...v, code: '' }));
  }

  const usernameField = <Field label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required value={values.username} error={fields.username} onChange={set('username')} />;
  const passwordFields = (
    <>
      <Field label="New password" type="password" autoComplete="new-password" required hint="At least 10 characters." value={values.newPassword} error={fields.newPassword} onChange={set('newPassword')} />
      <Field label="New password again" type="password" autoComplete="new-password" required value={values.again} error={fields.again} onChange={set('again')} />
      <SubmitButton busy={busy} busyText="Saving…">
        Set new password
      </SubmitButton>
    </>
  );

  return (
    <AuthShell
      title="Forgot password"
      subtitle="For the Owner. Staff: ask the Owner to set a new password for you."
      footer={
        <>
          Remembered it? <Link href="/login/">Back to the login</Link>
        </>
      }
    >
      {done ? (
        <>
          <Notice kind="success">Your new password is set. You are logged out everywhere else.</Notice>
          <Link className="btn btn-primary btn-block" href="/login/">
            Log in
          </Link>
        </>
      ) : mode === 'email' && !codeSent ? (
        <form onSubmit={sendCode} noValidate>
          <p className="field-hint" style={{ marginBottom: 14 }}>
            We will email a six-digit code to the address saved on the Owner&apos;s Password screen.
          </p>
          <Notice>{error}</Notice>
          {usernameField}
          <SubmitButton busy={busy} busyText="Sending…">
            Email me a code
          </SubmitButton>
          <p className="field-hint auth-forgot">
            <button type="button" className="link" onClick={() => switchMode('recovery')}>
              Use a saved recovery code instead
            </button>
          </p>
        </form>
      ) : mode === 'email' ? (
        <form onSubmit={setPassword} noValidate>
          <Notice kind="success">If this is an Owner account with an email saved, a code is on its way. It lasts 10 minutes. Check the spam folder too.</Notice>
          <Notice>{error}</Notice>
          <Field label="Code from the email" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={7} placeholder="6 digits" value={values.code} error={fields.code} onChange={set('code')} />
          {passwordFields}
          <p className="field-hint auth-forgot">
            No email?{' '}
            <button type="button" className="link" onClick={() => sendCode()} disabled={busy}>
              Send again
            </button>{' '}
            (after a minute) ·{' '}
            <button type="button" className="link" onClick={() => switchMode('recovery')}>
              Use a recovery code
            </button>
          </p>
        </form>
      ) : (
        <form onSubmit={setPassword} noValidate>
          <p className="field-hint" style={{ marginBottom: 14 }}>
            Use one of the recovery codes you saved from the Password screen. Each code works once.
          </p>
          <Notice>{error}</Notice>
          {usernameField}
          <Field label="Recovery code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX" required value={values.code} error={fields.code} onChange={set('code')} />
          {passwordFields}
          <p className="field-hint auth-forgot">
            <button type="button" className="link" onClick={() => switchMode('email')}>
              Email me a code instead
            </button>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
