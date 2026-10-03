/**
 * The egress proxy every profile's browser sends all its traffic through
 * (Plan 320 D12).
 *
 * The refusal is made here, at the connection, rather than on the page's
 * address: it then holds for a redirect, a page that navigates itself after
 * load, a subresource, a WebSocket, and a public name that resolves to this
 * machine. Each destination is resolved here, every address it resolves to is
 * checked, and the connection goes to the address that was checked — never to
 * the name, which could resolve differently a moment later.
 *
 * No profile reaches this machine. An ephemeral profile's proxy also admits
 * nothing beyond its harness's reach, with the loopback ports declared for
 * that harness as the one exception to both.
 *
 * One per running profile, bound to loopback on a port the system picks, and
 * stopped with the profile's browser.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  bareAddress,
  isLocalName,
  localAddressReason,
  type LocalAddressClassifier,
  machineAddresses,
} from './addresses.js';
import { declaredLoopback, harnessMayReach, type HarnessReach } from './harnessReach.js';

/**
 * `local`: this machine's own address. `rule`: an origin rule the operator
 * set. `reach`: beyond what an ephemeral profile's harness may reach.
 */
export type RefusalKind = 'local' | 'rule' | 'reach';

export interface ProxyRefusal {
  readonly host: string;
  readonly port: number;
  readonly kind: RefusalKind;
  readonly reason: string;
  readonly at: number;
}

export interface ResolvedAddress {
  readonly address: string;
}

/** What a profile's proxy admits. */
export interface EgressPolicy {
  /** Why the operator's rules refuse connections to this host, or nothing when they do not. */
  readonly refuseHost?: (host: string) => string | undefined;
  /** An ephemeral profile's: its harness's reach. Absent for a profile the machine declares. */
  readonly reach?: HarnessReach;
}

export interface EgressProxyOptions extends EgressPolicy {
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** Opens the upstream connection to an address already checked. */
  readonly connect?: (address: string, port: number) => Socket;
  readonly classifier?: LocalAddressClassifier;
  readonly now?: () => number;
}

export type EgressDecision =
  /** `addresses` are tried in order; the first that accepts is the one connected to. */
  | { readonly verdict: 'connect'; readonly addresses: readonly [string, ...string[]] }
  | { readonly verdict: 'refuse'; readonly kind: RefusalKind; readonly reason: string }
  | { readonly verdict: 'unreachable'; readonly reason: string };

/** A host as a URL or a CONNECT authority carries it, in the form every check compares. */
export function egressHost(raw: string): string {
  return bareAddress(raw.toLowerCase().replace(/\.$/, ''));
}

/**
 * What the name alone decides, or nothing when it has to be resolved and the
 * addresses given to `decideResolved`. `host` is as `egressHost` returns it.
 */
export function decideByName(
  host: string,
  port: number,
  policy: EgressPolicy,
  classifier: LocalAddressClassifier,
): EgressDecision | undefined {
  const ruled = policy.refuseHost?.(host);
  if (ruled !== undefined) return { verdict: 'refuse', kind: 'rule', reason: ruled };
  const { reach } = policy;
  if (reach !== undefined) {
    const loopback = declaredLoopback(host, port, reach, classifier);
    if (loopback !== undefined) return { verdict: 'connect', addresses: loopback };
  }
  if (isLocalName(host)) {
    return { verdict: 'refuse', kind: 'local', reason: `${host} names this machine` };
  }
  const literal = isIP(host) !== 0;
  if (literal) {
    const kind = classifier.classify(host);
    if (kind !== undefined) {
      return { verdict: 'refuse', kind: 'local', reason: localAddressReason(host, host, kind) };
    }
  }
  if (reach !== undefined && !harnessMayReach(host, port, reach)) {
    return {
      verdict: 'refuse',
      kind: 'reach',
      reason: `${host}:${String(port)} is not among the hosts its harness may reach`,
    };
  }
  return literal ? { verdict: 'connect', addresses: [host] } : undefined;
}

/** The decision on a name `decideByName` left open, from every address it resolved to. */
export function decideResolved(
  host: string,
  addresses: readonly ResolvedAddress[],
  classifier: LocalAddressClassifier,
): EgressDecision {
  // Every address, not the first: a name answering with a public address and
  // a loopback one is a name that can reach this machine.
  for (const { address } of addresses) {
    const kind = classifier.classify(address);
    if (kind === undefined) continue;
    return { verdict: 'refuse', kind: 'local', reason: localAddressReason(host, address, kind) };
  }
  const first = addresses[0];
  if (first === undefined) return { verdict: 'unreachable', reason: `${host} did not resolve` };
  return { verdict: 'connect', addresses: [first.address] };
}

/** Whether, and where, a connection to `rawHost:port` goes. */
export async function decideEgress(
  rawHost: string,
  port: number,
  policy: EgressPolicy,
  deps: {
    readonly lookup: (host: string) => Promise<readonly ResolvedAddress[]>;
    readonly classifier: LocalAddressClassifier;
  },
): Promise<EgressDecision> {
  const host = egressHost(rawHost);
  const byName = decideByName(host, port, policy, deps.classifier);
  if (byName !== undefined) return byName;
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await deps.lookup(host);
  } catch (error) {
    return {
      verdict: 'unreachable',
      reason: `${host} did not resolve: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return decideResolved(host, addresses, deps.classifier);
}

export interface EgressProxy {
  readonly port: number;
  /** What Chrome's `--proxy-server` names. */
  readonly server: string;
  refusalsSince(sinceMs: number): readonly ProxyRefusal[];
  stop(): Promise<void>;
}

export type StartEgressProxy = (options: EgressProxyOptions) => Promise<EgressProxy>;

/** Refusals remembered, for an operation to say why its navigation failed. */
const REFUSALS_KEPT = 200;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type Decision =
  | { readonly verdict: 'connect'; readonly addresses: readonly [string, ...string[]] }
  | { readonly verdict: 'refuse'; readonly refusal: ProxyRefusal }
  | { readonly verdict: 'unreachable'; readonly reason: string };

/** What the browser's request is answered with when the proxy refuses it. */
function proxyRefusalText(refusal: ProxyRefusal, ephemeral: boolean): string {
  return (
    `Refused by this profile's egress proxy: ${refusal.reason}. ` +
    (ephemeral
      ? 'An ephemeral profile reaches only what its harness may reach, and on this machine only ' +
        'the loopback ports the operator declared for that harness.'
      : "A profile that keeps sign-ins does not reach services on this machine, or origins the operator's rules deny.")
  );
}

