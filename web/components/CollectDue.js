'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import Modal from './Modal';
import { METHOD_LABELS } from './Bill';
import { Checkbox, Field, Notice, SubmitButton } from './Form';
import { api } from '@/lib/api';
import { formatDate, formatMoney, sumMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

const paisa = (value) => Math.round(Number(value || 0) * 100);

/** How `amount` falls on the bills, oldest first. Preview only; the server does the real split. */
function oldestFirst(sales, amount) {
  let left = paisa(amount);
  const split = {};
  for (const s of sales) {
    const take = Math.max(0, Math.min(left, paisa(s.collectableAmount)));
    split[s.id] = (take / 100).toFixed(2);
    left -= take;
  }
  return split;
}

/**
 * Take money against what a customer owes. `customer` needs id, name and
 * advanceBalance. Calls onDone when something was saved, onClose to dismiss.
 */
export default function CollectDue({ customer, onDone, onClose }) {
  const can = useCan();
  const canVerify = can('payments.verify');
  const { data, error } = useFetch(`/customers/${customer.id}/open-sales`);
  const sales = data?.sales || [];
  const collectable = sumMoney(sales.map((s) => s.collectableAmount));
  const waiting = sumMoney(sales.map((s) => s.unverifiedAmount));

  // One key per form, so a repeated save records the payment once.
  const idempotencyKey = useRef(null);
  const [manual, setManual] = useState(false);
  const [chosen, setChosen] = useState({});
  const [receipt, setReceipt] = useState(null);

  const form = useForm({ amount: '', method: 'cash', reference: '', verified: false, date: '', note: '' }, async (v) => {
    idempotencyKey.current ||= crypto.randomUUID();
    const allocations = sales.filter((s) => paisa(chosen[s.id]) > 0).map((s) => ({ saleId: s.id, amount: chosen[s.id] }));
    const noReference = v.method === 'cash' || v.method === 'customer_advance';
    const res = await api.post('/payments', {
      idempotencyKey: idempotencyKey.current,
      customerId: customer.id,
      amount: manual ? sumMoney(allocations.map((a) => a.amount)) : v.amount,
      method: v.method,
      reference: noReference ? '' : v.reference,
      verified: !noReference && canVerify && v.verified,
      ...(v.date ? { date: v.date } : {}),
      note: v.note,
      ...(manual ? { allocations } : {}),
    });
    setReceipt(res.payment);
  });
  const { values: v, fields: f, set } = form;
  const preview = manual ? chosen : oldestFirst(sales, v.amount);
  const lineError = Object.entries(f).find(([path]) => path.startsWith('allocations.'));

  if (receipt) {
    return (
      <Modal title="Payment saved" onClose={onDone}>
        <Notice kind="success">
          Receipt {receipt.receiptNo}: {formatMoney(receipt.amount)} from {customer.name}.{' '}
          {receipt.isVerified ? `They now owe ${formatMoney(receipt.customerDue)}.` : 'It is waiting to be verified; the due comes down when the Owner confirms the money arrived.'}
        </Notice>
        <div className="form-actions">
          <Link className="btn btn-ghost" href={`/payments/receipt/?id=${receipt.id}`}>
            Print receipt
          </Link>
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Collect due — ${customer.name}`} onClose={onClose} wide>
      <Notice>{error?.message || (lineError ? lineError[1] : form.error !== 'Please check the highlighted fields.' && form.error)}</Notice>
      {data && sales.length === 0 && <div className="empty">{customer.name} has no due.</div>}
      {sales.length > 0 && (
        <form onSubmit={form.onSubmit} noValidate>
          <p className="muted" style={{ marginBottom: 12 }}>
            {formatMoney(collectable)} can be collected.
            {paisa(waiting) > 0 && ` ${formatMoney(waiting)} more has been paid but is waiting to be verified.`}
          </p>
          <div className="form-grid">
            {!manual && (
              <Field
                label="Amount received (৳)"
                inputMode="decimal"
                autoFocus
                required
                value={v.amount}
                error={f.amount}
                onChange={set('amount')}
                hint={
                  <button type="button" className="link" onClick={() => form.setValues((x) => ({ ...x, amount: collectable }))}>
                    Whole due: {formatMoney(collectable)}
                  </button>
                }
              />
            )}
            <Field as="select" label="Paid by" value={v.method} error={f.method} onChange={set('method')}>
              {Object.entries(METHOD_LABELS)
                .filter(([value]) => value !== 'customer_advance' || Number(customer.advanceBalance) > 0)
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {value === 'customer_advance' ? `${label} (${formatMoney(customer.advanceBalance)})` : label}
                  </option>
                ))}
            </Field>
            {v.method !== 'cash' && v.method !== 'customer_advance' && <Field label="Transaction ID / reference" maxLength={60} value={v.reference} error={f.reference} onChange={set('reference')} />}
            {can('sales.backdate') && <Field label="Date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />}
          </div>
          {v.method !== 'cash' &&
            v.method !== 'customer_advance' &&
            (canVerify ? (
              <Checkbox label="I have checked: the money has arrived" hint="Leave unticked to verify it later. Until then the due does not come down." checked={v.verified} onChange={set('verified')} />
            ) : (
              <p className="field-hint">This payment will wait for the Owner to verify it. Until then the due does not come down.</p>
            ))}

          <h2 className="section-title">Bills</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th className="num">Due</th>
                  <th className="num">This payment</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap">
                      <strong>{s.invoiceNo}</strong>
                      {s.saleType === 'opening_due' && <span className="sub">Opening due</span>}
                    </td>
                    <td className="nowrap">{formatDate(s.saleDate)}</td>
                    <td className="num">
                      {formatMoney(s.dueAmount)}
                      {paisa(s.unverifiedAmount) > 0 && <span className="sub">{formatMoney(s.unverifiedAmount)} unverified</span>}
                    </td>
                    <td className="num">
                      {manual ? (
                        <input className="cell-input" aria-label={`Amount for ${s.invoiceNo}`} inputMode="decimal" placeholder="0" value={chosen[s.id] ?? ''} onChange={(e) => setChosen((c) => ({ ...c, [s.id]: e.target.value }))} />
                      ) : paisa(preview[s.id]) > 0 ? (
                        formatMoney(preview[s.id])
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {manual && (
                <tfoot>
                  <tr>
                    <td colSpan={3}>Amount received</td>
                    <td className="num">{formatMoney(sumMoney(Object.values(chosen)))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {sales.length > 1 && <Checkbox label="Choose the bills myself" hint="Otherwise the oldest bill is paid first." checked={manual} onChange={(e) => setManual(e.target.checked)} />}
          <Field label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <SubmitButton busy={form.busy} block={false}>
              Save payment
            </SubmitButton>
          </div>
        </form>
      )}
    </Modal>
  );
}
