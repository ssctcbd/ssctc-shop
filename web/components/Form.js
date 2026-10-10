'use client';

import { useId } from 'react';

/**
 * A labelled form control. `as` picks the element: "input" (default),
 * "select" (options as children) or "textarea".
 */
export function Field({ label, error, hint, as: Element = 'input', children, ...control }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <Element id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined} {...control}>
        {children}
      </Element>
      {(error || hint) && (
        <p id={`${id}-msg`} className={error ? 'field-error' : 'field-hint'}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Checkbox({ label, hint, ...input }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" {...input} />
      <label htmlFor={id}>
        {label}
        {hint && <small>{hint}</small>}
      </label>
    </div>
  );
}

export function SubmitButton({ busy, children, busyText = 'Please wait…', block = true }) {
  return (
    <button type="submit" className={`btn btn-primary${block ? ' btn-block' : ''}`} disabled={busy}>
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
