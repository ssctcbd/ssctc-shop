'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import CollectDue from '@/components/CollectDue';
import Pager from '@/components/Pager';
import { Notice } from '@/components/Form';
import { formatDate, formatMoney } from '@/lib/format';
import { useCan } from '@/lib/session';
import { toQuery, useFetch } from '@/lib/useFetch';

export default function DuesPage() {
  const can = useCan();
  const [filters, setFilters] = useState({ search: '', page: 1 });
  const [searchText, setSearchText] = useState('');
  const [collecting, setCollecting] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.search === searchText ? f : { search: searchText, page: 1 })), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data, error, loading, reload } = useFetch(`/dues${toQuery(filters)}`);
  const items = data?.items || [];

  return (
    <>
      <div className="page-head with-actions">
        <div>
          <h1>Dues</h1>
          <p>Customers who owe the shop, biggest balance first.</p>
        </div>
        {can('payments.view') && (
          <Link className="btn btn-ghost" href="/payments/">
            All payments
          </Link>
        )}
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="due-search">Search</label>
          <input id="due-search" type="search" placeholder="Name or mobile number" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
      </div>

      <Notice>{error?.message}</Notice>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="num">Unpaid bills</th>
              <th>Oldest unpaid</th>
              <th className="num">Due</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                  <span className="sub">{c.phone}</span>
                </td>
                <td className="num">{c.unpaidSales}</td>
                <td className="nowrap">{formatDate(c.oldestSaleDate)}</td>
                <td className="num">
                  <span className="qty-out">{formatMoney(c.currentDue)}</span>
                  {Number(c.unverifiedAmount) > 0 && <span className="sub">{formatMoney(c.unverifiedAmount)} awaiting verification</span>}
                  {Number(c.advanceBalance) > 0 && <span className="sub">Advance held: {formatMoney(c.advanceBalance)}</span>}
                </td>
                <td className="num nowrap">
                  {can('payments.create') && (
                    <button className="btn btn-primary btn-sm" onClick={() => setCollecting(c)}>
                      Collect
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {data && items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3}>Total due, all {data.total} customers</td>
                <td className="num">{formatMoney(data.totalDue)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {!loading && !error && items.length === 0 && <div className="empty">Nobody owes the shop anything.</div>}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />}

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
    </>
  );
}
