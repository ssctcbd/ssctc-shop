'use client';

import Link from 'next/link';
import { useCan, useStaff } from '@/lib/session';
import { useFetch } from '@/lib/useFetch';

const MILESTONES = [
  ['Foundation: login, roles, database', 'Ready'],
  ['Products, services, inventory, suppliers, purchases', 'Ready'],
  ['Customers, POS, sales, returns, invoices with QR, customer portal', 'Ready'],
  ['Payments, dues, expenses, cash closing', 'Milestone 4'],
  ['Dashboard figures and reports', 'Milestone 5'],
];

// Sales, collection and due figures arrive with the modules that produce them
// (milestones 3–5). Low stock is live from Milestone 2.
export default function DashboardPage() {
  const user = useStaff();
  const can = useCan();
  const lowStock = useFetch(can('inventory.view') ? '/inventory/low-stock' : null);
  const lowCount = lowStock.data ? lowStock.data.products.length : null;

  return (
    <>
      <div className="page-head">
        <h1>Welcome, {user.name}</h1>
        <p>
          You are logged in as <span className="badge">{user.role.name}</span>
        </p>
      </div>

      <div className="grid">
        <div className="stat">
          <span>Today&apos;s sales</span>
          <b className="muted">—</b>
        </div>
        <div className="stat">
          <span>Collected today</span>
          <b className="muted">—</b>
        </div>
        <div className="stat">
          <span>Outstanding dues</span>
          <b className="muted">—</b>
        </div>
        <div className={`stat ${lowCount ? 'due' : ''}`}>
          <span>Low-stock products</span>
          <b className={lowCount === null ? 'muted' : ''}>{lowCount === null ? '—' : lowCount}</b>
          {lowCount > 0 && <Link href="/inventory/">See the list</Link>}
        </div>
      </div>

      <div className="card">
        <h2>System status</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          Figures above fill in as each module is built.
        </p>
        <ul className="checklist">
          {MILESTONES.map(([label, status]) => (
            <li key={label}>
              <span>{label}</span>
              <span className={status === 'Ready' ? 'badge' : 'muted'}>{status}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
