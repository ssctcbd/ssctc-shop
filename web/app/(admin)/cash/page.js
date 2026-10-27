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
const signedMoney = (p) => (p < 0 ? `− ${formatMoney(money(-p))}` : formatMoney(money(p)));
const shopDate = (day) => formatDate(`${day}T00:00:00+06:00`);
/** "Short by ৳ 20.00", "Over by ৳ 5.00" or "Matches". */
const describe = (difference) => (paisa(difference) === 0 ? 'Matches' : `${paisa(difference) < 0 ? 'Short' : 'Over'} by ${formatMoney(Math.abs(Number(difference)))}`);

const cashIn = (d) => paisa(d.cashSales) + paisa(d.cashDuesCollected) + paisa(d.cashAdvanceDeposits) + paisa(d.cashVoidsIn);
const cashOut = (d) => paisa(d.cashExpenses) + paisa(d.cashSupplierPaid) + paisa(d.cashCommissionPaid) + paisa(d.cashRefunds);

/** Opening cash, every movement in and out, and what should be in the drawer. */
function Sheet({ d, openingLabel = 'Opening cash (counted this morning)' }) {
  const rows = [
    ['Cash sales', d.cashSales, '+'],
    ['Dues collected in cash', d.cashDuesCollected, '+'],
    ['Advance deposits in cash', d.cashAdvanceDeposits, '+'],
    ['Came back (voided expenses, supplier and commission payments)', d.cashVoidsIn, '+'],
    ['Expenses paid in cash', d.cashExpenses, '−'],
    ['Paid to suppliers in cash', d.cashSupplierPaid, '−'],
    ['Commission paid in cash', d.cashCommissionPaid, '−'],
    ['Refunds given in cash', d.cashRefunds, '−'],
  ].filter(([, amount], index) => index < 2 || index === 4 || paisa(amount) > 0);

  return (
    <div className="totals cash-sheet">
      <div>
        <span>{openingLabel}</span>
        <span>{formatMoney(d.openingCash)}</span>
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
        <span>Cash that should be in the drawer</span>
        <span>{signedMoney(paisa(d.expectedCash))}</span>
      </div>
    </div>
  );
}

/** Morning: count the drawer against what the last hand-over left in it. */
function OpenForm({ d, onOpened, onStale }) {
  const first = d.carriedCash === null;
  const form = useForm({ countedCash: '', note: '' }, async (v) => {
    try {
      const res = await api.post('/cash-register/open', { countedCash: v.countedCash, carriedCash: d.carriedCash, note: v.note });
      onOpened(res.opening);
    } catch (err) {
      // The Owner took cash while this screen was open: show the new figure.
      if (err.status === 409 && err.details && 'carriedCash' in err.details) onStale();
      throw err;
    }
  });
  const { values: v, fields: f, set } = form;
  const counted = v.countedCash !== '' && !Number.isNaN(Number(v.countedCash));
  const difference = counted && !first ? money(paisa(v.countedCash) - paisa(d.carriedCash)) : null;

  return (
    <form onSubmit={form.onSubmit} noValidate className="card">
      <h2>Open today&apos;s cash</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        {first ? 'The first day: count the notes and coins in the drawer before the first sale.' : `Last night ${formatMoney(d.carriedCash)} was left in the drawer. Count it before the first sale.`}
      </p>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field
        label="Cash counted in the drawer (৳)"
        inputMode="decimal"
        required
        autoFocus
        value={v.countedCash}
        error={f.countedCash}
        onChange={set('countedCash')}
        hint={difference === null ? 'Count the notes and coins, then type the total.' : `Should be ${formatMoney(d.carriedCash)} · ${describe(difference)}`}
      />
      <Field as="textarea" label={difference !== null && paisa(difference) !== 0 ? 'Note (needed: explain the difference)' : 'Note'} maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
      <SubmitButton busy={form.busy} busyText="Opening…">
        Open the cash
      </SubmitButton>
      <p className="field-hint">Sales, payments and expenses can be recorded once the cash is open.</p>
    </form>
  );
}

