'use client';

import { useState } from 'react';
import { Field, Notice } from '@/components/Form';
import { API_BASE } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch } from '@/lib/useFetch';

// Every report comes from the API as columns + rows + totals, so one table
// draws them all, and the CSV file holds exactly what is on screen.
const REPORTS = [
  { id: 'sales', label: 'Sales', path: 'sales', range: true, groups: { day: 'By day', month: 'By month', item: 'By product and service', category: 'By category' } },
  { id: 'profit', label: 'Profit and loss', path: 'profit-loss', range: true, permission: 'reports.financial' },
  { id: 'expenses', label: 'Expenses', path: 'expenses', range: true, groups: { category: 'By category', day: 'By day', month: 'By month' } },
  { id: 'payments', label: 'Payments collected', path: 'payments', range: true, groups: { day: 'By day', month: 'By month' } },
  { id: 'dues', label: 'Customer dues and their age', path: 'dues' },
  { id: 'suppliers', label: 'Supplier payables', path: 'suppliers' },
  { id: 'cash', label: 'Cash closings', path: 'cash-closings', range: true },
  { id: 'stock', label: 'Stock', path: 'stock', views: { levels: 'Current levels', low: 'Low stock', movements: 'Movements in a period' } },
];

/** "YYYY-MM-DD" for a Dhaka date `offsetDays` from today. */
const dhakaDay = (offsetDays = 0) => new Date(Date.now() + 6 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const monthStart = (day) => `${day.slice(0, 8)}01`;
function lastMonth() {
  const end = new Date(`${monthStart(dhakaDay())}T00:00:00Z`);
  end.setUTCDate(0); // the day before the 1st
  const to = end.toISOString().slice(0, 10);
  return { from: monthStart(to), to };
}

function cell(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'money') return Number(value) < 0 ? `− ${formatMoney(Math.abs(Number(value)))}` : formatMoney(value);
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(`${value}T00:00:00+06:00`) : value;
  return value;
}

export default function ReportsPage() {
  const can = useCan();
  const reports = REPORTS.filter((r) => !r.permission || can(r.permission));
  const [id, setId] = useState('sales');
  const [groupBy, setGroupBy] = useState('');
  const [view, setView] = useState('levels');
  const [dates, setDates] = useState({ from: monthStart(dhakaDay()), to: dhakaDay() });

  const def = reports.find((r) => r.id === id) || reports[0];
  const group = def.groups ? (def.groups[groupBy] ? groupBy : Object.keys(def.groups)[0]) : undefined;
  const hasRange = def.range || (def.id === 'stock' && view === 'movements');
  const params = { ...(hasRange ? dates : {}), ...(group ? { groupBy: group } : {}), ...(def.views ? { view } : {}) };
  const badRange = hasRange && dates.from && dates.to && dates.from > dates.to;
  const path = `/reports/${def.path}`;
  const { data: r, error, loading } = useFetch(badRange ? null : `${path}${toQuery(params)}`);
  const numeric = (type) => type === 'money' || type === 'number';

  return (
    <>
      <div className="page-head with-actions no-print">
        <div>
          <h1>Reports</h1>
          <p>Figures for any period. Each report can be printed or saved as a spreadsheet file.</p>
        </div>
        <div className="page-actions">
          <a className={`btn btn-ghost${r ? '' : ' disabled'}`} href={`${API_BASE}${path}${toQuery({ ...params, format: 'csv' })}`}>
            Download CSV
          </a>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!r}>
            Print
          </button>
        </div>
      </div>

      <div className="toolbar no-print">
        <Field as="select" label="Report" value={def.id} onChange={(e) => setId(e.target.value)}>
          {reports.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </Field>
        {def.groups && (
          <Field as="select" label="Show" value={group} onChange={(e) => setGroupBy(e.target.value)}>
            {Object.entries(def.groups).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Field>
        )}
        {def.views && (
          <Field as="select" label="Show" value={view} onChange={(e) => setView(e.target.value)}>
            {Object.entries(def.views).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Field>
        )}
        {hasRange && (
          <>
            <Field label="From" type="date" value={dates.from} onChange={(e) => setDates((d) => ({ ...d, from: e.target.value }))} />
            <Field label="To" type="date" value={dates.to} onChange={(e) => setDates((d) => ({ ...d, to: e.target.value }))} />
            <div className="page-actions" style={{ marginBottom: 2 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setDates({ from: dhakaDay(), to: dhakaDay() })}>
                Today
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDates({ from: monthStart(dhakaDay()), to: dhakaDay() })}>
                This month
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDates(lastMonth())}>
                Last month
              </button>
            </div>
          </>
        )}
      </div>

      <Notice>{badRange ? 'The "from" date is after the "to" date.' : error?.message}</Notice>
      {r && !badRange && (
        <>
          <h2 className="section-title" style={{ marginTop: 0 }}>
            {r.title}
            {r.from && (
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}
                · {r.from === r.to ? cell(r.from, 'date') : `${cell(r.from, 'date')} to ${cell(r.to, 'date')}`}
              </span>
            )}
          </h2>
          <div className="table-wrap">
            <table className="data report">
              <thead>
                <tr>
                  {r.columns.map((c) => (
                    <th key={c.key} className={numeric(c.type) ? 'num' : ''}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, index) => (
                  <tr key={index} className={row.kind === 'subtotal' ? 'subtotal' : ''}>
                    {r.columns.map((c) => (
                      <td key={c.key} className={`${numeric(c.type) ? 'num' : ''}${c.type === 'money' && Number(row[c.key]) < 0 ? ' qty-out' : ''}`}>
                        {cell(row[c.key], c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {r.totals && r.rows.length > 0 && (
                <tfoot>
                  <tr>
                    {r.columns.map((c) => (
                      <td key={c.key} className={numeric(c.type) ? 'num' : ''}>
                        {cell(r.totals[c.key], c.type)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
            {!loading && r.rows.length === 0 && <div className="empty">Nothing to show for this period.</div>}
          </div>
          {(r.notes || []).map((note) => (
            <p key={note} className="field-hint">
              {note}
            </p>
          ))}
        </>
      )}
    </>
  );
}
