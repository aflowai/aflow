/**
 * Which proxy refusal, if any, explains a navigation.
 *
 * One proxy serves every run and every space using a profile, so its log
 * holds refusals made for other pages — another run's, or a tracker this
 * page loads. A refusal is laid on a navigation only when it names a host
 * that navigation's own main frame asked for: the address given, or a hop of
 * its redirect chain as the engine reports it.
 */
import { type BrowserProfile, normalizeBrowserHost } from '@aflow/schemas';

import type { EgressProxy, ProxyRefusal } from './egressProxy.js';
import { BrowserDriverError, errorText } from './errors.js';
import { localDestinationRefusal, reachRefusal } from './origins.js';
import { EngineNavigationFailed } from './types.js';

export function urlOrNothing(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function hostOf(url: URL): string {
  return normalizeBrowserHost(url.hostname);
}

export function refusalError(profile: BrowserProfile, refusal: ProxyRefusal): BrowserDriverError {
  if (refusal.kind === 'local') {
    return new BrowserDriverError(
      'appliance_origin',
      localDestinationRefusal(profile.id, refusal.reason, 'connecting'),
      { host: refusal.host },
    );
  }
  if (refusal.kind === 'reach') {
    return new BrowserDriverError(
      'origin_denied',
      reachRefusal(profile.id, refusal.reason, 'connecting'),
      { host: refusal.host },
    );
  }
  return new BrowserDriverError(
    'origin_denied',
    `Browser profile \`${profile.id}\` does not connect to ${refusal.host}: ${refusal.reason}. ` +
      'Rules are set on the machine.',
    { host: refusal.host },
  );
}

function portOf(url: URL): number {
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

/**
 * The refusal of the host and port a page landed on — Chrome shows a
 * plain-http refusal as a page. The port too: a page on a local port opened
 * to the profile is not refused by its own request to another port refused.
 */
export function landedRefusal(
  proxy: EgressProxy,
  landed: URL,
  since: number,
): ProxyRefusal | undefined {
  return proxy
    .refusalsSince(since)
    .find((refusal) => refusal.host === hostOf(landed) && refusal.port === portOf(landed));
}

export function navigationFailure(
  proxy: EgressProxy,
  profile: BrowserProfile,
  asked: URL | undefined,
  since: number,
  what: string,
  error: unknown,
): BrowserDriverError {
  const chain = error instanceof EngineNavigationFailed ? error.redirectChain : [];
  const hosts = [asked, ...chain.map(urlOrNothing)]
    .filter((url): url is URL => url !== undefined)
    .map(hostOf);
  const refusals = proxy.refusalsSince(since);
  // Latest hop first: a refused hop ends the chain, so it is the one that stopped this navigation.
  for (const host of hosts.reverse()) {
    const refused = refusals.find((refusal) => refusal.host === host);
    if (refused !== undefined) return refusalError(profile, refused);
  }
  return new BrowserDriverError('navigation_failed', `${what}: ${errorText(error)}`);
}
