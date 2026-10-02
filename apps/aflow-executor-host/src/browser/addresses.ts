/**
 * Which addresses are this machine's own.
 *
 * A profile that keeps sign-ins must not reach a service on this machine: the
 * local edition's web application trusts whoever reaches its port, and its
 * Action Center is where an agent's requests are approved. Judged on the
 * address a name resolves to, never on how the name is spelled — loopback has
 * many spellings and a public name can resolve to it.
 */
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export type LocalAddressKind = 'loopback' | 'unspecified' | 'link-local' | 'this machine';

const RANGES: ReadonlyArray<{
  kind: LocalAddressKind;
  network: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}> = [
  { kind: 'loopback', network: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { kind: 'loopback', network: '::1', prefix: 128, family: 'ipv6' },
  { kind: 'unspecified', network: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { kind: 'unspecified', network: '::', prefix: 128, family: 'ipv6' },
  { kind: 'link-local', network: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { kind: 'link-local', network: 'fe80::', prefix: 10, family: 'ipv6' },
];

function blockListFamily(address: string): 'ipv4' | 'ipv6' | undefined {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : undefined;
}

/** Strips brackets and an IPv6 zone, which name the same address. */
export function bareAddress(address: string): string {
  return address.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
}

export function machineInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => bareAddress(entry.address));
}

export interface LocalAddressClassifier {
  /** Why the address is this machine's, or nothing when it is not. */
  classify(address: string): LocalAddressKind | undefined;
}

/**
 * How long one reading of this machine's interfaces stands. An address the
 * machine gains later — joining Wi-Fi, a VPN coming up — is refused from the
 * first decision made after this has passed.
 */
export const INTERFACE_ADDRESSES_TTL_MS = 5_000;

export interface LocalAddressClassifierOptions {
  readonly readInterfaces?: () => readonly string[];
  readonly now?: () => number;
}

/** Reads the machine's interfaces when a decision needs them, not when it is built. */
export function createLocalAddressClassifier(
  options: LocalAddressClassifierOptions = {},
): LocalAddressClassifier {
  const readInterfaces = options.readInterfaces ?? machineInterfaceAddresses;
  const now = options.now ?? Date.now;
  // One list per kind, so a refusal can say which it was. IPv4-mapped IPv6
  // addresses are checked against the IPv4 entries by the list itself.
  const ranges = new Map<LocalAddressKind, BlockList>();
  for (const range of RANGES) {
    const list = ranges.get(range.kind) ?? new BlockList();
    list.addSubnet(range.network, range.prefix, range.family);
    ranges.set(range.kind, list);
  }
  let interfaces: { readonly list: BlockList; readonly readAt: number } | undefined;
  const interfaceList = (): BlockList => {
    const at = now();
    if (interfaces !== undefined && at - interfaces.readAt < INTERFACE_ADDRESSES_TTL_MS) {
      return interfaces.list;
    }
    const list = new BlockList();
    for (const raw of readInterfaces()) {
      const address = bareAddress(raw);
      const family = blockListFamily(address);
      if (family !== undefined) list.addAddress(address, family);
    }
    interfaces = { list, readAt: at };
    return list;
  };
  return {
    classify: (raw) => {
      const address = bareAddress(raw);
      const family = blockListFamily(address);
      // Not an address at all: nothing to connect to, so nothing is allowed.
      if (family === undefined) return 'unspecified';
      for (const [kind, list] of ranges) {
        if (list.check(address, family)) return kind;
      }
      return interfaceList().check(address, family) ? 'this machine' : undefined;
    },
  };
}

/** This machine's addresses, as they are when each decision is made. */
export const machineAddresses: LocalAddressClassifier = createLocalAddressClassifier();

export function localAddressReason(host: string, address: string, kind: LocalAddressKind): string {
  const said = address === host ? `${host} is` : `${host} resolves to ${address},`;
  return `${said} ${kind === 'this machine' ? 'an address of this machine' : `a ${kind} address`}`;
}

/** Names that resolve to this machine by definition, before any lookup. */
export function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}
