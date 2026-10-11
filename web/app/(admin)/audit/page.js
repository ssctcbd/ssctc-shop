'use client';

import { useState } from 'react';
import Pager from '@/components/Pager';
import { Field, Notice } from '@/components/Form';
import { formatDateTime } from '@/lib/format';
import { toQuery, useFetch } from '@/lib/useFetch';

/** "payment.void" → "Payment · void" */
const actionLabel = (action) => {
  const [area, ...rest] = action.split('.');
  return `${area.charAt(0).toUpperCase()}${area.slice(1).replace(/_/g, ' ')} · ${rest.join(' ').replace(/_/g, ' ')}`;
};

/** {status: 'active'} + {status: 'void', reason: 'x'} → "status: active → void; reason: x" */
function changes(oldValues, newValues) {
  const before = oldValues || {};
  const after = newValues || {};
  const text = (value) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].map((key) => (key in before && key in after ? `${key}: ${text(before[key])} → ${text(after[key])}` : `${key}: ${text(key in after ? after[key] : before[key])}`));
}

export default function AuditPage() {
  const [filters, setFilters] = useState({ area: '', userId: '', from: '', to: '', page: 1 });
  const { data, error, loading } = useFetch(`/audit-logs${toQuery(filters)}`);
  const users = useFetch('/users').data?.users || [];
  const items = data?.items || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <p>Who did what, and when. Nothing here can be changed or removed.</p>
      </div>

      <div className="toolbar">
        <Field as="select" label="About" value={filters.area} onChange={setFilter('area')}>
          <option value="">Everything</option>
          {(data?.areas || []).map((area) => (
            <option key={area} value={area}>
              {area.charAt(0).toUpperCase() + area.slice(1).replace(/_/g, ' ')}
            </option>
          ))}
        </Field>
        <Field as="select" label="Done by" value={filters.userId} onChange={setFilter('userId')}>
          <option value="">Anyone</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{formatDateTime(a.createdAt)}</td>
                <td>
                  {a.userName || '—'}
                  {a.ip && <span className="sub">{a.ip}</span>}
                </td>
                <td className="nowrap">
                  <strong>{actionLabel(a.action)}</strong>
                  {a.entityId && <span className="sub">#{a.entityId}</span>}
                </td>
                <td className="audit-details">
                  {changes(a.oldValues, a.newValues).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">Nothing matches.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}
    </>
  );
}
