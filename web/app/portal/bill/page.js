'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Bill from '@/components/Bill';
import Logo from '@/components/Logo';
import { Notice } from '@/components/Form';
import { useFetch } from '@/lib/useFetch';

// One bill, for the customer. Reached two ways:
//   /portal/bill/?t=<token>  the QR code on a printed invoice — no login needed
//   /portal/bill/?id=<id>    from the logged-in portal — the API checks it is theirs
// This page sits outside the logged-in portal area because a scanned code must
// open without a session. What it shows is decided entirely by the API.
export default function PortalBillPage() {
  const [source, setSource] = useState(null);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const token = search.get('t');
    const id = search.get('id');
    if (token && /^[0-9a-f]{32}$/.test(token)) setSource({ path: `/portal/view/${token}`, byToken: true });
    else if (id && /^\d+$/.test(id)) setSource({ path: `/portal/invoices/${id}`, byToken: false });
    else setSource({ path: null });
  }, []);

  const { data, error } = useFetch(source?.path || null, { loginPath: '/portal/login/' });
  const shop = useFetch('/portal/shop').data?.shop || {};
  const bill = data?.bill;

  return (
    <div className="portal">
      <header className="portal-bar no-print">
        <Logo height={34} />
        <div className="page-actions">
          {bill && (
            <button className="btn btn-ghost" onClick={() => window.print()}>
              Print
            </button>
          )}
          <Link className="btn btn-ghost" href={source?.byToken ? '/portal/login/' : '/portal/'}>
            {source?.byToken ? 'Log in to see all your bills' : 'Back'}
          </Link>
        </div>
      </header>
      <main className="portal-main portal-bill">
        {source && !source.path && <Notice>This bill link is not valid. Scan the code on your invoice again, or log in.</Notice>}
        <Notice>{error && (error.status === 404 ? 'This bill could not be found. Scan the code on your invoice again, or log in.' : error.message)}</Notice>
        {bill && <Bill sale={bill} shop={shop} layout="a4" />}
      </main>
    </div>
  );
}