/** Night: count the drawer and hand it over. */
function CloseForm({ d, onClosed, onStale }) {
  const form = useForm({ actualCash: '', note: '' }, async (v) => {
    try {
      const res = await api.post('/cash-register/close', { actualCash: v.actualCash, expectedCash: d.expectedCash, note: v.note });
      onClosed(res.closing);
    } catch (err) {
      // Something was recorded while this screen was open: show the new figures.
      if (err.status === 409 && err.details?.expectedCash) onStale();
      throw err;
    }
  });
  const { values: v, fields: f, set } = form;
  const counted = v.actualCash !== '' && !Number.isNaN(Number(v.actualCash));
  const difference = counted ? money(paisa(v.actualCash) - paisa(d.expectedCash)) : null;

  return (
    <form onSubmit={form.onSubmit} noValidate className="card">
      <h2>Hand over the cash</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        At the end of the day: count the drawer. The Owner sees this sheet and takes the cash.
      </p>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field
        label="Cash counted in the drawer (৳)"
        inputMode="decimal"
        required
        value={v.actualCash}
        error={f.actualCash}
        onChange={set('actualCash')}
        hint={difference === null ? 'Count the notes and coins, then type the total.' : `Should be ${signedMoney(paisa(d.expectedCash))} · ${describe(difference)}`}
      />
      <Field as="textarea" label={difference !== null && paisa(difference) !== 0 ? 'Note (needed: explain the difference)' : 'Note'} maxLength={500} value={v.note} error={f.note} onChange={set('note')} />
      <SubmitButton busy={form.busy} busyText="Closing…">
        Close and hand over
      </SubmitButton>
      <p className="field-hint">After this nothing that moves money can be recorded until the cash is opened again tomorrow morning. A closing cannot be changed.</p>
    </form>
  );
}

/** The Owner takes cash from the handed-over drawer; the rest stays for tomorrow. */
function ReceiveForm({ d, onReceived }) {
  const left = paisa(d.carriedCash);
  const form = useForm({ amount: '', note: '' }, async (v) => {
    await api.post('/cash-register/receive', { amount: v.amount, note: v.note });
    onReceived();
  });
  const { values: v, fields: f, set } = form;
  const typed = v.amount !== '' && !Number.isNaN(Number(v.amount));

  return (
    <form onSubmit={form.onSubmit} noValidate className="card">
      <h2>Receive cash</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        {formatMoney(d.carriedCash)} is in the drawer. Take what you want; whatever stays is where tomorrow starts. Taking nothing is fine too.
      </p>
      <Notice>{form.error !== 'Please check the highlighted fields.' && form.error}</Notice>
      <Field
        label="Amount taken (৳)"
        inputMode="decimal"
        required
        value={v.amount}
        error={f.amount}
        onChange={set('amount')}
        hint={typed ? `${formatMoney(money(Math.max(0, left - paisa(v.amount))))} stays in the drawer.` : undefined}
      />
      <Field label="Note" maxLength={255} placeholder="e.g. To the bank" value={v.note} error={f.note} onChange={set('note')} />
      <div className="page-actions">
        <button type="button" className="btn btn-ghost" onClick={() => form.setValues((x) => ({ ...x, amount: money(left) }))} disabled={left <= 0}>
          All of it
        </button>
        <SubmitButton busy={form.busy} busyText="Saving…" block={false}>
          Receive
        </SubmitButton>
      </div>
    </form>
  );
}

/** The sheet of a closing, as handed over. */
function HandedOver({ c }) {
  return (
    <div className="card">
      <h2>Handed over: {shopDate(c.closingDate)}</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        Closed by {c.closedByName}, {formatDateTime(c.closedAt)}.
      </p>
      <Sheet d={c} openingLabel="Opening cash" />
      <div className="totals cash-sheet">
        <div>
          <span>Cash counted at the hand-over</span>
          <span>{formatMoney(c.actualCash)}</span>
        </div>
        <div>
          <span>Result</span>
          <span className={`badge ${paisa(c.difference) === 0 ? 'badge-ok' : 'badge-danger'}`}>{describe(c.difference)}</span>
        </div>
        {c.note && <p className="field-hint">{c.note}</p>}
        {c.receipts.map((r) => (
          <div key={r.id}>
            <span>
              Received by {r.receivedByName}
              <span className="sub">
                {formatDateTime(r.receivedAt)}
                {r.note ? ` · ${r.note}` : ''}
              </span>
            </span>
            <span className="qty-out">− {formatMoney(r.amount)}</span>
          </div>
        ))}
        <div className="grand">
          <span>Left in the drawer for tomorrow</span>
          <span>{formatMoney(c.carriedForward)}</span>
        </div>
      </div>
    </div>
  );
}

