'use client';

import { useEffect, useRef } from 'react';

/** A dialog built on the native <dialog>: focus trap, Escape and backdrop come from the browser. */
export default function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => dialog.open && dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal-wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
