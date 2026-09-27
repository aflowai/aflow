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

import type { RecoveryAction, SessionRecovery } from '@aflow/web-product';

/**
 * There is nobody to sign in as.
 *
 * A 401 here means the credential this process holds is wrong, not that a visitor
 * needs to authenticate — reaching this instance is the whole of the identity. So
 * recovery says what is actually wrong instead of sending an operator to a login
 * page that does not exist, and the notice offers no retry, because asking again
 * would only re-derive the same sentence.
 */
const localRecovery: SessionRecovery = {
  resolve: (): RecoveryAction => ({
    kind: 'message',
    message:
      'This instance could not authenticate to its own API. Check that the web process and the API share an instance secret.',
  }),
};

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
