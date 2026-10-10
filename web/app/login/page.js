'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/AuthShell';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';

export default function StaffLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/login', { username, password });
      router.replace('/dashboard/');
    } catch (err) {
      setError(err.message);
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Staff login"
      subtitle="Shop management system"
      footer={
        <>
          Are you a customer? <Link href="/portal/login/">Open the customer portal</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <Notice>{error}</Notice>
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SubmitButton busy={busy} busyText="Logging in…">
          Log in
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
