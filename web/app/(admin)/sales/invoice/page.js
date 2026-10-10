'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Bill, { LAYOUTS } from '@/components/Bill';
import { Notice } from '@/components/Form';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useFetch } from '@/lib/useFetch';

/** "01712345678" -> "8801712345678", the form wa.me expects. */
const whatsappNumber = (phone) => (phone && /^01\d{9}$/.test(phone) ? `88${phone}` : null);

export default function InvoicePage() {
  const [params, setParams] = useState(null);
  const [layout, setLayout] = useState('a4');
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const id = search.get('id');
    setParams({ id: id && /^\d+$/.test(id) ? id : null, isNew: search.get('new') === '1' });
    setOrigin(window.location.origin);
    const saved = window.localStorage.getItem('ssctc.invoiceLayout');
    if (saved && LAYOUTS[saved]) setLayout(saved);
  }, []);

  const { data, error } = useFetch(params?.id ? `/sales/${params.id}` : null);
  const shop = useFetch('/settings/shop').data?.settings || {};
  const s = data?.sale;

  function chooseLayout(next) {
    setLayout(next);
    window.localStorage.setItem('ssctc.invoiceLayout', next);
  }

  if (params && !params.id) return <Notice>No sale was chosen. Open an invoice from the Sales list.</Notice>;

  // The QR code and the WhatsApp message carry a private link to this one bill.
  const billUrl = s && s.qrToken && origin ? `${origin}/portal/bill/?t=${s.qrToken}` : null;
  const wa = s && whatsappNumber(s.customerPhone);
  const shopName = shop['shop.name'] || 'SS Computer Training Centre';
  const message =
    s &&
    [
      shopName,
      `Invoice ${s.invoiceNo} · ${formatDateTime(s.saleDate)}`,
      ...s.items.map((i) => `${i.name} × ${i.quantity} = ${formatMoney(i.lineTotal)}`),
      `Total: ${formatMoney(s.totalAmount)}`,
      `Paid: ${formatMoney(s.paidAmount)}`,
      Number(s.dueAmount) > 0 ? `Due: ${formatMoney(s.dueAmount)}` : 'Fully paid. Thank you!',
      billUrl && `View your bill: ${billUrl}`,
    ]
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

      {s && <Bill sale={s} shop={shop} layout={layout} qrUrl={billUrl} />}
    </>
  );
}
