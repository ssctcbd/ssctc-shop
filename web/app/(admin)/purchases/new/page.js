'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ProductPicker from '@/components/ProductPicker';
import { Field, Notice } from '@/components/Form';
import { api } from '@/lib/api';
import { formatMoney, lineTotal, sumMoney } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };

export default function NewPurchasePage() {
  const router = useRouter();
  const suppliers = (useFetch('/suppliers').data?.suppliers || []).filter((s) => s.isActive);
  const options = useFetch('/products/options');
  const products = options.data?.products || [];

  const nextKey = useRef(1);
  const newLine = () => ({ key: nextKey.current++, productId: null, quantity: '', unitCost: '' });
  const [head, setHead] = useState({ supplierId: '', date: '', supplierMemoNo: '', note: '', paidAmount: '', paymentMethod: 'cash', paymentReference: '' });
  const [lines, setLines] = useState(() => [newLine()]);
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setHeadField = (name) => (event) => setHead((h) => ({ ...h, [name]: event.target.value }));
  const setLine = (key, patch) => {
    setError('');
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const total = sumMoney(lines.map((l) => lineTotal(l.unitCost, l.quantity)));
  const paid = Number(head.paidAmount || 0);
  const owed = (Number(total) - paid).toFixed(2);

  async function onSubmit(event) {
    event.preventDefault();
    // Disabled while saving: a second click must not create a second bill.
    if (busy) return;
    setError('');
    setFields({});

    const filled = lines.filter((l) => l.productId || l.quantity || l.unitCost);
    if (filled.length === 0) return setError('Add at least one product.');
    setBusy(true);
    try {
      const { purchase } = await api.post('/purchases', {
        supplierId: Number(head.supplierId) || 0,
        ...(head.date ? { date: head.date } : {}),
        supplierMemoNo: head.supplierMemoNo,
        note: head.note,
        items: filled.map((l) => ({ productId: l.productId || 0, quantity: l.quantity, unitCost: l.unitCost })),
        paidAmount: head.paidAmount || '0',
        paymentMethod: head.paymentMethod,
        paymentReference: head.paymentReference,
      });
      router.replace(`/purchases/?saved=${encodeURIComponent(purchase.purchaseNo)}`);
    } catch (err) {
      // Line errors arrive as "items.<index>.<field>"; map them back to the lines sent.
      const mapped = {};
      for (const [path, message] of Object.entries(err.fields || {})) {
        const match = /^items\.(\d+)\.(\w+)$/.exec(path);
        if (match) mapped[`${filled[Number(match[1])].key}.${match[2]}`] = message;
        else mapped[path] = message;
      }
      setFields(mapped);
      setError(Object.keys(mapped).length ? 'Please check the highlighted fields.' : err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>New purchase</h1>
        <p>
          Enter the supplier&apos;s bill. Saving adds the products to stock and updates their cost price. <Link href="/purchases/">Back to purchases</Link>
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate>
        <Notice>{error}</Notice>
        {suppliers.length === 0 && (
          <Notice kind="warning">
            There are no active suppliers. <Link href="/suppliers/">Add a supplier first</Link>.
          </Notice>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="form-grid">
            <Field as="select" label="Supplier" required value={head.supplierId} error={fields.supplierId && 'Choose a supplier.'} onChange={setHeadField('supplierId')}>
              <option value="">Choose…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.company ? ` — ${s.company}` : ''}
                </option>
              ))}
            </Field>
            <Field label="Bill date" type="date" value={head.date} error={fields.date} onChange={setHeadField('date')} hint="Leave empty for today." />
            <Field label="Supplier memo / challan no." maxLength={60} value={head.supplierMemoNo} error={fields.supplierMemoNo} onChange={setHeadField('supplierMemoNo')} />
            <Field label="Note" maxLength={500} value={head.note} error={fields.note} onChange={setHeadField('note')} />
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Products on the bill</h2>
          <div className="lines">
            {lines.map((line) => (
              <div className="line" key={line.key}>
                <ProductPicker
                  products={products}
                  trackedOnly
                  value={line.productId}
                  error={fields[`${line.key}.productId`] && (line.productId ? fields[`${line.key}.productId`] : 'Choose a product from the list.')}
                  onChange={(p) => setLine(line.key, { productId: p ? p.id : null, ...(p && !line.unitCost && Number(p.costPrice) > 0 ? { unitCost: p.costPrice } : {}) })}
                />
                <Field label="Quantity" type="number" min={1} step={1} value={line.quantity} error={fields[`${line.key}.quantity`]} onChange={(e) => setLine(line.key, { quantity: e.target.value })} />
                <Field label="Unit cost (৳)" inputMode="decimal" value={line.unitCost} error={fields[`${line.key}.unitCost`]} onChange={(e) => setLine(line.key, { unitCost: e.target.value })} />
                <div className="line-total">{formatMoney(lineTotal(line.unitCost, line.quantity))}</div>
                <button type="button" className="btn btn-ghost btn-sm remove" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setLines((all) => [...all, newLine()])}>
            Add another product
          </button>
        </div>

        <div className="card">
          <h2>Payment with this bill</h2>
          <div className="form-grid">
            <Field label="Amount paid now (৳)" inputMode="decimal" placeholder="0" value={head.paidAmount} error={fields.paidAmount} onChange={setHeadField('paidAmount')} hint="Leave empty if nothing was paid. The rest stays owed to the supplier." />
            <Field as="select" label="Paid by" value={head.paymentMethod} error={fields.paymentMethod} onChange={setHeadField('paymentMethod')}>
              {Object.entries(METHODS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Field>
            {head.paymentMethod !== 'cash' && <Field label="Reference / transaction ID" maxLength={60} value={head.paymentReference} error={fields.paymentReference} onChange={setHeadField('paymentReference')} />}
          </div>
          <div className="totals">
            <div>
              <span>Bill total</span>
              <span>{formatMoney(total)}</span>
            </div>
            <div>
              <span>Paid now</span>
              <span>{formatMoney(paid)}</span>
            </div>
            <div className="grand">
              <span>Owed to supplier</span>
              <span>{formatMoney(Math.max(0, Number(owed)))}</span>
            </div>
          </div>
          <div className="form-actions">
            <Link className="btn btn-ghost" href="/purchases/">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save purchase'}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
