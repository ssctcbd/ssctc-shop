'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

// The site root has no content of its own: staff go to the dashboard, everyone
// else to the staff login.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    api
      .get('/auth/me')
      .then(() => router.replace('/dashboard/'))
      .catch(() => router.replace('/login/'));
  }, [router]);

  return (
    <div className="center-screen">
      <div className="spinner" role="status" aria-label="Loading" />
    </div>
  );
}