async function defaultLookup(host: string): Promise<readonly ResolvedAddress[]> {
  return await dnsLookup(host, { all: true, verbatim: true });
}

/** `host:port` as CONNECT carries it, IPv6 in brackets. */
export function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { host: match[1] ?? '', port };
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

function rawWithoutHopByHop(raw: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? '';
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    kept.push(name, raw[i + 1] ?? '');
  }
  return kept;
}

export const startEgressProxy: StartEgressProxy = async (options) => {
  const lookup = options.lookup ?? defaultLookup;
  const connect = options.connect ?? ((address, port) => netConnect({ host: address, port }));
  const classifier = options.classifier ?? machineAddresses;
  const now = options.now ?? Date.now;
  const refusals: ProxyRefusal[] = [];
  const open = new Set<Duplex>();

  const decide = async (rawHost: string, port: number): Promise<Decision> => {
    const decision = await decideEgress(rawHost, port, options, { lookup, classifier });
    if (decision.verdict !== 'refuse') return decision;
    const refusal: ProxyRefusal = {
      host: egressHost(rawHost),
      port,
      kind: decision.kind,
      reason: decision.reason,
      at: now(),
    };
    refusals.push(refusal);
    if (refusals.length > REFUSALS_KEPT) refusals.shift();
    return { verdict: 'refuse', refusal };
  };

  const refusalText = (refusal: ProxyRefusal): string =>
    proxyRefusalText(refusal, options.reach !== undefined);

  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.once('close', () => {
      open.delete(socket);
    });
  };

  /** The first of `addresses` that accepts a connection on `port`, tried in order. */
  const connectFirst = async (
    addresses: readonly [string, ...string[]],
    port: number,
  ): Promise<Socket> => {
    let refusal = new Error(`Nothing accepted a connection on port ${String(port)}.`);
    for (const address of addresses) {
      const socket = connect(address, port);
      track(socket);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => {
            socket.off('error', reject);
            resolve();
          });
          socket.once('error', reject);
        });
        return socket;
      } catch (error) {
        socket.destroy();
        refusal = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw refusal;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    track(req.socket);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('A proxy request names an absolute http address.\n');
      return;
    }
    if (target.protocol !== 'http:') {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('Only http is forwarded in the clear; https goes through CONNECT.\n');
      return;
    }
    const port = target.port === '' ? 80 : Number(target.port);
    void decide(target.hostname, port).then((decision) => {
      if (decision.verdict === 'refuse') {
        res
          .writeHead(403, { 'content-type': 'text/plain' })
          .end(`${refusalText(decision.refusal)}\n`);
        return;
      }
      if (decision.verdict === 'unreachable') {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`${decision.reason}\n`);
        return;
      }
      void connectFirst(decision.addresses, port).then(
        (socket) => {
          // No `agent` at all: given one — even `false`, which makes a fresh
          // default agent — Node ignores `createConnection` and connects to the
          // request's own host and port. Without one it writes this request on
          // the socket returned here, once, with `Connection: close`.
          const upstream = httpRequest(
            {
              method: req.method,
              path: `${target.pathname}${target.search}`,
              headers: forwardedHeaders(req.headers),
              setHost: false,
              createConnection: () => socket,
            },
            (upstreamRes) => {
              res.writeHead(
                upstreamRes.statusCode ?? 502,
                rawWithoutHopByHop(upstreamRes.rawHeaders),
              );
              upstreamRes.pipe(res);
            },
          );
          upstream.on('error', (error) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'text/plain' }).end(`${error.message}\n`);
            } else {
              res.destroy();
            }
          });
          req.pipe(upstream);
        },
        (error: unknown) => {
          res
            .writeHead(502, { 'content-type': 'text/plain' })
            .end(`${error instanceof Error ? error.message : String(error)}\n`);
        },
      );
    });
  });

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const authority = parseAuthority(req.url ?? '');
    if (authority === undefined) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    void decide(authority.host, authority.port).then((decision) => {
      if (decision.verdict !== 'connect') {
        const [status, text] =
          decision.verdict === 'refuse'
            ? ['403 Forbidden', refusalText(decision.refusal)]
            : ['502 Bad Gateway', decision.reason];
        const body = `${text}\n`;
        client.end(
          `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ` +
            `${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      void connectFirst(decision.addresses, authority.port).then(
        (upstream) => {
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
          upstream.on('error', () => client.destroy());
          client.once('close', () => upstream.destroy());
          upstream.once('close', () => client.destroy());
        },
        (error: unknown) => {
          if (!client.writable) return;
          client.end(
            `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        },
      );
    });
  });

  // Anything else that asks to switch protocols over a plain request is not
  // forwarded: Chrome tunnels WebSockets through CONNECT, which is checked.
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The egress proxy did not report a port.'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    server: `http://127.0.0.1:${String(port)}`,
    refusalsSince: (sinceMs) => refusals.filter((refusal) => refusal.at >= sinceMs),
    stop: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
