'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LAYOUTS, METHOD_LABELS } from '@/components/Bill';
import Logo from '@/components/Logo';
import { Notice } from '@/components/Form';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

export default function ReceiptPage() {
  const [id, setId] = useState(undefined);
  const [layout, setLayout] = useState('a4');

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('id');
    setId(value && /^\d+$/.test(value) ? value : null);
    const saved = window.localStorage.getItem('ssctc.invoiceLayout');
    if (saved && LAYOUTS[saved]) setLayout(saved);
  }, []);

  const { data, error } = useFetch(id ? `/payments/${id}` : null);
  const shop = useFetch('/settings/shop').data?.settings || {};
  const p = data?.payment;
  const thermal = layout !== 'a4';

  function chooseLayout(next) {
    setLayout(next);
    window.localStorage.setItem('ssctc.invoiceLayout', next);
  }

  if (id === null) return <Notice>No payment was chosen. Open a receipt from the Payments list.</Notice>;

  return (
    <>
      <style>{`@page { size: ${LAYOUTS[layout].page}; margin: ${LAYOUTS[layout].margin}; }`}</style>

      <div className="page-head with-actions no-print">
        <div>
          <h1>Receipt{p ? ` ${p.receiptNo}` : ''}</h1>
          <p>
            <Link href="/payments/">Payments</Link> · <Link href="/dues/">Dues</Link>
          </p>
        </div>
        <div className="page-actions">
          <select className="btn btn-ghost" aria-label="Paper" value={layout} onChange={(e) => chooseLayout(e.target.value)}>
            {Object.entries(LAYOUTS).map(([value, l]) => (
              <option key={value} value={value}>
                {l.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!p}>
            Print
          </button>
        </div>
      </div>

      <div className="no-print">
        <Notice>{error?.message}</Notice>
      </div>

      {p && (
        <article className={`invoice ${thermal ? `invoice-thermal invoice-${layout}` : 'invoice-a4'}`}>
          {p.status === 'void' && <div className="invoice-void">VOID</div>}
          <header className="invoice-head">
            {!thermal && <Logo height={56} />}
            <div>
              <strong className="invoice-shop">{shop['shop.name'] || 'SS Computer Training Centre'}</strong>
              {shop['shop.tagline'] && <span>{shop['shop.tagline']}</span>}
              {shop['shop.address'] && <span>{shop['shop.address']}</span>}
              {shop['shop.phone'] && <span>Phone: {shop['shop.phone']}</span>}
            </div>
          </header>

          <div className="invoice-meta">
            <div>
              <span>Payment receipt</span>
              <strong>{p.receiptNo}</strong>
            </div>
            <div>
              <span>Date</span>
              {formatDateTime(p.paymentDate)}
            </div>
            <div>
              <span>Received from</span>
              {p.customerName || 'Walk-in'}
              {p.customerPhone ? ` · ${p.customerPhone}` : ''}
            </div>
          </div>

          <table className="invoice-items receipt-bills">
            <thead>
              <tr>
                <th>Paid against</th>
                <th className="num">Bill total</th>
                <th className="num">Paid now</th>
              </tr>
            </thead>
            <tbody>
              {p.allocations.map((a) => (
                <tr key={a.saleId}>
                  <td>
                    {a.saleType === 'opening_due' ? `Opening due (${a.invoiceNo})` : a.invoiceNo}
                    <small>{formatDate(a.saleDate)}</small>
                  </td>
                  <td className="num">{Number(a.saleTotal).toFixed(2)}</td>
                  <td className="num">{Number(a.amount).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="invoice-bottom">
            <div className="invoice-totals">
              <div className="invoice-total">
                <span>Received</span>
                <span>{formatMoney(p.amount)}</span>
              </div>
              <div>
                <span>Paid by</span>
                <span>
                  {METHOD_LABELS[p.method] || p.method}
                  {p.reference ? ` (${p.reference})` : ''}
                </span>
              </div>
              {!p.isVerified && p.status === 'active' && (
                <div>
                  <span>Standing</span>
                  <span>Not yet verified</span>
                </div>
              )}
              {p.customerDue !== null && (
                <div className="invoice-total">
                  <span>Balance still due</span>
                  <span>{formatMoney(p.customerDue)}</span>
                </div>
              )}
            </div>
          </div>

          <footer className="invoice-foot">
            {p.note && <p>{p.note}</p>}
            <p>{shop['invoice.footer']}</p>
            <p className="invoice-by">Received by {p.recordedByName}</p>
          </footer>
        </article>
      )}
    </>
  );
}
