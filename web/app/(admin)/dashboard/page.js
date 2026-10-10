'use client';

import { useStaff } from '@/lib/session';

const MILESTONES = [
  ['Foundation: login, roles, database', 'Ready'],
  ['Products, services, inventory, suppliers', 'Milestone 2'],
  ['Customers, POS and sales', 'Milestone 3'],
  ['Payments, dues, expenses, cash closing', 'Milestone 4'],
  ['Dashboard figures and reports', 'Milestone 5'],
];

// Milestone 1 placeholder. The real figures (today's sales, dues, low stock,
// cash drawer) arrive with the modules that produce them.
export default function DashboardPage() {
  const user = useStaff();

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
        <div className="stat">
          <span>Low-stock products</span>
          <b className="muted">—</b>
        </div>
      </div>

      <div className="card">
        <h2>System status</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          The foundation is in place. Figures above fill in as each module is built.
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
