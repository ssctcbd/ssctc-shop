'use client';

import { useId } from 'react';

export function Field({ label, error, hint, ...input }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined} {...input} />
      {(error || hint) && (
        <p id={`${id}-msg`} className={error ? 'field-error' : 'field-hint'}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function SubmitButton({ busy, children, busyText = 'Please wait…' }) {
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
      {busy ? busyText : children}
    </button>
  );
}

export function Notice({ kind = 'error', children }) {
  if (!children) return null;
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