export default function CashPage() {
  const can = useCan();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const current = useFetch('/cash-register/current');
  const history = useFetch(`/cash-register/history${toQuery({ page, pageSize: 30 })}`);
  const d = current.data;
  const closings = history.data?.items || [];
  const isOpen = d?.status === 'open';
  const others = isOpen ? Object.entries(OTHER_METHODS).filter(([method]) => paisa(d.otherMethods[method]) > 0) : [];
  // One opening and one hand-over per shop day.
  const handedOverToday = d && !isOpen && d.lastClosing && d.lastClosing.closingDate >= d.cashDate;

  const refresh = () => {
    current.reload();
    history.reload();
  };
  const onStale = () => {
    setStale(true);
    current.reload();
  };

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Cash</h1>
          <p>Counted in the morning, handed over at night: what should be in the drawer against what is there.</p>
        </div>
        <button className="btn btn-ghost" onClick={current.reload}>
          Refresh
        </button>
      </div>

      <Notice>{current.error?.message || history.error?.message}</Notice>
      {message && <Notice kind="success">{message}</Notice>}
      {stale && <Notice kind="warning">Something changed while this screen was open. The figures below are now up to date: check them and count again.</Notice>}

      {d && isOpen && (
        <>
          {d.stale && (
            <Notice kind="warning">
              This cash day was opened on {shopDate(d.opening.openingDate)} and never handed over. Count the drawer and close it now; then open today&apos;s cash. Nothing new can be recorded until then.
            </Notice>
          )}
          <div className="cash-columns" style={{ marginBottom: 24 }}>
            <div className="card">
              <h2>Cash drawer now</h2>
              <p className="muted" style={{ marginBottom: 10 }}>
                Opened by {d.opening.openedByName}, {formatDateTime(d.opening.openedAt)}
                {d.opening.carriedCash !== null && paisa(d.opening.difference) !== 0 ? ` · the morning count was ${describe(d.opening.difference).toLowerCase()}` : ''}.
              </p>
              <Sheet d={d} />
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
              {d.byStaff && d.byStaff.length > 0 && (
                <div className="totals cash-sheet">
                  <div className="head">
                    <span>Work today</span>
                    <span>Bills · sold · commission</span>
                  </div>
                  {d.byStaff.map((s) => (
                    <div key={s.userId}>
                      <span>{s.name}</span>
                      <span>
                        {s.bills} · {formatMoney(s.sold)} · {formatMoney(s.commission)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {can('cash.close') && (
              <CloseForm
                key={d.asOf}
                d={d}
                onStale={onStale}
                onClosed={(closing) => {
                  setMessage(`Cash handed over for ${shopDate(closing.closingDate)}. ${describe(closing.difference)}. ${formatMoney(closing.actualCash)} is in the drawer.`);
                  setStale(false);
                  refresh();
                }}
              />
            )}
          </div>
        </>
      )}

      {d && !isOpen && (
        <div className="cash-columns" style={{ marginBottom: 24 }}>
          {d.lastClosing ? (
            <HandedOver c={d.lastClosing} />
          ) : (
            <div className="card">
              <h2>Cash not opened yet</h2>
              <p className="muted">Nothing has been counted so far. Open the cash to start the first day.</p>
            </div>
          )}
          <div>
            {can('cash.receive') && d.lastClosing && paisa(d.carriedCash) > 0 && (
              <ReceiveForm
                key={d.carriedCash}
                d={d}
                onReceived={() => {
                  setMessage('Cash received. The drawer figure is updated.');
                  refresh();
                }}
              />
            )}
            {can('cash.open') &&
              (handedOverToday ? (
                <div className="card">
                  <h2>Open the cash</h2>
                  <Notice kind="success">Today&apos;s cash has been handed over. The next day is opened tomorrow morning.</Notice>
                </div>
              ) : (
                <OpenForm
                  key={`${d.asOf}-${d.carriedCash}`}
                  d={d}
                  onStale={onStale}
                  onOpened={(opening) => {
                    setMessage(`Cash opened for ${shopDate(opening.openingDate)} with ${formatMoney(opening.countedCash)}${opening.difference !== null && paisa(opening.difference) !== 0 ? ` (${describe(opening.difference).toLowerCase()})` : ''}.`);
                    setStale(false);
                    refresh();
                  }}
                />
              ))}
          </div>
        </div>
      )}

      <h2 className="section-title">Past days</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Morning count</th>
              <th className="num">Cash in</th>
              <th className="num">Cash out</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th>Result</th>
              <th className="num">Owner took</th>
            </tr>
          </thead>
          <tbody>
            {closings.map((c) => (
              <tr key={c.id}>
                <td className="nowrap">
                  <strong>{shopDate(c.closingDate)}</strong>
                  <span className="sub">
                    {c.opening ? `Opened by ${c.opening.openedByName} · ` : ''}closed by {c.closedByName}
                  </span>
                </td>
                <td className="num">
                  {formatMoney(c.openingCash)}
                  {c.opening && c.opening.difference !== null && paisa(c.opening.difference) !== 0 && <span className="sub">{describe(c.opening.difference)}</span>}
                </td>
                <td className="num qty-in">{formatMoney(money(cashIn(c)))}</td>
                <td className="num qty-out">{formatMoney(money(cashOut(c)))}</td>
                <td className="num">{signedMoney(paisa(c.expectedCash))}</td>
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
        {!history.loading && !history.error && closings.length === 0 && <div className="empty">No day has been handed over yet.</div>}
      </div>
      {history.data && <Pager page={history.data.page} pageSize={history.data.pageSize} total={history.data.total} onPage={setPage} />}
    </>
  );
}
