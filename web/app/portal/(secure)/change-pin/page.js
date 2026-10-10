'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';

const digitsOnly = (value) => value.replace(/\D/g, '').slice(0, 6);

export default function ChangePinPage() {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError('');
    if (newPin !== confirm) {
      setFields({ confirm: 'The two PINs do not match.' });
      return;
    }
    setFields({});
    setBusy(true);
    try {
      await api.post('/portal/change-pin', { currentPin, newPin });
      window.location.assign('/portal/');
    } catch (err) {
      setFields(err.fields);
      if (Object.keys(err.fields).length === 0) setError(err.message);
      setBusy(false);
    }
  }

  const pinProps = { className: 'pin', type: 'password', inputMode: 'numeric', maxLength: 6, required: true };

  return (
    <>
      <div className="portal-hello">
        <h1>Change PIN</h1>
        <p className="muted">Choose 6 digits that only you know.</p>
      </div>

      <div className="card card-narrow">
        <form onSubmit={onSubmit} noValidate>
          <Notice>{error}</Notice>
          <Field label="Current PIN" autoComplete="current-password" value={currentPin} error={fields.currentPin} onChange={(e) => setCurrentPin(digitsOnly(e.target.value))} {...pinProps} />
          <Field label="New PIN" autoComplete="new-password" value={newPin} error={fields.newPin} onChange={(e) => setNewPin(digitsOnly(e.target.value))} {...pinProps} />
          <Field label="New PIN again" autoComplete="new-password" value={confirm} error={fields.confirm} onChange={(e) => setConfirm(digitsOnly(e.target.value))} {...pinProps} />
          <SubmitButton busy={busy}>Change PIN</SubmitButton>
        </form>
        <p className="field-hint">
          Other phones where you are logged in will be logged out. <Link href="/portal/">Back</Link>
        </p>
      </div>
    </>
  );
}
