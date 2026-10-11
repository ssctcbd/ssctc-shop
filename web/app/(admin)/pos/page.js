'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Checkbox, Field, Notice } from '@/components/Form';
import { api } from '@/lib/api';
import { formatMoney, lineTotal, sumMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { useFetch } from '@/lib/useFetch';

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };
// Cash is in hand and advance is money the shop already holds: neither needs a reference or a check.
const isSettled = (method) => method === 'cash' || method === 'customer_advance';

/**
 * One box for products and services: type a name, or type/scan a code. When
 * the text matches an entry it is added to the sale and the box clears, ready
 * for the next scan.
 */
function ItemEntry({ entries, onAdd }) {
  const id = useId();
  const [text, setText] = useState('');

  function onInput(next) {
    const wanted = next.trim().toLowerCase();
    const match = wanted && entries.find((e) => e.label.toLowerCase() === wanted || (e.code && e.code.toLowerCase() === wanted));
    if (match) {
      onAdd(match);
      setText('');
    } else setText(next);
  }

  return (
    <div className="field">
      <label htmlFor={id}>Add product or service</label>
      <input id={id} list={`${id}-list`} value={text} autoFocus autoComplete="off" placeholder="Type a name, or scan / type a code" onChange={(e) => onInput(e.target.value)} />
      <datalist id={`${id}-list`}>
        {entries.map((e) => (
          <option key={e.key} value={e.label}>
            {e.hint}
          </option>
        ))}
      </datalist>
    </div>
  );
}

