'use client';

import Link from 'next/link';
import { Notice } from '@/components/Form';
import { formatMoney } from '@/lib/format';
import { useCustomer } from '@/lib/session';

// Milestone 1: balances only. Bills, payments and warranties are listed here
// once sales and payments exist (milestones 3 and 4).
export default function PortalHomePage() {
  const customer = useCustomer();
  const hasDue = Number(customer.currentDue) > 0;

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
        </div>
        <div className="stat">
          <span>Advance balance</span>
          <b>{formatMoney(customer.advanceBalance)}</b>
        </div>
      </div>

      <div className="card">
        <h2>Your bills and payments</h2>
        <p className="muted">Your invoices, payment receipts and product warranties will appear here.</p>
      </div>

      <p style={{ marginTop: 18 }}>
        <Link href="/portal/change-pin/">Change PIN</Link>
      </p>
    </>
  );
}
