'use client';

import { useRef, useState } from 'react';
import { useDialogs } from '@/components/Dialogs';
import Modal from '@/components/Modal';
import Pager from '@/components/Pager';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const METHODS = { cash: 'Cash (from the drawer)', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };
const ENTRY_LABELS = { sale: 'Earned on a sale', sale_void: 'Sale voided', sale_return: 'Goods returned', payout: 'Paid', payout_void: 'Payment voided' };
const signed = (value) => (Number(value) < 0 ? `− ${formatMoney(Math.abs(Number(value)))}` : formatMoney(value));

function Stat({ label, value, sub, tone = '' }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small className="muted">{sub}</small>}
    </div>
  );
}

/** One person's commission: the figures, what was paid, and every entry behind the balance. */
function Statement({ path, canManage = false, onChanged }) {
  const { askReason } = useDialogs();
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState('');
  const { data, error, reload } = useFetch(`${path}${toQuery({ page, pageSize: 30 })}`);
  const entries = data?.entries.items || [];

  async function voidPayout(p) {
    const reason = await askReason({ title: 'Void commission payment', message: `Why is the payment of ${formatMoney(p.amount)} on ${formatDateTime(p.createdAt)} being voided? The amount goes back onto the balance.`, confirmLabel: 'Void payment' });
    if (reason === null) return;
    setActionError('');
    try {
      await api.post(`/commission/payouts/${p.id}/void`, { reason });
      reload();
      onChanged?.();
    } catch (err) {
      setActionError(err.message);
    }
  }

  if (!data) return <Notice>{error?.message}</Notice>;
  return (
    <>
      <Notice>{error?.message || actionError}</Notice>
      <div className="grid">
        <Stat label="Still to be paid" value={signed(data.balance)} tone={Number(data.balance) < 0 ? 'due' : 'ok'} />
        <Stat label="Earned today" value={signed(data.today.earned)} />
        <Stat label="Earned this month" value={signed(data.thisMonth.earned)} sub={`Paid this month: ${signed(data.thisMonth.paid)}`} />
      </div>

      {data.payouts.length > 0 && (
        <>
          <h2 className="section-title">Payments received</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>How</th>
                  <th className="num">Amount</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {data.payouts.map((p) => (
                  <tr key={p.id} className={p.status === 'void' ? 'inactive' : ''}>
                    <td className="nowrap">
                      {formatDateTime(p.createdAt)}
                      <span className="sub">
                        By {p.paidByName}
                        {p.note ? ` · ${p.note}` : ''}
                      </span>
                    </td>
                    <td>
                      {METHODS[p.method].replace(' (from the drawer)', '')}
                      {p.status === 'void' && (
                        <>
                          {' '}
                          <span className="badge badge-muted">Void</span>
                          <span className="sub">{p.voidReason}</span>
                        </>
                      )}
                    </td>
                    <td className="num">{formatMoney(p.amount)}</td>
                    {canManage && (
                      <td className="num">
                        {p.status === 'active' && (
                          <button className="btn btn-danger-ghost btn-sm" onClick={() => voidPayout(p)}>
                            Void
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="section-title">History</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{formatDateTime(e.createdAt)}</td>
                <td>
                  {ENTRY_LABELS[e.type]}
                  {(e.invoiceNo || e.note) && <span className="sub">{[e.invoiceNo && e.returnNo ? `${e.returnNo} · ${e.invoiceNo}` : e.invoiceNo, e.type.startsWith('payout') ? e.note : null].filter(Boolean).join(' · ')}</span>}
                </td>
                <td className={`num ${Number(e.amount) < 0 ? 'qty-out' : 'qty-in'}`}>{signed(e.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <div className="empty">No commission yet. It is earned on every sale of a service or product that has a rate.</div>}
      </div>
      <Pager page={data.entries.page} pageSize={data.entries.pageSize} total={data.entries.total} onPage={setPage} />
    </>
  );
}

function PayForm({ person, onDone, onClose }) {
  // One key per payment, reused if the same save is repeated, so it is stored once.
  const idempotencyKey = useRef(crypto.randomUUID());
  const form = useForm({ amount: Number(person.balance) > 0 ? person.balance : '', method: 'cash', note: '' }, async (v) => {
    await api.post('/commission/payouts', { idempotencyKey: idempotencyKey.current, userId: person.id, amount: v.amount, method: v.method, note: v.note });
    onDone();
  });
  const { values: v, fields: f, set } = form;

  return (
    <Modal title={`Pay commission to ${person.name}`} onClose={onClose}>
      <form onSubmit={form.onSubmit} noValidate>
        <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
        <p className="muted" style={{ marginBottom: 12 }}>
          Owed: {formatMoney(person.balance)}.
        </p>
        <Field label="Amount (৳)" inputMode="decimal" autoFocus required value={v.amount} error={f.amount} onChange={set('amount')} />
        <Field as="select" label="Paid by" value={v.method} error={f.method} onChange={set('method')} hint={v.method === 'cash' ? "Comes out of today's cash drawer: the cash must be open." : undefined}>
          {Object.entries(METHODS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        <Field label="Note" maxLength={255} placeholder="e.g. Week of 20 October" value={v.note} error={f.note} onChange={set('note')} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={form.busy} block={false}>
            Pay
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

/** The Owner: everyone's balance, what they earned, and paying them. */
function AllStaff() {
  const { data, error, reload } = useFetch('/commission/staff');
  const [paying, setPaying] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [message, setMessage] = useState('');
  const staff = data?.staff || [];

  return (
    <>
      <Notice>{error?.message}</Notice>
      {message && <Notice kind="success">{message}</Notice>}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Staff</th>
              <th className="num">Earned today</th>
              <th className="num">Earned this month</th>
              <th className="num">Paid this month</th>
              <th className="num">Still to be paid</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className={s.status === 'blocked' ? 'inactive' : ''}>
                <td>
                  <strong>{s.name}</strong>
                  {!s.commissionEnabled && <span className="badge badge-muted">Commission off</span>}
                  <span className="sub">{s.username}</span>
                </td>
                <td className="num">{signed(s.earnedToday)}</td>
                <td className="num">{signed(s.earnedThisMonth)}</td>
                <td className="num">{signed(s.paidThisMonth)}</td>
                <td className={`num ${Number(s.balance) < 0 ? 'due-text' : ''}`}>
                  <strong>{signed(s.balance)}</strong>
                </td>
                <td className="num nowrap">
                  <button className="btn btn-ghost btn-sm" onClick={() => setViewing(s)}>
                    Details
                  </button>{' '}
                  <button className="btn btn-primary btn-sm" disabled={Number(s.balance) <= 0} onClick={() => setPaying(s)}>
                    Pay
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && staff.length === 0 && <div className="empty">Nobody earns commission yet. Switch it on for a user on the Users screen, and set rates on Services and Categories.</div>}
      </div>
      <p className="field-hint">Rates are set on the Services and Categories screens. Commission is earned when a sale is recorded; a void or return takes it back.</p>

      {paying && (
        <PayForm
          person={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setMessage(`Commission paid to ${paying.name}.`);
            setPaying(null);
            reload();
          }}
        />
      )}
      {viewing && (
        <Modal title={`Commission: ${viewing.name}`} onClose={() => setViewing(null)} wide>
          <Statement path={`/commission/staff/${viewing.id}`} canManage onChanged={reload} />
        </Modal>
      )}
    </>
  );
}

export default function CommissionPage() {
  const can = useCan();
  const manage = can('commission.manage');

  return (
    <>
      <div className="page-head">
        <h1>{manage ? 'Commission' : 'My commission'}</h1>
        <p>{manage ? 'What each staff member has earned on their sales, and what has been paid.' : 'What you have earned on the sales you recorded, and what you have been paid.'}</p>
      </div>
      {manage ? <AllStaff /> : <Statement path="/commission/me" />}
    </>
  );
}
