'use client';

import { useId, useMemo, useState } from 'react';

const labelOf = (p) => `${p.sku} — ${p.name}`;

/**
 * Type-to-search product chooser built on <datalist>, so it works with a
 * keyboard, a touch screen and a barcode scanner that types the code.
 * Calls onChange(product) when the text matches a product, or onChange(null).
 */
export default function ProductPicker({ products, value, onChange, label = 'Product', error, trackedOnly = false, autoFocus = false }) {
  const id = useId();
  const options = useMemo(() => (trackedOnly ? products.filter((p) => p.trackStock) : products), [products, trackedOnly]);
  const selected = options.find((p) => p.id === value) || null;
  const [text, setText] = useState(selected ? labelOf(selected) : '');

  function onInput(next) {
    setText(next);
    const wanted = next.trim().toLowerCase();
    // Match the full label (picked from the list) or just the code (typed or scanned).
    const match = options.find((p) => labelOf(p).toLowerCase() === wanted || p.sku.toLowerCase() === wanted) || null;
    if ((match && match.id) !== value) onChange(match);
  }

  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        list={`${id}-list`}
        value={text}
        placeholder="Type a name or code"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => onInput(e.target.value)}
        onBlur={() => selected && setText(labelOf(selected))}
      />
      <datalist id={`${id}-list`}>
        {options.map((p) => (
          <option key={p.id} value={labelOf(p)}>
            {`In stock: ${p.stockQty} ${p.unit}`}
          </option>
        ))}
      </datalist>
      {error && <p className="field-error">{error}</p>}
      {!error && selected && (
        <p className="field-hint">
          In stock: {selected.stockQty} {selected.unit}
        </p>
      )}
    </div>
  );
}
