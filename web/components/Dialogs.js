'use client';

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

// The shop's own confirm and "give a reason" boxes, in place of the browser's
// window.confirm and window.prompt. One provider wraps the staff screens; any
// screen asks through useDialogs() and awaits the answer:
//
//   if (!(await confirm({ title, message, confirmLabel }))) return;
//   const reason = await askReason({ title, message });   // null when cancelled
//
// Enter answers yes, Escape (or the ×) answers no, as the browser's boxes did.

const DialogContext = createContext(null);

export const useDialogs = () => useContext(DialogContext);

const MIN_REASON = 3;

function AskDialog({ request, onDone }) {
  const ref = useRef(null);
  const confirmRef = useRef(null);
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const isReason = request.kind === 'reason';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    // The yes button for a question, the text box for a reason.
    if (!isReason) confirmRef.current.focus();
    return () => dialog.open && dialog.close();
  }, [isReason]);

  function submit(event) {
    event.preventDefault();
    if (!isReason) return onDone(true);
    const text = reason.trim();
    if (text.length < MIN_REASON) return setError(`Write a reason of at least ${MIN_REASON} characters.`);
    onDone(text);
  }

  return (
    <dialog
      ref={ref}
      className="modal modal-ask"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onCancel={(event) => {
        event.preventDefault();
        onDone(isReason ? null : false);
      }}
    >
      <form onSubmit={submit} noValidate>
        <header className="modal-head">
          <h2 id={`${id}-title`}>{request.title}</h2>
          <button type="button" className="modal-close" aria-label="Cancel" onClick={() => onDone(isReason ? null : false)}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <p id={`${id}-message`} className="ask-message">
            {request.message}
          </p>
          {isReason && (
            <div className="field">
              <label htmlFor={`${id}-reason`}>{request.label || 'Reason'}</label>
              <textarea
                id={`${id}-reason`}
                rows={3}
                maxLength={255}
                autoFocus
                value={reason}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={`${id}-hint`}
                onChange={(e) => (setReason(e.target.value), setError(''))}
                // Enter saves, as in a one-line box; Shift+Enter starts a new line.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
                }}
              />
              <p id={`${id}-hint`} className={error ? 'field-error' : 'field-hint'}>
                {error || 'Kept in the history with the record. At least 3 characters.'}
              </p>
            </div>
          )}
          <div className="ask-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onDone(isReason ? null : false)}>
              Cancel
            </button>
            <button ref={confirmRef} type="submit" className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`}>
              {request.confirmLabel || (isReason ? 'Void' : 'OK')}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

export function DialogProvider({ children }) {
  const [request, setRequest] = useState(null);
  const counter = useRef(0);

  const ask = useCallback((options) => new Promise((resolve) => setRequest({ ...options, key: (counter.current += 1), resolve })), []);
  const value = useMemo(
    () => ({
      /** Resolves true (yes) or false (no). */
      confirm: (options) => ask({ kind: 'confirm', ...options }),
      /** Resolves the reason typed, trimmed and at least 3 characters, or null when cancelled. */
      askReason: (options) => ask({ kind: 'reason', ...options }),
    }),
    [ask],
  );

  const done = (answer) => {
    request.resolve(answer);
    setRequest(null);
  };

  return (
    <DialogContext.Provider value={value}>
      {children}
      {request && <AskDialog key={request.key} request={request} onDone={done} />}
    </DialogContext.Provider>
  );
}
