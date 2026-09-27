import { LocalProviders } from '@/components/local-providers';
import { DashboardShell } from '@aflow/web-product/ui';

// The product's own shell, with nothing wrapped around it: this edition has no
// account to admit and no terms to accept before the product is reachable.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LocalProviders>
      <DashboardShell>{children}</DashboardShell>
    </LocalProviders>
  );
}
