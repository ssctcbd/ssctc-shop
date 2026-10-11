'use client';

import { useState } from 'react';
import Pager from '@/components/Pager';
import { Field, Notice, SubmitButton } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch, useForm } from '@/lib/useFetch';

const OTHER_METHODS = { bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };
const paisa = (value) => Math.round(Number(value || 0) * 100);
const money = (p) => (p / 100).toFixed(2);
/** "Short by ৳ 20.00", "Over by ৳ 5.00" or "Matches". */
const describe = (difference) => (paisa(difference) === 0 ? 'Matches' : `${paisa(difference) < 0 ? 'Short' : 'Over'} by ${formatMoney(Math.abs(Number(difference)))}`);

function Sheet({ d, opening }) {
  const rows = [
    ['Cash sales', d.cashSales, '+'],
    ['Dues collected in cash', d.cashDuesCollected, '+'],
    ['Advance deposits in cash', d.cashAdvanceDeposits, '+'],
    ['Came back (voided expenses and supplier payments)', d.cashVoidsIn, '+'],
    ['Expenses paid in cash', d.cashExpenses, '−'],
    ['Paid to suppliers in cash', d.cashSupplierPaid, '−'],
    ['Refunds given in cash', d.cashRefunds, '−'],
  ].filter(([, amount], index) => index < 2 || index === 4 || paisa(amount) > 0);
  const expected = paisa(opening) + paisa(d.expectedCash) - paisa(d.openingCash);

  return (
    <div className="totals cash-sheet">
      <div>
        <span>Opening cash</span>
        <span>{opening === '' ? '—' : formatMoney(opening)}</span>
      </div>
      {rows.map(([label, amount, sign]) => (
        <div key={label}>
          <span>{label}</span>
          <span className={sign === '+' ? 'qty-in' : 'qty-out'}>
            {sign} {formatMoney(amount)}
          </span>
        </div>
      ))}
      <div className="grand">
        <span>{opening === '' ? 'Change in cash so far (opening cash not entered yet)' : 'Cash that should be in the drawer'}</span>
        <span>{expected < 0 ? `− ${formatMoney(money(-expected))}` : formatMoney(money(expected))}</span>
      </div>
    </div>
  );
}

function CloseForm({ d, onClosed, onStale }) {
  const first = d.openingCash === null;
  const form = useForm({ openingCash: '', actualCash: '', withdrawn: '', note: '' }, async (v) => {
    const expected = paisa(first ? v.openingCash : d.openingCash) + paisa(d.expectedCash) - paisa(d.openingCash);
    try {
      const res = await api.post('/cash-register/close', {
        actualCash: v.actualCash,
        withdrawn: v.withdrawn || '0',
        expectedCash: `${expected < 0 ? '-' : ''}${money(Math.abs(expected))}`,
        ...(first ? { openingCash: v.openingCash } : {}),
        note: v.note,
      });
      onClosed(res.closing);
    } catch (err) {
      // Something was recorded while this screen was open: show the new figures.
      if (err.status === 409 && err.details?.expectedCash) onStale();
      throw err;
    }
  });
  const { values: v, fields: f, set } = form;
  const opening = first ? v.openingCash : d.openingCash;
  const expected = paisa(opening) + paisa(d.expectedCash) - paisa(d.openingCash);
  const counted = v.actualCash !== '' && !Number.isNaN(Number(v.actualCash));
  const difference = counted ? money(paisa(v.actualCash) - expected) : null;

  return (
    <form onSubmit={form.onSubmit} noValidate className="card">
      <h2>Close the cash</h2>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      {first && <Field label="Opening cash (৳)" inputMode="decimal" required value={v.openingCash} error={f.openingCash} onChange={set('openingCash')} hint="Cash that was in the drawer before the first sale. Asked only this once." />}
      <Field label="Cash counted in the drawer (৳)" inputMode="decimal" required value={v.actualCash} error={f.actualCash} onChange={set('actualCash')} hint={difference === null ? 'Count the notes and coins, then type the total.' : `Should be ${formatMoney(money(expected))} · ${describe(difference)}`} />
      <Field label="Taken out after counting (৳)" inputMode="decimal" placeholder="0" value={v.withdrawn} error={f.withdrawn} onChange={set('withdrawn')} hint="To the bank or home. What stays is the next opening cash." />
      <Field as="textarea" label={difference !== null && paisa(difference) !== 0 ? 'Note (needed: explain the difference)' : 'Note'} maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
      <SubmitButton busy={form.busy} busyText="Closing…">
        Close the cash
      </SubmitButton>
      <p className="field-hint">A closing cannot be changed afterwards. Sales and payments recorded after it count toward the next closing.</p>
    </form>
  );
}

