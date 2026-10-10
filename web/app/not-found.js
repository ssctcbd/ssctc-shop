import Link from 'next/link';
import AuthShell from '@/components/AuthShell';

export default function NotFound() {
  return (
    <AuthShell title="Page not found" subtitle="This address does not exist in SSCTC Shop.">
      <Link href="/" className="btn btn-primary btn-block">
        Go to the start page
      </Link>
    </AuthShell>
  );
}
