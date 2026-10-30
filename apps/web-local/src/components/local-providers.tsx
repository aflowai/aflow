'use client';

/**
 * What this instance composes the product's providers with.
 *
 * A client component because the recovery policy is an object with a method, and
 * a server layout cannot hand one across that boundary — only serialisable values
 * cross it. So the application states its policy here and the layout stays a
 * layout.
 */
import { Providers } from '@aflow/web-product/ui';

import { localRecovery } from '@/compose/localRecovery';

/**
 * The tenant is the server's to know.
 *
 * A local instance has exactly one and pins it; the browser states none, which is
 * what the API expects of any caller — it resolves the tenant from the request
 * rather than believing a header.
 */
export function LocalProviders({ children }: { children: React.ReactNode }) {
  return (
    <Providers recovery={localRecovery} tenantId={null}>
      {children}
    </Providers>
  );
}