export default function CashPage() {
  const can = useCan();
  const [page, setPage] = useState(1);
  const [justClosed, setJustClosed] = useState(null);
  const [stale, setStale] = useState(false);
  const current = useFetch('/cash-register/current');
  const history = useFetch(`/cash-register/history${toQuery({ page, pageSize: 30 })}`);
  const d = current.data;
  const closings = history.data?.items || [];
  const others = d ? Object.entries(OTHER_METHODS).filter(([method]) => paisa(d.otherMethods[method]) > 0) : [];

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Cash closing</h1>
          <p>What should be in the cash drawer, checked against what is counted.</p>
        </div>
        <button className="btn btn-ghost" onClick={current.reload}>
          Refresh
        </button>
      </div>

      <Notice>{current.error?.message || history.error?.message}</Notice>
      {justClosed && (
        <Notice kind="success">
          Cash closed for {formatDate(`${justClosed.closingDate}T00:00:00+06:00`)}. {describe(justClosed.difference)}. {formatMoney(justClosed.carriedForward)} stays in the drawer as the next opening cash.
        </Notice>
      )}
      {stale && <Notice kind="warning">Something was recorded while this screen was open. The figures below are now up to date: check them and count again.</Notice>}

      {d && (
        <div className="cash-columns" style={{ marginBottom: 24 }}>
          <div className="card">
            <h2>Cash drawer now</h2>
            <p className="muted" style={{ marginBottom: 10 }}>
              {d.periodStart ? `Since the last closing, ${formatDateTime(d.periodStart)}.` : 'Since the system started: the cash has never been closed.'}
            </p>
            <Sheet d={d} opening={d.openingCash ?? ''} />
            {others.length > 0 && (
              <div className="totals cash-sheet">
                <div className="head">
                  <span>Received by other means (not in the drawer)</span>
                </div>
                {others.map(([method, label]) => (
                  <div key={method}>
                    <span>{label}</span>
                    <span>{formatMoney(d.otherMethods[method])}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {can('cash.close') &&
            (d.closedToday ? (
              <div className="card">
                <h2>Close the cash</h2>
                <Notice kind="success">Today&apos;s cash has been closed. Anything recorded since then will be in tomorrow&apos;s closing.</Notice>
              </div>
            ) : (
              <CloseForm
                key={d.asOf}
                d={d}
                onStale={() => {
                  setStale(true);
                  current.reload();
                }}
                onClosed={(closing) => {
                  setJustClosed(closing);
                  setStale(false);
                  current.reload();
                  history.reload();
                }}
              />
            ))}
        </div>
      )}

      <h2 className="section-title">Past closings</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Opening</th>
              <th className="num">Cash in</th>
              <th className="num">Cash out</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th>Result</th>
              <th className="num">Taken out</th>
            </tr>
          </thead>
          <tbody>
            {closings.map((c) => (
              <tr key={c.id}>
                <td className="nowrap">
                  <strong>{formatDate(`${c.closingDate}T00:00:00+06:00`)}</strong>
                  <span className="sub">
                    {formatDateTime(c.closedAt)} · {c.closedByName}
                  </span>
                </td>
                <td className="num">{formatMoney(c.openingCash)}</td>
                <td className="num qty-in">{formatMoney(money(paisa(c.cashSales) + paisa(c.cashDuesCollected) + paisa(c.cashAdvanceDeposits) + paisa(c.cashVoidsIn)))}</td>
                <td className="num qty-out">{formatMoney(money(paisa(c.cashExpenses) + paisa(c.cashSupplierPaid) + paisa(c.cashRefunds)))}</td>
                <td className="num">{formatMoney(c.expectedCash)}</td>
                <td className="num">{formatMoney(c.actualCash)}</td>
                <td>
                  <span className={`badge ${paisa(c.difference) === 0 ? 'badge-ok' : 'badge-danger'}`}>{describe(c.difference)}</span>
                  {c.note && <span className="sub">{c.note}</span>}
                </td>
                <td className="num">
                  {formatMoney(c.cashWithdrawn)}
                  <span className="sub">{formatMoney(c.carriedForward)} left in</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.loading && !history.error && closings.length === 0 && <div className="empty">The cash has not been closed yet.</div>}
      </div>
      {history.data && <Pager page={history.data.page} pageSize={history.data.pageSize} total={history.data.total} onPage={setPage} />}
    </>
  );
}
