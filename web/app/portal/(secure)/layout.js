'use client';

import Link from 'next/link';
import Logo from '@/components/Logo';
import { api } from '@/lib/api';
import { CustomerGate } from '@/lib/session';

// Customer portal screens. Read-only: customers see their own records and can
// change their PIN, nothing else.
export default function PortalLayout({ children }) {
  async function logout() {
    try {
      await api.post('/portal/logout');
    } finally {
      window.location.assign('/portal/login/');
    }
  }

  return (
    <CustomerGate>
      <div className="portal">
        <header className="portal-bar">
          <Link href="/portal/" aria-label="Portal home">
            <Logo height={34} />
          </Link>
          <button className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </header>
        <main className="portal-main">{children}</main>
      </div>
    </CustomerGate>
  );
}
