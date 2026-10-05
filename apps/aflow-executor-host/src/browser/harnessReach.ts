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
// The sandbox's own matching, so the browser reaches a host exactly when the
// harness's sandbox would let the harness reach it.
import { matchesDomainPatternWithPort } from '@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js';
import {
  canonicalizeHost,
  isValidHost,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js';

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
