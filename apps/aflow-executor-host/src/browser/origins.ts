/**
 * A profile that keeps sign-ins does not reach services on this machine.
 *
 * The local edition's web application presents the instance secret to
 * whoever reaches its port, so a page loaded from it is the owner's Action
 * Center: an agent able to drive it could approve its own requests. The
 * egress proxy is what enforces this, on every connection. The check here is
 * only on the address asked for, so an obviously local one is refused before
 * a browser is started or touched for it.
 */
import { isIP } from 'node:net';

import {
  bareAddress,
  isLocalName,
  localAddressReason,
  type LocalAddressClassifier,
} from './addresses.js';

/** Why the address asked for is plainly this machine, or nothing when its name has to be resolved to tell. */
export function obviouslyLocalDestination(
  url: URL,
  classifier: LocalAddressClassifier,
): string | undefined {
  const host = bareAddress(url.hostname.toLowerCase().replace(/\.$/, ''));
  if (isLocalName(host)) return `${host} names this machine`;
  if (isIP(host) === 0) return undefined;
  const kind = classifier.classify(host);
  return kind === undefined ? undefined : localAddressReason(host, host, kind);
}

export function localDestinationRefusal(
  profileId: string,
  reason: string,
  when: 'asked' | 'connecting',
): string {
  return (
    `Browser profile \`${profileId}\` keeps sign-ins, so it does not reach services on this ` +
    `machine: ${reason}. ` +
    (when === 'asked'
      ? 'Nothing was opened.'
      : 'The connection was refused, so the page did not load there.')
  );
}