export default function PosPage() {
  const can = useCan();
  const router = useRouter();
  const products = useFetch('/products/options').data?.products;
  const services = useFetch('/services').data?.services;
  const customers = useFetch('/customers/options').data?.customers || [];
  const customerListId = useId();

  // One key per sale, reused if the same save is repeated, so it is stored once.
  const idempotencyKey = useRef(null);
  const nextKey = useRef(1);
  const [customerText, setCustomerText] = useState('');
  const [lines, setLines] = useState([]);
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [saleDate, setSaleDate] = useState('');
  const [payments, setPayments] = useState([{ key: 0, method: 'cash', amount: '', reference: '', verified: false }]);
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const entries = useMemo(
    () => [
      ...(products || []).map((p) => ({ key: `p${p.id}`, type: 'product', id: p.id, code: p.sku, label: `${p.sku} — ${p.name}`, name: p.name, unit: p.unit, price: p.price, stock: p.trackStock ? p.stockQty : null, hint: `${formatMoney(p.price)}${p.trackStock ? ` · ${p.stockQty} in stock` : ''}` })),
      ...(services || []).filter((s) => s.isActive).map((s) => ({ key: `s${s.id}`, type: 'service', id: s.id, code: null, label: `Service — ${s.name}`, name: s.name, unit: s.unit, price: s.defaultPrice, stock: null, priceEditable: s.priceEditable, hint: `${formatMoney(s.defaultPrice)} per ${s.unit}` })),
    ],
    [products, services],
  );

  const customerLabel = (c) => `${c.name}${c.phone ? ` — ${c.phone}` : ''}`;
  const customer = customers.find((c) => customerLabel(c).toLowerCase() === customerText.trim().toLowerCase() || (c.phone && c.phone === customerText.trim())) || null;
  const walkInName = customer ? '' : customerText.trim();

  const clearErrors = () => {
    setError('');
    setFields({});
  };

  function addEntry(entry) {
    clearErrors();
    setLines((all) => {
      // Scanning the same product again adds one more, unless that line carries a serial number.
      const same = all.find((l) => l.entryKey === entry.key && !l.serialNo);
      if (same) return all.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l));
      return [...all, { key: nextKey.current++, entryKey: entry.key, type: entry.type, id: entry.id, name: entry.name, unit: entry.unit, listPrice: entry.price, unitPrice: entry.price, stock: entry.stock, priceEditable: entry.type === 'service' ? entry.priceEditable : false, quantity: '1', warranty: '', serialNo: '' }];
    });
  }
  const setLine = (key, patch) => {
    clearErrors();
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const setPayment = (key, patch) => {
    clearErrors();
    setPayments((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };

  const subtotal = sumMoney(lines.map((l) => lineTotal(l.unitPrice, l.quantity)));
  const total = Math.max(0, Number(subtotal) - Number(discount || 0)).toFixed(2);
  const tendered = sumMoney(payments.map((p) => p.amount));
  const mayVerify = can('payments.verify');
  const counted = sumMoney(payments.filter((p) => isSettled(p.method) || (p.verified && mayVerify)).map((p) => p.amount));
  const advance = customer ? Number(customer.advanceBalance) : 0;
  const due = (Number(total) - Number(counted)).toFixed(2);
  const unverified = (Number(tendered) - Number(counted)).toFixed(2);

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    clearErrors();
    if (lines.length === 0) return setError('Add at least one product or service.');
    setBusy(true);
    idempotencyKey.current ||= crypto.randomUUID();
    const sentPayments = payments.filter((p) => p.amount !== '' && Number(p.amount) !== 0);
    try {
      const { sale } = await api.post('/sales', {
        idempotencyKey: idempotencyKey.current,
        customerId: customer ? customer.id : null,
        walkInName,
        note,
        ...(saleDate ? { date: saleDate } : {}),
        discountAmount: discount || '0',
        items: lines.map((l) => ({
          type: l.type,
          ...(l.type === 'product' ? { productId: l.id, warranty: l.warranty, serialNo: l.serialNo } : { serviceId: l.id }),
          quantity: l.quantity,
          // The price is sent only when it was changed; otherwise the server uses the catalog price.
          ...(Number(l.unitPrice) !== Number(l.listPrice) ? { unitPrice: l.unitPrice } : {}),
        })),
        payments: sentPayments.map((p) => ({ method: p.method, amount: p.amount, reference: isSettled(p.method) ? '' : p.reference, verified: !isSettled(p.method) && p.verified && mayVerify })),
      });
      router.replace(`/sales/invoice/?id=${sale.id}&new=1`);
    } catch (err) {
      const mapped = {};
      for (const [path, message] of Object.entries(err.fields || {})) {
        const item = /^items\.(\d+)\.(\w+)$/.exec(path);
        const payment = /^payments\.(\d+)\.(\w+)$/.exec(path);
        if (item && lines[Number(item[1])]) mapped[`line.${lines[Number(item[1])].key}.${item[2] === 'productId' || item[2] === 'serviceId' ? 'item' : item[2]}`] = message;
        else if (payment && sentPayments[Number(payment[1])]) mapped[`pay.${sentPayments[Number(payment[1])].key}.${payment[2]}`] = message;
        else mapped[path] = message;
      }
      setFields(mapped);
      // Messages about the sale as a whole are shown at the top; line messages sit on their lines.
      setError(mapped.customerId || mapped.payments || mapped.discountAmount || (Object.keys(mapped).length ? 'Please check the highlighted fields.' : err.message));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>New sale</h1>
        <p>Products, printing, photocopy and online services on one bill.</p>
      </div>

      <form onSubmit={onSubmit} noValidate className="pos">
        <div className="pos-main">
          <Notice>{error}</Notice>
          <div className="card">
            <ItemEntry entries={entries} onAdd={addEntry} />
            {lines.length === 0 ? (
              <div className="empty">Nothing on the bill yet.</div>
            ) : (
              <div className="pos-lines">
                {lines.map((l) => {
                  const priceLocked = l.type === 'product' ? !can('sales.edit_price') : !l.priceEditable && !can('sales.edit_price');
                  const short = l.stock !== null && Number(l.quantity) > l.stock;
                  return (
                    <div className="pos-line" key={l.key}>
                      <div className="pos-line-name">
                        <strong>{l.name}</strong>
                        <span className="sub">
                          {l.type === 'service' ? `Service · per ${l.unit}` : l.stock !== null ? `${l.stock} ${l.unit} in stock` : l.unit}
                        </span>
                        {(fields[`line.${l.key}.item`] || short) && <p className="field-error">{fields[`line.${l.key}.item`] || `Only ${l.stock} in stock.`}</p>}
                      </div>
                      <Field label="Qty" type="number" min={1} step={1} value={l.quantity} error={fields[`line.${l.key}.quantity`]} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
                      <Field label="Price (৳)" inputMode="decimal" disabled={priceLocked} value={l.unitPrice} error={fields[`line.${l.key}.unitPrice`]} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                      <div className="pos-line-total">{formatMoney(lineTotal(l.unitPrice, l.quantity))}</div>
                      <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${l.name}`} onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>
                        ×
                      </button>
                      {l.type === 'product' && (
                        <div className="pos-line-extra">
                          <Field label="Warranty" maxLength={50} placeholder="e.g. 1 Year" value={l.warranty} onChange={(e) => setLine(l.key, { warranty: e.target.value })} />
                          <Field label="Serial no." maxLength={100} value={l.serialNo} onChange={(e) => setLine(l.key, { serialNo: e.target.value })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <aside className="pos-side">
          <div className="card">
            <div className="field">
              <label htmlFor="pos-customer">Customer</label>
              <input id="pos-customer" list={customerListId} value={customerText} autoComplete="off" placeholder="Walk-in — or type a name / mobile" aria-invalid={fields.customerId ? 'true' : undefined} onChange={(e) => (clearErrors(), setCustomerText(e.target.value))} />
              <datalist id={customerListId}>
                {customers.map((c) => (
                  <option key={c.id} value={customerLabel(c)}>
                    {Number(c.currentDue) > 0 ? `Owes ${formatMoney(c.currentDue)}` : 'No due'}
                  </option>
                ))}
              </datalist>
              <p className="field-hint">{customer ? `Saved customer${Number(customer.currentDue) > 0 ? ` · already owes ${formatMoney(customer.currentDue)}` : ''}${advance > 0 ? ` · advance balance ${formatMoney(advance)}` : ''}` :walkInName ? 'Walk-in (name printed on the invoice). A due needs a saved customer.' : 'Walk-in sale.'}</p>
            </div>

            <div className="totals" style={{ maxWidth: 'none' }}>
              <div>
                <span>Subtotal</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              <div className="totals-input">
                <label htmlFor="pos-discount">Discount (৳)</label>
                <input id="pos-discount" inputMode="decimal" placeholder="0" value={discount} aria-invalid={fields.discountAmount ? 'true' : undefined} onChange={(e) => (clearErrors(), setDiscount(e.target.value))} />
              </div>
              <div className="grand">
                <span>Total</span>
                <span>{formatMoney(total)}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Payment</h2>
            {payments.map((p) => (
              <div className="pos-pay" key={p.key}>
                <Field as="select" label="Method" value={p.method} onChange={(e) => setPayment(p.key, { method: e.target.value })}>
                  {Object.entries(METHODS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                  {(advance > 0 || p.method === 'customer_advance') && <option value="customer_advance">Advance balance ({formatMoney(advance)})</option>}
                </Field>
                <Field label="Amount (৳)" inputMode="decimal" placeholder="0" value={p.amount} error={fields[`pay.${p.key}.amount`]} onChange={(e) => setPayment(p.key, { amount: e.target.value })} />
                {p.method === 'customer_advance' && Number(p.amount) > advance && <p className="field-error pos-pay-wide">Only {formatMoney(advance)} is available in the advance balance.</p>}
                {!isSettled(p.method) && (
                  <div className="pos-pay-wide">
                    <Field label="Transaction ID / reference" maxLength={60} value={p.reference} error={fields[`pay.${p.key}.reference`] || fields['payments.reference']} onChange={(e) => setPayment(p.key, { reference: e.target.value })} />
                    {mayVerify ? <Checkbox label="I have checked: the money has arrived" checked={p.verified} onChange={(e) => setPayment(p.key, { verified: e.target.checked })} /> : <p className="field-hint">Counts as paid only after the Owner verifies it.</p>}
                  </div>
                )}
              </div>
            ))}
            <div className="page-actions" style={{ marginBottom: 12 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayment(payments[0].key, { amount: (Number(total) - Number(tendered) + Number(payments[0].amount || 0)).toFixed(2) })}>
                Pay in full
              </button>
              {payments.length < 3 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayments((all) => [...all, { key: nextKey.current++, method: 'bkash', amount: '', reference: '', verified: false }])}>
                  Add another payment
                </button>
              )}
              {payments.length > 1 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPayments((all) => all.slice(0, -1))}>
                  Remove last
                </button>
              )}
            </div>

            <div className="totals" style={{ maxWidth: 'none' }}>
              <div>
                <span>Paid now</span>
                <span>{formatMoney(counted)}</span>
              </div>
              {Number(unverified) > 0 && (
                <div>
                  <span>Awaiting verification</span>
                  <span>{formatMoney(unverified)}</span>
                </div>
              )}
              <div className={`grand ${Number(due) > 0 ? 'due-text' : ''}`}>
                <span>Due</span>
                <span>{formatMoney(Math.max(0, Number(due)))}</span>
              </div>
            </div>
            {Number(due) > 0 && !customer && lines.length > 0 && <p className="field-error">This leaves a due. Choose a saved customer or take full payment.</p>}
            <Field as="textarea" label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            {can('sales.backdate') && <Field label="Sale date" type="date" value={saleDate} error={fields.date} onChange={(e) => (clearErrors(), setSaleDate(e.target.value))} hint="Leave empty for today. Only for a sale written on paper earlier." />}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Saving…' : 'Complete sale'}
            </button>
          </div>
        </aside>
      </form>
    </>
  );
}
