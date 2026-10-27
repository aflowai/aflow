import { LocalProviders } from '@/components/local-providers';
import { DashboardShell, QuickStartOffer } from '@aflow/web-product/ui';

// The product's own shell, with nothing wrapped around it: this edition has no
// account to admit and no terms to accept before the product is reachable. Its
// first run starts with one space already made, so the quick-start offer that
// shows each template beside that empty space is this edition's to mount.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LocalProviders>
      <DashboardShell>
        <QuickStartOffer />
        {children}
      </DashboardShell>
    </LocalProviders>
  );
}
