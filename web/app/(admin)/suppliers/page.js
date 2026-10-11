'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/Modal';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDate, formatMoney, sumMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { useFetch, useForm } from '@/lib/useFetch';

function SupplierForm({ supplier, onDone, onClose }) {
  const editing = Boolean(supplier);
  const form = useForm(
    { name: supplier?.name || '', company: supplier?.company || '', phone: supplier?.phone || '', address: supplier?.address || '', note: supplier?.note || '', isActive: supplier?.isActive ?? true },
    async (v) => {
      const body = { name: v.name, company: v.company, phone: v.phone, address: v.address, note: v.note };
      if (editing) await api.put(`/suppliers/${supplier.id}`, { ...body, isActive: v.isActive });
      else await api.post('/suppliers', body);
      onDone();
    },
  );
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={editing ? 'Edit supplier' : 'Add supplier'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Name" autoFocus required maxLength={120} value={v.name} error={f.name} onChange={set('name')} />
        <div className="form-grid">
          <Field label="Company" maxLength={150} value={v.company} error={f.company} onChange={set('company')} />
          <Field label="Mobile" type="tel" maxLength={15} value={v.phone} error={f.phone} onChange={set('phone')} />
        </div>
        <Field label="Address" maxLength={255} value={v.address} error={f.address} onChange={set('address')} />
        <Field as="textarea" label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
        {editing && <Checkbox label="Active" hint="Inactive suppliers cannot be chosen for new purchases." checked={v.isActive} onChange={set('isActive')} />}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Save
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function OpeningPayableForm({ supplier, onDone, onClose }) {
  const form = useForm({ amount: '', date: '', note: '' }, async (v) => {
    await api.post(`/suppliers/${supplier.id}/opening-payable`, { amount: v.amount, ...(v.date ? { date: v.date } : {}), note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={`Opening payable — ${supplier.name}`} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <p className="muted" style={{ marginBottom: 14 }}>
          What the shop already owed this supplier before using this system. It can be recorded once.
        </p>
        <Notice>{form.error}</Notice>
        <div className="form-grid">
          <Field label="Amount owed (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
          <Field label="As of date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />
        </div>
        <Field as="textarea" label="Note" maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Save
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };

function PayForm({ supplier, onDone, onClose }) {
  // One key per form, so a repeated save records the payment once.
  const idempotencyKey = useRef(null);
  const { data, error } = useFetch(`/suppliers/${supplier.id}/open-purchases`);
  const bills = data?.purchases || [];
  const [billId, setBillId] = useState('');
  const chosen = bills.find((b) => String(b.id) === billId);
  const form = useForm({ amount: '', method: 'cash', reference: '', date: '', note: '' }, async (v) => {
    idempotencyKey.current ||= crypto.randomUUID();
    await api.post('/supplier-payments', {
      idempotencyKey: idempotencyKey.current,
      supplierId: supplier.id,
      amount: v.amount,
      method: v.method,
      reference: v.method === 'cash' ? '' : v.reference,
      ...(v.date ? { date: v.date } : {}),
      note: v.note,
      ...(chosen ? { allocations: [{ purchaseId: chosen.id, amount: v.amount }] } : {}),
    });
    onDone();
  });
  const { values: v, fields: f, set } = form;
  const most = chosen ? chosen.dueAmount : supplier.currentPayable;

  return (
    <Modal title={`Pay ${supplier.name}`} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <p className="muted" style={{ marginBottom: 14 }}>
          The shop owes {formatMoney(supplier.currentPayable)} on {bills.length} bill(s).
        </p>
        <Notice>{error?.message || f['allocations.0.amount'] || (form.error !== 'Please check the highlighted fields.' && form.error)}</Notice>
        <Field as="select" label="Pay against" value={billId} onChange={(e) => setBillId(e.target.value)} hint={chosen ? undefined : 'The oldest bill is paid first; anything left goes to the next one.'}>
          <option value="">Oldest bill first</option>
          {bills.map((b) => (
            <option key={b.id} value={b.id}>
              {b.purchaseNo} · {formatDate(b.purchaseDate)} · owed {formatMoney(b.dueAmount)}
            </option>
          ))}
        </Field>
        <div className="form-grid">
          <Field
            label="Amount paid (৳)"
            inputMode="decimal"
            autoFocus
            required
            value={v.amount}
            error={f.amount}
            onChange={set('amount')}
            hint={
              <button type="button" className="link" onClick={() => form.setValues((x) => ({ ...x, amount: most }))}>
                All of it: {formatMoney(most)}
              </button>
            }
          />
          <Field as="select" label="Paid by" value={v.method} error={f.method} onChange={set('method')} hint={v.method === 'cash' ? 'Comes out of the cash drawer.' : undefined}>
            {Object.entries(METHODS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Field>
          {v.method !== 'cash' && <Field label="Transaction ID / cheque no." maxLength={60} value={v.reference} error={f.reference} onChange={set('reference')} />}
          <Field label="Date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />
        </div>
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
    </Modal>
  );
}

function PaymentsDialog({ supplier, canManage, onChanged, onClose }) {
  const { data, error, reload } = useFetch(`/supplier-payments?supplierId=${supplier.id}&pageSize=200`);
  const [actionError, setActionError] = useState('');
  const items = data?.items || [];

  async function voidPayment(p) {
    const reason = window.prompt(`Why is ${p.voucherNo} (${formatMoney(p.amount)}) being voided? Its bills will be owed again.`);
    if (reason === null) return;
    if (reason.trim().length < 3) return setActionError('Write a reason of at least 3 characters to void a payment.');
    setActionError('');
    try {
      await api.post(`/supplier-payments/${p.id}/void`, { reason: reason.trim() });
      reload();
      onChanged();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <Modal title={`Payments to ${supplier.name}`} onClose={onClose} wide>
      <Notice>{error?.message || actionError}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Paid by</th>
              <th>Bills</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={p.status === 'void' ? 'inactive' : ''}>
                <td className="nowrap">
                  <strong>{p.voucherNo}</strong>
                  <span className="sub">{formatDate(p.paymentDate)}</span>
                </td>
                <td>
                  {METHODS[p.method]}
                  {p.status === 'void' && <span className="badge badge-danger">Void</span>}
                  <span className="sub">{[p.reference, p.status === 'void' ? p.voidReason : p.note].filter(Boolean).join(' · ')}</span>
                </td>
                <td>{p.purchases}</td>
                <td className="num">{formatMoney(p.amount)}</td>
                <td className="num">
                  {canManage && p.status === 'active' && (
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => voidPayment(p)}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>Total paid (voided ones left out)</td>
                <td className="num">{formatMoney(data.totalAmount)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {data && items.length === 0 && <div className="empty">No payments recorded yet.</div>}
      </div>
    </Modal>
  );
}

export default function SuppliersPage() {
  const can = useCan();
  const { data, error, loading, reload } = useFetch('/suppliers');
  const [editing, setEditing] = useState(undefined);
  const [opening, setOpening] = useState(null);
  const [paying, setPaying] = useState(null);
  const [history, setHistory] = useState(null);
  const suppliers = data?.suppliers || [];
  const manage = can('suppliers.manage');
  const canPay = can('purchases.manage');
  const done = () => {
    setEditing(undefined);
    setOpening(null);
    setPaying(null);
    reload();
  };

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Suppliers</h1>
          <p>Who the shop buys from, and how much is owed to each.</p>
        </div>
        {manage && (
          <button className="btn btn-primary" onClick={() => setEditing(null)}>
            Add supplier
          </button>
        )}
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Mobile</th>
              <th className="num">Payable</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id} className={s.isActive ? '' : 'inactive'}>
                <td>
                  <strong>{s.name}</strong>
                  {s.company && <span className="sub">{s.company}</span>}
                  {!s.isActive && <span className="badge badge-muted">Inactive</span>}
                </td>
                <td className="nowrap">{s.phone}</td>
                <td className="num">{Number(s.currentPayable) > 0 ? <span className="qty-out">{formatMoney(s.currentPayable)}</span> : formatMoney(0)}</td>
                <td className="num nowrap">
                  <Link className="btn btn-ghost btn-sm" href={`/purchases/?supplierId=${s.id}`}>
                    Purchases
                  </Link>{' '}
                  <button className="btn btn-ghost btn-sm" onClick={() => setHistory(s)}>
                    Payments
                  </button>{' '}
                  {canPay && Number(s.currentPayable) > 0 && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => setPaying(s)}>
                        Pay
                      </button>{' '}
                    </>
                  )}
                  {manage && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => setOpening(s)}>
                        Opening payable
                      </button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {suppliers.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={2}>Total payable</td>
                <td className="num">{formatMoney(sumMoney(suppliers.map((s) => s.currentPayable)))}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && suppliers.length === 0 &&<div className="empty">No suppliers yet.</div>}
      </div>

      {editing !== undefined && <SupplierForm supplier={editing} onClose={() => setEditing(undefined)} onDone={done} />}
      {opening && <OpeningPayableForm supplier={opening} onClose={() => setOpening(null)} onDone={done} />}
      {paying && <PayForm supplier={paying} onClose={() => setPaying(null)} onDone={done} />}
      {history && <PaymentsDialog supplier={history} canManage={canPay} onChanged={reload} onClose={() => setHistory(null)} />}
    </>
  );
}
