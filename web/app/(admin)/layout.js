'use client';

import StaffShell from '@/components/StaffShell';
import { StaffGate } from '@/lib/session';

// Every screen in the (admin) group is behind the staff login.
export default function AdminLayout({ children }) {
  return (
    <StaffGate>
      <StaffShell>{children}</StaffShell>
    </StaffGate>
  );
}
