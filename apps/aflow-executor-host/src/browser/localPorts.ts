/**
 * The loopback ports a browser reaches on this machine (Plan 320 D12): those
 * the operator declared for a harness's ephemeral profile, or opened for a
 * profile the machine declares. Only loopback qualifies — never an interface
 * address the LAN also reaches, never link-local or unspecified — and a
 * declared profile is never opened to a port this stack serves on, whatever
 * its policy says: the local web application has no login, so a page from it
 * could approve the agent's own requests.
 */
import { isIP } from 'node:net';

import { describeStackPortOwner, type StackPortOwner, stackOwnPorts } from '@aflow/lib';
import { type BrowserProfile, browserStackPortReason } from '@aflow/schemas';

import { isLocalName, type LocalAddressClassifier } from './addresses.js';

/**
 * A localhost name on an open port is tried on IPv4 loopback, then IPv6: a
 * dev server may listen on either alone, as Vite does on `::1` on macOS.
 */
export const LOCALHOST_ADDRESSES: readonly [string, ...string[]] = ['127.0.0.1', '::1'];

/**
 * The loopback addresses `host:port` is reached on, in the order they are
 * tried, when `port` is among `ports` and `host` is a localhost name or a
 * loopback address; nothing otherwise.
 */
export function loopbackOnPort(
  host: string,
  port: number,
  ports: readonly number[],
  classifier: LocalAddressClassifier,
): readonly [string, ...string[]] | undefined {
  if (!ports.includes(port)) return undefined;
  // A localhost name is loopback by definition (RFC 6761) and Chrome treats it
  // so; resolving it would let a hosts-file entry send it somewhere else.
  if (isLocalName(host)) return LOCALHOST_ADDRESSES;
  return isIP(host) !== 0 && classifier.classify(host) === 'loopback' ? [host] : undefined;
}

export type StackOwnPorts = ReadonlyMap<number, StackPortOwner>;

/** This executor's reading of the ports the stack serves on, from its own environment. */
export function executorStackPorts(): StackOwnPorts {
  return stackOwnPorts(process.env);
}

/** What a declared profile's proxy admits on loopback. */
export interface ProfileLocalPorts {
  /** Read at each decision, so a port opened or closed holds for a running browser at once. */
  readonly opened: () => readonly number[];
  readonly stackOwn: StackOwnPorts;
}

/** Why `port` is never opened to a profile, or nothing when it is not this stack's. */
export function stackPortReason(port: number, stackOwn: StackOwnPorts): string | undefined {
  const owner = stackOwn.get(port);
  return owner === undefined
    ? undefined
    : browserStackPortReason(port, describeStackPortOwner(owner));
}

/** The ports a profile is opened to in fact: those it lists that are not this stack's. */
export function openLocalPorts(
  profile: Pick<BrowserProfile, 'localPorts'>,
  stackOwn: StackOwnPorts,
): number[] {
  return profile.localPorts.filter((port) => !stackOwn.has(port));
}
