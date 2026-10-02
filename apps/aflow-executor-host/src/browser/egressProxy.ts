/**
 * The egress proxy a profile that keeps sign-ins sends all its traffic
 * through (Plan 320 D12).
 *
 * The refusal is made here, at the connection, rather than on the page's
 * address: it then holds for a redirect, a page that navigates itself after
 * load, a subresource, a WebSocket, and a public name that resolves to this
 * machine. Each destination is resolved here, every address it resolves to is
 * checked, and the connection goes to the address that was checked — never to
 * the name, which could resolve differently a moment later.
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
  createLocalAddressClassifier,
  isLocalName,
  localAddressReason,
  type LocalAddressClassifier,
} from './addresses.js';

export interface ProxyRefusal {
  readonly host: string;
  readonly port: number;
  /** `local`: this machine's own address. `rule`: an origin rule the operator set. */
  readonly kind: 'local' | 'rule';
  readonly reason: string;
  readonly at: number;
}

export interface ResolvedAddress {
  readonly address: string;
}

export interface EgressProxyOptions {
  /** Why the operator's rules refuse connections to this host, or nothing when they do not. */
  readonly refuseHost?: (host: string) => string | undefined;
  readonly lookup?: (host: string) => Promise<readonly ResolvedAddress[]>;
  /** Opens the upstream connection to an address already checked. */
  readonly connect?: (address: string, port: number) => Socket;
  readonly classifier?: LocalAddressClassifier;
  readonly now?: () => number;
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
  | { readonly verdict: 'connect'; readonly address: string }
  | { readonly verdict: 'refuse'; readonly refusal: ProxyRefusal }
  | { readonly verdict: 'unreachable'; readonly reason: string };

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
  const classifier = options.classifier ?? createLocalAddressClassifier();
  const now = options.now ?? Date.now;
  const refusals: ProxyRefusal[] = [];
  const open = new Set<Duplex>();

  const refuse = (
    host: string,
    port: number,
    kind: ProxyRefusal['kind'],
    reason: string,
  ): Decision => {
    const refusal: ProxyRefusal = { host, port, kind, reason, at: now() };
    refusals.push(refusal);
    if (refusals.length > REFUSALS_KEPT) refusals.shift();
    return { verdict: 'refuse', refusal };
  };

  const decide = async (rawHost: string, port: number): Promise<Decision> => {
    const host = bareAddress(rawHost.toLowerCase().replace(/\.$/, ''));
    const ruled = options.refuseHost?.(host);
    if (ruled !== undefined) return refuse(host, port, 'rule', ruled);
    if (isLocalName(host)) return refuse(host, port, 'local', `${host} names this machine`);

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host);
    } catch (error) {
      return {
        verdict: 'unreachable',
        reason: `${host} did not resolve: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (addresses.length === 0)
      return { verdict: 'unreachable', reason: `${host} did not resolve` };
    // Every address, not the first: a name answering with a public address and
    // a loopback one is a name that can reach this machine.
    for (const { address } of addresses) {
      const kind = classifier.classify(address);
      if (kind === undefined) continue;
      return refuse(host, port, 'local', localAddressReason(host, address, kind));
    }
    const first = addresses[0];
    if (first === undefined) return { verdict: 'unreachable', reason: `${host} did not resolve` };
    return { verdict: 'connect', address: first.address };
  };

  const refusalText = (reason: string): string =>
    `Refused by this profile's egress proxy: ${reason}. A profile that keeps sign-ins does not ` +
    "reach services on this machine, or origins the operator's rules deny.";

  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.once('close', () => {
      open.delete(socket);
    });
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
          .end(`${refusalText(decision.refusal.reason)}\n`);
        return;
      }
      if (decision.verdict === 'unreachable') {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`${decision.reason}\n`);
        return;
      }
      const upstream = httpRequest(
        {
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: forwardedHeaders(req.headers),
          setHost: false,
          agent: false,
          createConnection: () => connect(decision.address, port),
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, rawWithoutHopByHop(upstreamRes.rawHeaders));
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
            ? ['403 Forbidden', refusalText(decision.refusal.reason)]
            : ['502 Bad Gateway', decision.reason];
        const body = `${text}\n`;
        client.end(
          `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ` +
            `${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      const upstream = connect(decision.address, authority.port);
      track(upstream);
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', (error) => {
        if (client.writable && upstream.connecting) {
          client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${error.message}\n`);
        } else {
          client.destroy();
        }
      });
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
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
