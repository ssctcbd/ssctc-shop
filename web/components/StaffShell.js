'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Logo from './Logo';
import { api } from '@/lib/api';
import { useStaff } from '@/lib/session';

// The full module list from PROJECT_PLAN.md §4. An entry without `href` is not
// built yet and shows the milestone it arrives in. `permission` hides entries
// the user's role cannot use (the API enforces the same rule).
const NAV = [
  { group: 'Overview', items: [{ label: 'Dashboard', href: '/dashboard/', permission: 'dashboard.view' }] },
  {
    group: 'Selling',
    items: [
      { label: 'POS / New sale', href: '/pos/', permission: 'sales.create' },
      { label: 'Sales', href: '/sales/', permission: 'sales.view' },
      { label: 'Customers', href: '/customers/', permission: 'customers.view' },
      { label: 'Dues', href: '/dues/', permission: 'customers.view' },
      { label: 'Payments', href: '/payments/', permission: 'payments.view' },
    ],
  },
  {
    group: 'Stock',
    items: [
      { label: 'Products', href: '/products/', permission: 'catalog.view' },
      { label: 'Categories', href: '/categories/', permission: 'catalog.view' },
      { label: 'Services', href: '/services/', permission: 'catalog.view' },
      { label: 'Inventory', href: '/inventory/', permission: 'inventory.view' },
      { label: 'Suppliers', href: '/suppliers/', permission: 'suppliers.view' },
      { label: 'Purchases', href: '/purchases/', permission: 'suppliers.view' },
    ],
  },
  {
    group: 'Money',
    items: [
      { label: 'Expenses', href: '/expenses/', permission: 'expenses.view' },
      { label: 'Cash', href: '/cash/', permission: 'cash.view' },
      { label: 'Commission', href: '/commission/', permission: 'commission.manage' },
      { label: 'My commission', href: '/commission/', permission: 'commission.view_own' },
      { label: 'Reports', href: '/reports/', permission: 'reports.view' },
    ],
  },
  {
    group: 'System',
    items: [
      { label: 'Users', href: '/users/', permission: 'users.manage' },
      { label: 'Settings', href: '/settings/', permission: 'settings.manage' },
      { label: 'Audit log', href: '/audit/', permission: 'audit.view' },
      { label: 'Backup & health', href: '/system/', permission: 'system.backup' },
    ],
  },
];

export default function StaffShell({ children }) {
  const user = useStaff();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  // A user given a password by the Owner must replace it before doing anything else.
  const mustChange = user.mustChangePassword && !pathname.startsWith('/account');
  useEffect(() => {
    if (mustChange) router.replace('/account/');
  }, [mustChange, router]);

  useEffect(() => setMenuOpen(false), [pathname]);

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      // A full page load, so nothing from this session stays in memory.
      window.location.assign('/login/');
    }
  }

  const can = (permission) => user.permissions.includes(permission);

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <aside className="sidebar" aria-label="Main menu">
        <div className="sidebar-brand">
          <Logo height={52} />
          <span>Shop management</span>
        </div>
        <nav className="nav">
          {NAV.map(({ group, items }) => {
            const visible = items.filter((item) => can(item.permission));
            if (visible.length === 0) return null;
            return (
              <div key={group}>
                <div className="nav-group">{group}</div>
                {visible.map((item) =>
                  item.href ? (
                    <Link key={item.label} href={item.href} className={`nav-item${pathname.startsWith(item.href.replace(/\/$/, '')) ? ' active' : ''}`}>
                      {item.label}
                    </Link>
                  ) : (
                    <div key={item.label} className="nav-item soon" title={`Arrives in milestone ${item.milestone}`}>
                      {item.label}
                      <small>M{item.milestone}</small>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <strong>{user.name}</strong>
          <small>
            {user.role.name} · {user.username}
          </small>
          <div className="actions">
            <Link href="/account/">Password</Link>
            <button className="link" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </aside>

      <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />

      <div>
        <header className="topbar">
          <Logo height={32} />
          <button className="menu-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            Menu
          </button>
        </header>
        <main className="content">{mustChange ? null : children}</main>
      </div>
    </div>
  );
}
