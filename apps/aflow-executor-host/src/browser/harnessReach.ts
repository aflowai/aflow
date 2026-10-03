/**
 * What an ephemeral profile reaches: no more than the harness driving it may
 * reach, plus the loopback ports the operator declared for that harness
 * (Plan 320 D6, D12).
 *
 * A confined harness is kept off loopback by its sandbox. Its browser is not
 * a way around that: the local edition's web application presents the
 * instance secret to whoever reaches its port, so a harness able to load it
 * could approve its own requests.
 */
import { isIP } from 'node:net';

// The sandbox's own matching, so the browser reaches a host exactly when the
// harness's sandbox would let the harness reach it.
import { matchesDomainPatternWithPort } from '@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js';
import {
  canonicalizeHost,
  isValidHost,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js';

import { isLocalName, type LocalAddressClassifier } from './addresses.js';

export interface HarnessReach {
  /** The harness profile's `allowedDomains`. */
  readonly allowedDomains: readonly string[];
  /** The harness profile's `browserLocalPorts`, admitted on loopback alone. */
  readonly localPorts: readonly number[];
}

/** Whether the harness's sandbox would let it reach `host:port`. */
export function harnessMayReach(host: string, port: number, reach: HarnessReach): boolean {
  if (!isValidHost(host)) return false;
  const canonical = canonicalizeHost(host) ?? host;
  return reach.allowedDomains.some((pattern) =>
    matchesDomainPatternWithPort(canonical, port, pattern),
  );
}

/**
 * The loopback address a declared local port is reached on, or nothing when
 * `host:port` is not one. Only a loopback name or a loopback address
 * qualifies — never an interface address the LAN also reaches, never
 * link-local, never a public name that resolves to loopback.
 */
export function declaredLoopback(
  host: string,
  port: number,
  reach: HarnessReach,
  classifier: LocalAddressClassifier,
): string | undefined {
  if (!reach.localPorts.includes(port)) return undefined;
  // A localhost name is loopback by definition (RFC 6761) and Chrome treats it
  // so; resolving it would let a hosts-file entry send it somewhere else.
  if (isLocalName(host)) return '127.0.0.1';
  return isIP(host) !== 0 && classifier.classify(host) === 'loopback' ? host : undefined;
}
