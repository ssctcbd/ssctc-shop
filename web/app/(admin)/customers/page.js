'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import CollectDue from '@/components/CollectDue';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Checkbox, Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

function PinBox({ pin, phone }) {
  return (
    <Notice kind="success">
      Portal login for this customer — mobile <strong>{phone}</strong>, PIN <strong className="pin-text">{pin}</strong>. Tell the customer now; they can change it after logging in.
    </Notice>
  );
}

function CustomerForm({ customer, onDone, onClose }) {
  const editing = Boolean(customer);
  const [created, setCreated] = useState(null);
  const form = useForm(
    { name: customer?.name || '', phone: customer?.phone || '', address: customer?.address || '', note: customer?.note || '', isActive: customer?.isActive ?? true, portalEnabled: customer?.portalEnabled ?? true },
    async (v) => {
      const body = { name: v.name, phone: v.phone, address: v.address, note: v.note };
      if (editing) {
        await api.put(`/customers/${customer.id}`, { ...body, isActive: v.isActive, portalEnabled: v.portalEnabled });
        onDone();
      } else {
        const { customer: saved } = await api.post('/customers', body);
        // Show the PIN once before closing; without a number there is none.
        if (saved.portalPin) setCreated(saved);
        else onDone();
      }
    },
  );
  const { values: v, fields: f, set } = form;

  if (created) {
    return (
      <Modal title="Customer added" onClose={onDone}>
        <PinBox pin={created.portalPin} phone={created.phone} />
        <div className="form-actions">
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={editing ? 'Edit customer' : 'Add customer'} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error}</Notice>
        <Field label="Name" autoFocus required maxLength={120} value={v.name} error={f.name} onChange={set('name')} />
        <Field label="Mobile number" type="tel" inputMode="tel" placeholder="01XXXXXXXXX" value={v.phone} error={f.phone} onChange={set('phone')} hint="Needed for the customer portal and for selling on credit." />
        <Field label="Address" maxLength={255} value={v.address} error={f.address} onChange={set('address')} />
        <Field as="textarea" label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
        {editing && (
          <>
            <Checkbox label="Customer portal allowed" checked={v.portalEnabled} onChange={set('portalEnabled')} />
            <Checkbox label="Active" hint={f.isActive || 'Inactive customers cannot be chosen for new sales.'} checked={v.isActive} onChange={set('isActive')} />
          </>
        )}
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

function OpeningDueForm({ customer, onDone, onCancel }) {
  const form = useForm({ amount: '', date: '', note: '' }, async (v) => {
    await api.post(`/customers/${customer.id}/opening-balance`, { amount: v.amount, ...(v.date ? { date: v.date } : {}), note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;
  return (
    <form onSubmit={form.onSubmit} noValidate className="inline-box">
      <p className="muted" style={{ marginBottom: 12 }}>
        What this customer already owed before using this system. It can be recorded once.
      </p>
      <Notice>{form.error}</Notice>
      <div className="form-grid">
        <Field label="Amount owed (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
        <Field label="As of date" type="date" value={v.date} error={f.date} onChange={set('date')} hint="Leave empty for today." />
      </div>
      <Field label="Note" maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <SubmitButton busy={form.busy} block={false}>
          Save opening due
        </SubmitButton>
      </div>
    </form>
  );
}

const ADVANCE_TYPES = { deposit: 'Deposit', sale_payment: 'Spent on a sale', payment_void: 'Returned (payment voided)', return_credit: 'Credit for returned goods', refund: 'Paid back in cash' };
const DEPOSIT_METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };

function DepositForm({ customer, canVerify, onDone, onCancel }) {
  // One key per form, so a repeated save records the deposit once.
  const idempotencyKey = useRef(null);
  const form = useForm({ amount: '', method: 'cash', reference: '', note: '' }, async (v) => {
    idempotencyKey.current ||= crypto.randomUUID();
    await api.post(`/customers/${customer.id}/advance-deposit`, { idempotencyKey: idempotencyKey.current, amount: v.amount, method: v.method, reference: v.method === 'cash' ? '' : v.reference, note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;
  return (
    <form onSubmit={form.onSubmit} noValidate className="inline-box">
      <p className="muted" style={{ marginBottom: 12 }}>
        Money {customer.name} leaves with the shop to spend on later bills.
      </p>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <div className="form-grid">
        <Field label="Amount received (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
        <Field as="select" label="Received by" value={v.method} error={f.method} onChange={set('method')} hint={canVerify ? undefined : 'You can record cash. Other methods need the Owner.'}>
          {Object.entries(DEPOSIT_METHODS)
            .filter(([value]) => canVerify || value === 'cash')
            .map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
        </Field>
        {v.method !== 'cash' && <Field label="Transaction ID / reference" maxLength={60} value={v.reference} error={f.reference} onChange={set('reference')} hint="Record it only after checking the money has arrived." />}
        <Field label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <SubmitButton busy={form.busy} block={false}>
          Save advance
        </SubmitButton>
      </div>
    </form>
  );
}

function RefundAdvanceForm({ customer, onDone, onCancel }) {
  // One key per form, so a repeated save pays the money back once.
  const idempotencyKey = useRef(null);
  const form = useForm({ amount: customer.advanceBalance, note: '' }, async (v) => {
    idempotencyKey.current ||= crypto.randomUUID();
    await api.post(`/customers/${customer.id}/advance-refund`, { idempotencyKey: idempotencyKey.current, amount: v.amount, note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;
  return (
    <form onSubmit={form.onSubmit} noValidate className="inline-box">
      <p className="muted" style={{ marginBottom: 12 }}>
        Give {customer.name} their advance back in cash, from the cash drawer. They hold {formatMoney(customer.advanceBalance)}.
      </p>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <div className="form-grid">
        <Field label="Amount to pay back (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
        <Field label="Note" maxLength={255} value={v.note} error={f.note} onChange={set('note')} />
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <SubmitButton busy={form.busy} block={false}>
          Pay back
        </SubmitButton>
      </div>
    </form>
  );
}

function CustomerDetail({ id, onClose, onChanged, onEdit, onCollect }) {
  const can = useCan();
  const { data, error, reload } = useFetch(`/customers/${id}`);
  const advance = useFetch(`/customers/${id}/advance`);
  const [newPin, setNewPin] = useState('');
  const [opening, setOpening] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const movements = advance.data?.movements || [];
  const [actionError, setActionError] = useState('');
  const c = data?.customer;
  const sales = data?.sales || [];
  const hasOpening = sales.some((s) => s.saleType === 'opening_due' && s.status === 'completed');

  async function resetPin() {
    if (!window.confirm(`Issue a new portal PIN for ${c.name}? The old PIN stops working.`)) return;
    setActionError('');
    try {
      const res = await api.post(`/customers/${id}/reset-pin`);
      setNewPin(res.portalPin);
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <Modal title={c ? c.name : 'Customer'} onClose={onClose} wide>
      <Notice>{error?.message || actionError}</Notice>
      {c && (
        <>
          {newPin && <PinBox pin={newPin} phone={c.phone} />}
          <div className="grid">
            <div className={`stat ${Number(c.currentDue) > 0 ? 'due' : 'ok'}`}>
              <span>Current due</span>
              <b>{formatMoney(c.currentDue)}</b>
            </div>
            <div className="stat">
              <span>Advance balance</span>
              <b>{formatMoney(c.advanceBalance)}</b>
            </div>
          </div>

          <div className="kv">
            <div>
              <span>Mobile</span>
              {c.phone || '—'}
            </div>
            <div>
              <span>Address</span>
              {c.address || '—'}
            </div>
            <div>
              <span>Portal PIN</span>
              {!c.phone ? 'No mobile number' : !c.portalEnabled ? 'Portal turned off' : 'portalPin' in c ? c.portalPin ? <strong className="pin-text">{c.portalPin}</strong> : 'Chosen by the customer' : 'Hidden'}
            </div>
            <div>
              <span>Last portal login</span>
              {c.lastPortalLoginAt ? formatDate(c.lastPortalLoginAt) : 'Never'}
            </div>
          </div>
          {c.note && <p className="field-hint">Note: {c.note}</p>}

          <div className="page-actions" style={{ margin: '14px 0' }}>
            {can('payments.create') && Number(c.currentDue) > 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => onCollect(c)}>
                Collect due
              </button>
            )}
            {can('customers.manage') && (
              <button className="btn btn-ghost btn-sm" onClick={() => onEdit(c)}>
                Edit
              </button>
            )}
            {can('customers.manage') && !hasOpening && !opening && (
              <button className="btn btn-ghost btn-sm" onClick={() => setOpening(true)}>
                Opening due
              </button>
            )}
            {can('payments.create') && c.isActive && !depositing && (
              <button className="btn btn-ghost btn-sm" onClick={() => setDepositing(true)}>
                Add advance
              </button>
            )}
            {can('payments.void') && Number(c.advanceBalance) > 0 && !refunding && (
              <button className="btn btn-ghost btn-sm" onClick={() => setRefunding(true)}>
                Pay advance back
              </button>
            )}
            {can('customers.reset_pin') && c.phone && (
              <button className="btn btn-ghost btn-sm" onClick={resetPin}>
                Reset PIN
              </button>
            )}
          </div>
          {depositing && (
            <DepositForm
              customer={c}
              canVerify={can('payments.verify')}
              onCancel={() => setDepositing(false)}
              onDone={() => {
                setDepositing(false);
                reload();
                advance.reload();
                onChanged();
              }}
            />
          )}
          {refunding && (
            <RefundAdvanceForm
              customer={c}
              onCancel={() => setRefunding(false)}
              onDone={() => {
                setRefunding(false);
                reload();
                advance.reload();
                onChanged();
              }}
            />
          )}
          {opening && (
            <OpeningDueForm
              customer={c}
              onCancel={() => setOpening(false)}
              onDone={() => {
                setOpening(false);
                reload();
                onChanged();
              }}
            />
          )}

          <h2 className="section-title">Sales</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th className="num">Total</th>
                  <th className="num">Paid</th>
                  <th className="num">Due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className={s.status === 'void' ? 'inactive' : ''}>
                    <td className="nowrap">
                      <strong>{s.invoiceNo}</strong>
                      {s.saleType === 'opening_due' && <span className="sub">Opening due</span>}
                      {s.status === 'void' && <span className="badge badge-danger">Void</span>}
                    </td>
                    <td className="nowrap">{formatDate(s.saleDate)}</td>
                    <td className="num">{formatMoney(s.totalAmount)}</td>
                    <td className="num">
                      {formatMoney(s.paidAmount)}
                      {Number(s.unverifiedAmount) > 0 && <span className="sub">+ {formatMoney(s.unverifiedAmount)} unverified</span>}
                    </td>
                    <td className="num">{s.status === 'void' ? '—' : Number(s.dueAmount) > 0 ? <span className="qty-out">{formatMoney(s.dueAmount)}</span> : formatMoney(0)}</td>
                    <td className="num">
                      {s.saleType === 'sale' && (
                        <Link className="btn btn-ghost btn-sm" href={`/sales/invoice/?id=${s.id}`}>
                          Invoice
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sales.length === 0 && <div className="empty">No sales yet.</div>}
          </div>

          {movements.length > 0 && (
            <>
              <h2 className="section-title">Advance balance history</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>What</th>
                      <th className="num">Amount</th>
                      <th className="num">Balance after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.id}>
                        <td className="nowrap">{formatDate(m.createdAt)}</td>
                        <td>
                          {ADVANCE_TYPES[m.type] || m.type}
                          <span className="sub">{[m.receiptNo, m.method && DEPOSIT_METHODS[m.method], m.reference, m.note].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className={`num ${Number(m.amount) > 0 ? 'qty-in' : 'qty-out'}`}>{Number(m.amount) > 0 ? `+ ${formatMoney(m.amount)}` : `− ${formatMoney(Math.abs(Number(m.amount)))}`}</td>
                        <td className="num">{formatMoney(m.balanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

export default function CustomersPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ search: '', hasDue: false, status: 'active', page: 1 });
  const [searchText, setSearchText] = useState('');
  const [editing, setEditing] = useState(undefined);
  const [viewing, setViewing] = useState(null);
  const [collecting, setCollecting] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data, error, loading, reload } = useFetch(`/customers${toQuery(filters)}`);
  const items = data?.items || [];

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Customers</h1>
          <p>People who buy on credit or want their bills in the customer portal.</p>
        </div>
        {can('customers.manage') && (
          <button className="btn btn-primary" onClick={() => setEditing(null)}>
            Add customer
          </button>
        )}
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="customer-search">Search</label>
          <input id="customer-search" type="search" placeholder="Name or mobile number" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
        <Field as="select" label="Status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </Field>
        <Checkbox label="With a due only" checked={filters.hasDue} onChange={(e) => setFilters((f) => ({ ...f, hasDue: e.target.checked, page: 1 }))} />
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Mobile</th>
              <th className="num">Due</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                <td>
                  <strong>{c.name}</strong>
                  {c.address && <span className="sub">{c.address}</span>}
                </td>
                <td className="nowrap">{c.phone}</td>
                <td className="num">{Number(c.currentDue) > 0 ? <span className="qty-out">{formatMoney(c.currentDue)}</span> : formatMoney(0)}</td>
                <td className="num nowrap">
                  {can('payments.create') && Number(c.currentDue) > 0 && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => setCollecting(c)}>
                        Collect
                      </button>{' '}
                    </>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setViewing(c.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={2}>Total due, all {data.total} matching customers</td>
                <td className="num">{formatMoney(data.totalDue)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">No customers match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

      {viewing && editing === undefined && !collecting && (
        <CustomerDetail
          id={viewing}
          onClose={() => setViewing(null)}
          onChanged={reload}
          onEdit={(c) => {
            setViewing(null);
            setEditing(c);
          }}
          onCollect={setCollecting}
        />
      )}
      {collecting && (
        <CollectDue
          customer={collecting}
          onClose={() => setCollecting(null)}
          onDone={() => {
            setCollecting(null);
            reload();
          }}
        />
      )}
      {editing !== undefined && (
        <CustomerForm
          customer={editing}
          onClose={() => setEditing(undefined)}
          onDone={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
    </>
  );
}
