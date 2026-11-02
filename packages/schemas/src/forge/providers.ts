/**
 * The vocabulary's ninth act (Plan 340 D1): name the provider for a folder
 * from the host its repo coordinate keeps.
 */
import { DEFAULT_REPO_HOST } from '../models/repoCoordinate.js';
import { GITHUB_FORGE_HOSTS } from './github.js';
import type { ForgeProviderId } from './vocabulary.js';

const PROVIDER_HOSTS: Readonly<Record<ForgeProviderId, readonly string[]>> = {
  github: GITHUB_FORGE_HOSTS,
};

/**
 * The provider that answers the vocabulary for a repository on `host`, or null
 * where no provider does. The host is a repo coordinate's, matched without
 * regard to case. With no host given, the coordinate's own default stands.
 */
export function forgeProviderForHost(host: string = DEFAULT_REPO_HOST): ForgeProviderId | null {
  const wanted = host.trim().toLowerCase();
  for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
    if (hosts.includes(wanted)) return provider as ForgeProviderId;
  }
  return null;
}

/** {@link forgeProviderForHost}, throwing where no provider answers for the host. */
export function requireForgeProvider(host: string = DEFAULT_REPO_HOST): ForgeProviderId {
  const provider = forgeProviderForHost(host);
  if (provider === null) {
    throw new Error(`No forge provider answers for repositories on ${host}.`);
  }
  return provider;
}
