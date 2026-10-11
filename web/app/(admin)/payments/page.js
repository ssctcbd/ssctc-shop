'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { METHOD_LABELS } from '@/components/Bill';
import Pager from '@/components/Pager';
import { Field, Notice } from '@/components/Form';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch } from '@/lib/useFetch';

export default function PaymentsPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ search: '', method: '', kind: '', verified: '', status: 'all', from: '', to: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data, error, loading, reload } = useFetch(`/payments${toQuery(filters)}`);
  const items = data?.items || [];
  const setFilter = (name) => (event) => setFilters((f) => ({ ...f, [name]: event.target.value, page: 1 }));

  async function act(path, body) {
    setActionError('');
    try {
      await api.post(path, body);
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }
  function voidPayment(p) {
    const reason = window.prompt(`Why is receipt ${p.receiptNo} (${formatMoney(p.amount)}) being voided?`);
    if (reason && reason.trim().length >= 3) act(`/payments/${p.id}/void`, { reason: reason.trim() });
    else if (reason !== null) setActionError('Write a reason of at least 3 characters to void a payment.');
  }

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Payments</h1>
          <p>Every receipt: money taken with a sale, and dues collected later.</p>
        </div>
        <Link className="btn btn-primary" href="/dues/">
          Collect a due
        </Link>
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="payment-search">Search</label>
          <input id="payment-search" type="search" placeholder="Receipt no., transaction ID, customer or mobile" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
        <Field as="select" label="Method" value={filters.method} onChange={setFilter('method')}>
          <option value="">All</option>
          {Object.entries(METHOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Field>
        <Field as="select" label="Type" value={filters.kind} onChange={setFilter('kind')}>
          <option value="">All</option>
          <option value="sale">With a sale</option>
          <option value="due_collection">Due collection</option>
        </Field>
        <Field as="select" label="Standing" value={filters.verified} onChange={setFilter('verified')}>
          <option value="">All</option>
          <option value="0">Waiting to be verified</option>
          <option value="1">Verified</option>
        </Field>
        <Field as="select" label="Show" value={filters.status} onChange={setFilter('status')}>
          <option value="all">All payments</option>
          <option value="active">Not voided</option>
          <option value="void">Voided only</option>
        </Field>
        <Field label="From" type="date" value={filters.from} onChange={setFilter('from')} />
        <Field label="To" type="date" value={filters.to} onChange={setFilter('to')} />
      </div>

      <Notice>{error?.message || actionError}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Customer</th>
              <th>Method</th>
              <th className="num">Amount</th>
              <th>Standing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={p.status === 'void' ? 'inactive' : ''}>
                <td className="nowrap">
                  <strong>{p.receiptNo}</strong>
                  <span className="sub">{formatDateTime(p.paymentDate)}</span>
                </td>
                <td>
                  {p.customerName || 'Walk-in'}
                  <span className="sub">
                    {p.kind === 'due_collection' ? 'Due collection · ' : ''}
                    {p.invoices}
                  </span>
                </td>
                <td>
                  {METHOD_LABELS[p.method]}
                  {p.reference && <span className="sub">{p.reference}</span>}
                </td>
                <td className="num">{formatMoney(p.amount)}</td>
                <td>
                  {p.status === 'void' ? <span className="badge badge-danger">Void</span> : p.isVerified ? <span className="badge badge-ok">Verified</span> : <span className="badge badge-warn">Unverified</span>}
                  <span className="sub">{p.status === 'void' ? p.voidReason : `By ${p.recordedByName}`}</span>
                </td>
                <td className="num nowrap">
                  {p.status === 'active' && (
                    <>
                      {can('payments.verify') &&
                        (p.isVerified ? (
                          p.method !== 'cash' &&
                          p.method !== 'customer_advance' && (
                            <button className="btn btn-ghost btn-sm" onClick={() => act(`/payments/${p.id}/unverify`)}>
                              Unverify
                            </button>
                          )
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => act(`/payments/${p.id}/verify`)}>
                            Verify
                          </button>
                        ))}{' '}
                      {can('payments.void') && (
                        <button className="btn btn-danger-ghost btn-sm" onClick={() => voidPayment(p)}>
                          Void
                        </button>
                      )}{' '}
                    </>
                  )}
                  <Link className="btn btn-ghost btn-sm" href={`/payments/receipt/?id=${p.id}`}>
                    Receipt
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>
                  Verified, all {data.total} matching payments
                  {Number(data.totalUnverified) > 0 && ` · ${formatMoney(data.totalUnverified)} more waiting to be verified`}
                </td>
                <td className="num">{formatMoney(data.totalVerified)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">No payments match.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}
    </>
  );
}
