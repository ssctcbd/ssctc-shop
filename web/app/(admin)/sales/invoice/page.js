'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Logo from '@/components/Logo';
import { Notice } from '@/components/Form';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

const METHODS = { cash: 'Cash', bkash: 'bKash', nagad: 'Nagad', bank_transfer: 'Bank transfer', other: 'Other' };
// Paper choices. The @page rule is what tells the printer driver the roll width.
const LAYOUTS = {
  a4: { label: 'A4 page', page: 'A4', margin: '14mm' },
  thermal80: { label: 'Thermal 80mm', page: '80mm auto', margin: '3mm' },
  thermal58: { label: 'Thermal 58mm', page: '58mm auto', margin: '2mm' },
};

/** "01712345678" -> "8801712345678", the form wa.me expects. */
const whatsappNumber = (phone) => (phone && /^01\d{9}$/.test(phone) ? `88${phone}` : null);

export default function InvoicePage() {
  const [params, setParams] = useState(null);
  const [layout, setLayout] = useState('a4');

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const id = search.get('id');
    setParams({ id: id && /^\d+$/.test(id) ? id : null, isNew: search.get('new') === '1' });
    const saved = window.localStorage.getItem('ssctc.invoiceLayout');
    if (saved && LAYOUTS[saved]) setLayout(saved);
  }, []);

  const { data, error } = useFetch(params?.id ? `/sales/${params.id}` : null);
  const settings = useFetch('/settings/shop').data?.settings || {};
  const s = data?.sale;

  function chooseLayout(next) {
    setLayout(next);
    window.localStorage.setItem('ssctc.invoiceLayout', next);
  }

  if (params && !params.id) return <Notice>No sale was chosen. Open an invoice from the Sales list.</Notice>;

  const thermal = layout !== 'a4';
  const payments = s ? s.payments.filter((p) => p.status === 'active') : [];
  const wa = s && whatsappNumber(s.customerPhone);
  const shopName = settings['shop.name'] || 'SS Computer Training Centre';
  const message =
    s &&
    [`${shopName}`, `Invoice ${s.invoiceNo} · ${formatDateTime(s.saleDate)}`, ...s.items.map((i) => `${i.name} × ${i.quantity} = ${formatMoney(i.lineTotal)}`), `Total: ${formatMoney(s.totalAmount)}`, `Paid: ${formatMoney(s.paidAmount)}`, Number(s.dueAmount) > 0 ? `Due: ${formatMoney(s.dueAmount)}` : 'Fully paid. Thank you!']
      .filter(Boolean)
      .join('\n');

  return (
    <>
      <style>{`@page { size: ${LAYOUTS[layout].page}; margin: ${LAYOUTS[layout].margin}; }`}</style>

      <div className="page-head with-actions no-print">
        <div>
          <h1>Invoice{s ? ` ${s.invoiceNo}` : ''}</h1>
          <p>
            <Link href="/sales/">Sales</Link> · <Link href="/pos/">New sale</Link>
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
          {wa && (
            <a className="btn btn-ghost" href={`https://wa.me/${wa}?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
              Share to WhatsApp
            </a>
          )}
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!s}>
            Print
          </button>
        </div>
      </div>

      <div className="no-print">
        <Notice>{error?.message}</Notice>
        {params?.isNew && s && <Notice kind="success">Sale {s.invoiceNo} saved.</Notice>}
      </div>

      {s && (
        <article className={`invoice ${thermal ? `invoice-thermal invoice-${layout}` : 'invoice-a4'}`}>
          {s.status === 'void' && <div className="invoice-void">VOID</div>}
          <header className="invoice-head">
            {!thermal && <Logo height={56} />}
            <div>
              <strong className="invoice-shop">{shopName}</strong>
              {settings['shop.tagline'] && <span>{settings['shop.tagline']}</span>}
              {settings['shop.address'] && <span>{settings['shop.address']}</span>}
              {settings['shop.phone'] && <span>Phone: {settings['shop.phone']}</span>}
            </div>
          </header>

          <div className="invoice-meta">
            <div>
              <span>Invoice</span>
              <strong>{s.invoiceNo}</strong>
            </div>
            <div>
              <span>Date</span>
              {formatDateTime(s.saleDate)}
            </div>
            <div>
              <span>Customer</span>
              {s.customerName || 'Walk-in'}
              {s.customerPhone ? ` · ${s.customerPhone}` : ''}
            </div>
          </div>

          <table className="invoice-items">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {s.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.name}
                    {(i.warranty || i.serialNo) && <small>{[i.warranty && `Warranty: ${i.warranty}`, i.serialNo && `S/N: ${i.serialNo}`].filter(Boolean).join(' · ')}</small>}
                  </td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{Number(i.unitPrice).toFixed(2)}</td>
                  <td className="num">{Number(i.lineTotal).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="invoice-totals">
            <div>
              <span>Subtotal</span>
              <span>{formatMoney(s.subtotal)}</span>
            </div>
            {Number(s.discountAmount) > 0 && (
              <div>
                <span>Discount</span>
                <span>− {formatMoney(s.discountAmount)}</span>
              </div>
            )}
            <div className="invoice-total">
              <span>Total</span>
              <span>{formatMoney(s.totalAmount)}</span>
            </div>
            {payments.map((p) => (
              <div key={p.id}>
                <span>
                  {METHODS[p.method]}
                  {p.reference ? ` (${p.reference})` : ''}
                  {p.isVerified ? '' : ' — not yet verified'}
                </span>
                <span>{formatMoney(p.amount)}</span>
              </div>
            ))}
            <div className="invoice-total">
              <span>Due</span>
              <span>{s.status === 'void' ? '—' : formatMoney(s.dueAmount)}</span>
            </div>
          </div>

          <footer className="invoice-foot">
            {(settings['payment.bkash_number'] || settings['payment.nagad_number']) && (
              <p>
                {settings['payment.bkash_number'] && `bKash: ${settings['payment.bkash_number']}`}
                {settings['payment.bkash_number'] && settings['payment.nagad_number'] && ' · '}
                {settings['payment.nagad_number'] && `Nagad: ${settings['payment.nagad_number']}`}
              </p>
            )}
            <p>{settings['invoice.footer']}</p>
            <p className="invoice-by">Served by {s.createdByName}</p>
          </footer>
        </article>
      )}
    </>
  );
}
