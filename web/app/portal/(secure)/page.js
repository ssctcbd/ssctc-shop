'use client';

import Link from 'next/link';
import { METHOD_LABELS } from '@/components/Bill';
import { Notice } from '@/components/Form';
import { formatDate, formatMoney } from '@/lib/format';
import { useCustomer } from '@/lib/session';
import { useFetch } from '@/lib/useFetch';

const PORTAL = { loginPath: '/portal/login/' };
const ADVANCE_TYPES = { deposit: 'Deposit', sale_payment: 'Spent on a bill', payment_void: 'Returned to balance', return_credit: 'Credit for returned goods' };
const DAY_MS = 24 * 3600 * 1000;

/**
 * "1 Year", "6 months", "15 days" → when the warranty runs out, counted from
 * the purchase date. Returns null for wording it cannot read.
 */
function warrantyEnd(text, purchasedAt) {
  const match = /(\d+)\s*(day|week|month|year)/i.exec(text || '');
  if (!match) return null;
  const end = new Date(purchasedAt);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'day') end.setDate(end.getDate() + n);
  else if (unit === 'week') end.setDate(end.getDate() + n * 7);
  else if (unit === 'month') end.setMonth(end.getMonth() + n);
  else end.setFullYear(end.getFullYear() + n);
  return end;
}

function WarrantyStatus({ warranty, purchasedAt }) {
  if (!warranty) return <span className="muted">No warranty period recorded</span>;
  const end = warrantyEnd(warranty, purchasedAt);
  if (!end) return <span>{warranty}</span>;
  const daysLeft = Math.ceil((end.getTime() - Date.now()) / DAY_MS);
  return daysLeft > 0 ? (
    <span className="badge badge-ok">
      {warranty} · until {formatDate(end)} ({daysLeft} day{daysLeft === 1 ? '' : 's'} left)
    </span>
  ) : (
    <span className="badge badge-muted">
      {warranty} · ended {formatDate(end)}
    </span>
  );
}

function Section({ title, empty, count, children }) {
  return (
    <>
      <h2 className="section-title">{title}</h2>
      <div className="table-wrap">
        {count > 0 ? children : <div className="empty">{empty}</div>}
      </div>
    </>
  );
}

// Read-only: everything here is the customer's own record, as the shop holds it.
export default function PortalHomePage() {
  const customer = useCustomer();
  const invoices = useFetch('/portal/invoices', PORTAL).data?.invoices || [];
  const payments = useFetch('/portal/payments', PORTAL).data?.payments || [];
  const warranties = useFetch('/portal/warranties', PORTAL).data?.warranties || [];
  const advance = useFetch('/portal/advance', PORTAL).data?.movements || [];
  const hasDue = Number(customer.currentDue) > 0;
  const unpaid = invoices.filter((i) => i.status === 'completed' && Number(i.dueAmount) > 0);

  return (
    <>
      <div className="portal-hello">
        <h1>Hello, {customer.name}</h1>
        <p className="muted">{customer.phone}</p>
      </div>

      {customer.shouldChangePin && (
        <Notice kind="warning">
          You are using the PIN the shop gave you. <Link href="/portal/change-pin/">Choose your own PIN</Link> to keep your account private.
        </Notice>
      )}

      <div className="grid">
        <div className={`stat ${hasDue ? 'due' : 'ok'}`}>
          <span>Current due</span>
          <b>{formatMoney(customer.currentDue)}</b>
          {unpaid.length > 0 && (
            <small className="muted">
              on {unpaid.length} bill{unpaid.length === 1 ? '' : 's'}
            </small>
          )}
        </div>
        <div className="stat">
          <span>Advance balance</span>
          <b>{formatMoney(customer.advanceBalance)}</b>
        </div>
      </div>

      <Section title="Your bills" empty="No bills yet." count={invoices.length}>
        <table className="data">
          <thead>
            <tr>
              <th>Bill</th>
              <th className="num">Total</th>
              <th className="num">Due</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className={i.status === 'void' ? 'inactive' : ''}>
                <td>
                  <strong>{i.invoiceNo}</strong>
                  <span className="sub">
                    {formatDate(i.saleDate)}
                    {i.saleType === 'opening_due' ? ' · Earlier balance' : ''}
                    {i.status === 'void' ? ' · Cancelled' : ''}
                    {i.status === 'completed' && Number(i.unverifiedAmount) > 0 ? ` · ${formatMoney(i.unverifiedAmount)} payment being checked` : ''}
                  </span>
                </td>
                <td className="num">{formatMoney(i.totalAmount)}</td>
                <td className="num">{i.status === 'void' ? '—' : Number(i.dueAmount) > 0 ? <span className="qty-out">{formatMoney(i.dueAmount)}</span> : <span className="badge badge-ok">Paid</span>}</td>
                <td className="num">
                  {i.saleType === 'sale' && (
                    <Link className="btn btn-ghost btn-sm" href={`/portal/bill/?id=${i.id}`}>
                      View
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Payment receipts" empty="No confirmed payments yet." count={payments.length}>
        <table className="data">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Paid by</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.receiptNo}</strong>
                  <span className="sub">
                    {formatDate(p.paymentDate)} · for {p.invoices}
                  </span>
                </td>
                <td>
                  {METHOD_LABELS[p.method] || p.method}
                  {p.reference && <span className="sub">{p.reference}</span>}
                </td>
                <td className="num">{formatMoney(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Warranties" empty="No products with a warranty or serial number." count={warranties.length}>
        <table className="data">
          <thead>
            <tr>
              <th>Product</th>
              <th>Warranty</th>
            </tr>
          </thead>
          <tbody>
            {warranties.map((w) => (
              <tr key={w.id}>
                <td>
                  <strong>{w.name}</strong>
                  <span className="sub">
                    {w.serialNo ? `S/N ${w.serialNo} · ` : ''}
                    bought {formatDate(w.purchasedAt)} · {w.invoiceNo}
                  </span>
                </td>
                <td>
                  <WarrantyStatus warranty={w.warranty} purchasedAt={w.purchasedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {advance.length > 0 && (
        <Section title="Advance balance history" empty="" count={advance.length}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {advance.map((m) => (
                <tr key={m.id}>
                  <td className="nowrap">{formatDate(m.createdAt)}</td>
                  <td>
                    {ADVANCE_TYPES[m.type] || m.type}
                    {m.receiptNo && <span className="sub">{m.receiptNo}</span>}
                  </td>
                  <td className={`num ${Number(m.amount) > 0 ? 'qty-in' : 'qty-out'}`}>{Number(m.amount) > 0 ? `+ ${formatMoney(m.amount)}` : `− ${formatMoney(Math.abs(Number(m.amount)))}`}</td>
                  <td className="num">{formatMoney(m.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <p style={{ marginTop: 22 }}>
        <Link href="/portal/change-pin/">Change PIN</Link>
      </p>
    </>
  );
}
