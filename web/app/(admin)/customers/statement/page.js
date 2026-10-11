'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Logo from '@/components/Logo';
import { Field, Notice } from '@/components/Form';
import { formatDate, formatMoney } from '@/lib/format';
import { toQuery, useFetch } from '@/lib/useFetch';

const KINDS = { bill: 'Bill', opening_due: 'Opening due', payment: 'Payment', return: 'Returned goods' };
const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', customer_advance: 'Advance balance', other: 'Other' };
/** "bkash · INV-000004" → "bKash · INV-000004" */
const detail = (text) => (text ? text.replace(/^[a-z_]+/, (method) => METHODS[method] || method) : '');
const balance = (value) => (Number(value) < 0 ? `− ${formatMoney(Math.abs(Number(value)))}` : formatMoney(value));

export default function StatementPage() {
  const [id, setId] = useState(undefined);
  const [dates, setDates] = useState({ from: '', to: '' });

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('id');
    setId(value && /^\d+$/.test(value) ? value : null);
  }, []);

  const badRange = dates.from && dates.to && dates.from > dates.to;
  const { data: s, error } = useFetch(id && !badRange ? `/customers/${id}/statement${toQuery(dates)}` : null);
  const shop = useFetch('/settings/shop').data?.settings || {};

  if (id === null) return <Notice>No customer was chosen. Open a statement from the Customers list.</Notice>;

  return (
    <>
      <style>{'@page { size: A4; margin: 14mm; }'}</style>

      <div className="page-head with-actions no-print">
        <div>
          <h1>Statement{s ? ` — ${s.customer.name}` : ''}</h1>
          <p>
            <Link href="/customers/">Customers</Link> · <Link href="/dues/">Dues</Link>
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => window.print()} disabled={!s}>
          Print
        </button>
      </div>

      <div className="toolbar no-print">
        <Field label="From" type="date" value={dates.from} onChange={(e) => setDates((d) => ({ ...d, from: e.target.value }))} hint="Empty = from the first bill." />
        <Field label="To" type="date" value={dates.to} onChange={(e) => setDates((d) => ({ ...d, to: e.target.value }))} hint="Empty = up to now." />
      </div>

      <div className="no-print">
        <Notice>{badRange ? 'The "from" date is after the "to" date.' : error?.message}</Notice>
      </div>

      {s && (
        <article className="invoice invoice-a4">
          <header className="invoice-head">
            <Logo height={56} />
            <div>
              <strong className="invoice-shop">{shop['shop.name'] || 'SS Computer Training Centre'}</strong>
              {shop['shop.address'] && <span>{shop['shop.address']}</span>}
              {shop['shop.phone'] && <span>Phone: {shop['shop.phone']}</span>}
            </div>
          </header>

          <div className="invoice-meta">
            <div>
              <span>Statement of account</span>
              <strong>{s.customer.name}</strong>
            </div>
            <div>
              <span>Mobile</span>
              {s.customer.phone || '—'}
            </div>
            <div>
              <span>Period</span>
              {s.from ? formatDate(`${s.from}T00:00:00+06:00`) : 'From the first bill'} to {s.to ? formatDate(`${s.to}T00:00:00+06:00`) : formatDate(new Date())}
            </div>
          </div>

          <table className="invoice-items">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th className="num">Billed</th>
                <th className="num">Paid</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {s.from && (
                <tr>
                  <td />
                  <td>Balance brought forward</td>
                  <td />
                  <td />
                  <td className="num">{balance(s.openingBalance)}</td>
                </tr>
              )}
              {s.entries.map((e, index) => (
                <tr key={index}>
                  <td>{formatDate(e.date)}</td>
                  <td>
                    {KINDS[e.kind]} {e.reference}
                    {e.detail && <small>{detail(e.detail)}</small>}
                  </td>
                  <td className="num">{e.debit ? Number(e.debit).toFixed(2) : ''}</td>
                  <td className="num">{e.credit ? Number(e.credit).toFixed(2) : ''}</td>
                  <td className="num">{balance(e.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.entries.length === 0 && <p className="muted">Nothing in this period.</p>}

          <div className="invoice-bottom">
            <div className="invoice-totals">
              <div>
                <span>Billed in this period</span>
                <span>{formatMoney(s.totalBilled)}</span>
              </div>
              <div>
                <span>Paid and returned in this period</span>
                <span>{formatMoney(s.totalPaid)}</span>
              </div>
              <div className="invoice-total">
                <span>{s.to ? 'Balance at the end of the period' : 'Balance due now'}</span>
                <span>{balance(s.closingBalance)}</span>
              </div>
              {Number(s.customer.advanceBalance) > 0 && (
                <div>
                  <span>Advance held by the shop</span>
                  <span>{formatMoney(s.customer.advanceBalance)}</span>
                </div>
              )}
            </div>
          </div>

          <footer className="invoice-foot">
            <p>Payments still waiting to be verified are not included.</p>
            {(shop['payment.bkash_number'] || shop['payment.nagad_number']) && (
              <p>{[shop['payment.bkash_number'] && `bKash: ${shop['payment.bkash_number']}`, shop['payment.nagad_number'] && `Nagad: ${shop['payment.nagad_number']}`].filter(Boolean).join(' · ')}</p>
            )}
          </footer>
        </article>
      )}
    </>
  );
}
