'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/AuthShell';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';

const digitsOnly = (value, max) => value.replace(/\D/g, '').slice(0, max);

export default function PortalLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/portal/login', { phone, pin });
      router.replace('/portal/');
    } catch (err) {
      setError(err.message);
      setPin('');
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Customer portal"
      subtitle="See your bills, dues and payments"
      footer={
        <>
          Shop staff? <Link href="/login/">Staff login</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <Notice>{error}</Notice>
        <Field
          label="Mobile number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="01XXXXXXXXX"
          autoFocus
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Field
          label="6-digit PIN"
          name="pin"
          className="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={6}
          required
          hint="The shop gave you this PIN with your invoice."
          value={pin}
          onChange={(e) => setPin(digitsOnly(e.target.value, 6))}
        />
        <SubmitButton busy={busy} busyText="Logging in…">
          Log in
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
