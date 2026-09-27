import { enterPreferredSpace } from '@aflow/web-product/ui/server';

import { localWebIdentity } from '@/compose/localWebIdentity';

/**
 * The front door.
 *
 * The composition states `entry: 'product'`, and the product's own entry is the
 * conversation — which this build carries, under a space. A front door has no
 * space of its own, so it enters the one this visitor last used, and asks the API
 * which spaces they can reach so a stale hint does not send them to a 404.
 */
export default async function Home() {
  return enterPreferredSpace('/chat', {
    apiUrl: process.env.API_URL || 'http://localhost:3000',
    headers: async (): Promise<Record<string, string> | null> => {
      const authorization = await localWebIdentity.authorizeUpstream({ anonymousOk: false });
      return authorization.kind === 'authorized' ? { Authorization: authorization.header } : null;
    },
  });
}
