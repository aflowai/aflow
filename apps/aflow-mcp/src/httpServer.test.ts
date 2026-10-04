/**
 * The gate through the real HTTP server on a loopback port: a request a
 * rebinding page can make is refused before a session exists, and the owner's
 * key reaches only a session whose request passed.
 *
 * @module-tag listener
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthManager } from './auth/AuthManager.js';
import { SessionStore } from './auth/SessionStore.js';
import type { McpServerConfig } from './config.js';
import { createMcpHttpServer, type McpHttpServer } from './httpServer.js';
import { setLogLevel } from './util/logger.js';

const EXAMPLE = fileURLToPath(new URL('../mcp.local.json.example', import.meta.url));
const OWNER = {
  ...(JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { apiKey: string }),
  sessionToken: randomBytes(32).toString('hex'),
};
const AUTH_DIR = mkdtempSync(join(tmpdir(), 'mcp-http-'));
const AUTH_FILE = join(AUTH_DIR, 'mcp.local.json');
writeFileSync(AUTH_FILE, JSON.stringify(OWNER));
afterAll(() => {
  rmSync(AUTH_DIR, { recursive: true, force: true });
});
const LOCAL_TOKEN = { authorization: `Bearer ${OWNER.sessionToken}` };

/** A free loopback port, or undefined where the environment refuses a listener. */
async function freeLoopbackPort(): Promise<number | undefined> {
  const probe = createServer();
  try {
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    return (probe.address() as AddressInfo).port;
  } catch {
    return undefined;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

const listenerAllowed = (await freeLoopbackPort()) !== undefined;

const BASE = {
  apiUrl: 'http://127.0.0.1:9',
  host: '127.0.0.1',
  logLevel: 'error',
  unauthenticatedFallback: false,
  allowBrowserOrigins: true,
  allowedOrigins: [],
  allowedHosts: [],
  cfOriginSecret: undefined,
  localAuthJsonPath: AUTH_FILE,
} as const satisfies Omit<McpServerConfig, 'port'>;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'request-gate-test', version: '0' },
  },
});

interface Running extends McpHttpServer {
  port: number;
}

const running: Running[] = [];

async function start(overrides: Partial<McpServerConfig> = {}): Promise<Running> {
  const port = await freeLoopbackPort();
  if (port === undefined) throw new Error('no loopback port');
  const config: McpServerConfig = { ...BASE, port, ...overrides };
  const sessionStore = new SessionStore();
  const server = createMcpHttpServer({
    config,
    sessionStore,
    authManager: new AuthManager(config),
  });
  server.httpServer.on('close', () => {
    sessionStore.destroy();
  });
  server.httpServer.listen(port, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const handle = { ...server, port };
  running.push(handle);
  return handle;
}

async function send(
  port: number,
  options: { method?: string; path?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const req = request({
    host: '127.0.0.1',
    port,
    path: options.path ?? '/',
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...options.headers,
    },
  });
  req.end(options.body);
  const [res] = (await once(req, 'response')) as [import('node:http').IncomingMessage];
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) body += chunk as string;
  return { status: res.statusCode ?? 0, headers: res.headers, body };
}

async function healthSessions(port: number): Promise<number> {
  const health = await send(port, {
    method: 'GET',
    path: '/health',
    headers: { host: `localhost:${String(port)}` },
  });
  return (JSON.parse(health.body) as { sessions: number }).sessions;
}

beforeAll(() => {
  setLogLevel('error');
});

afterEach(async () => {
  for (const server of running.splice(0)) {
    for (const s of server.activeSessions.values()) await s.transport.close();
    server.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});

describe.skipIf(!listenerAllowed)('the MCP HTTP server', () => {
  it('refuses a Host it does not answer to, and creates no session', async () => {
    const server = await start();
    const res = await send(server.port, {
      headers: { host: `evil.example:${String(server.port)}` },
      body: INITIALIZE,
    });

    expect(res.status).toBe(421);
    expect(JSON.parse(res.body)).toEqual({
      error: `Refused: this server does not answer to the Host evil.example:${String(server.port)}.`,
    });
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(server.activeSessions.size).toBe(0);
    expect(await healthSessions(server.port)).toBe(0);
  });

  it('admits localhost on its port, and the owner key reaches a session presenting the token', async () => {
    const server = await start();
    const res = await send(server.port, {
      headers: { host: `localhost:${String(server.port)}`, ...LOCAL_TOKEN },
      body: INITIALIZE,
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    expect(server.activeSessions.get(sessionId as string)?.session.auth).toMatchObject({
      method: 'api_key',
      apiKey: OWNER.apiKey,
    });
  });

  it.each([
    ['no credential', {}],
    ['another token', { authorization: 'Bearer guess' }],
  ])('refuses a local session presenting %s with 401, and creates none', async (_case, auth) => {
    const server = await start();
    const res = await send(server.port, {
      headers: { host: `localhost:${String(server.port)}`, ...auth },
      body: INITIALIZE,
    });

    expect(res.status).toBe(401);
    expect((JSON.parse(res.body) as { error: string }).error).toContain('yarn mcp:setup');
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(server.activeSessions.size).toBe(0);
    expect(await healthSessions(server.port)).toBe(0);
  });

  it('refuses a browser origin while the auth file is loaded, even one configured', async () => {
    const server = await start({ allowedOrigins: ['http://evil.example'] });
    const host = `localhost:${String(server.port)}`;

    const post = await send(server.port, {
      headers: { host, origin: 'http://evil.example' },
      body: INITIALIZE,
    });
    expect(post.status).toBe(403);
    expect((JSON.parse(post.body) as { error: string }).error).toContain("owner's key");

    const preflight = await send(server.port, {
      method: 'OPTIONS',
      headers: { host, origin: 'http://evil.example' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    expect(server.activeSessions.size).toBe(0);
  });

  it('lets a configured origin read a POST response and its session id', async () => {
    const origin = 'http://app.example.test';
    const server = await start({ localAuthJsonPath: undefined, allowedOrigins: [origin] });
    const res = await send(server.port, {
      headers: { host: `localhost:${String(server.port)}`, origin },
      body: INITIALIZE,
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('"serverInfo"');
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['vary']).toBe('Origin');
    expect(res.headers['access-control-expose-headers']).toBe('Mcp-Session-Id');
    const sessionId = res.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    expect(server.activeSessions.has(sessionId as string)).toBe(true);
  });

  it('allows a configured origin every header the SDK client sends after initialize', async () => {
    const origin = 'http://app.example.test';
    const server = await start({ localAuthJsonPath: undefined, allowedOrigins: [origin] });
    const requested = ['mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
    const preflight = await send(server.port, {
      method: 'OPTIONS',
      headers: {
        host: `localhost:${String(server.port)}`,
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': requested.join(', '),
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    const allowed = String(preflight.headers['access-control-allow-headers'])
      .split(',')
      .map((name) => name.trim().toLowerCase());
    for (const name of requested) expect(allowed).toContain(name);
  });

  it('admits a configured ALLOWED_HOSTS entry', async () => {
    const server = await start({ allowedHosts: ['mcp.example.test'] });
    const res = await send(server.port, {
      headers: { host: `mcp.example.test:${String(server.port)}`, ...LOCAL_TOKEN },
      body: INITIALIZE,
    });

    expect(res.status).toBe(200);
    expect(server.activeSessions.size).toBe(1);
  });

  /** The session id is not a credential: the token is asked for on every request. */
  it('refuses a later request on an owner-keyed session presenting another bearer, with 401', async () => {
    const server = await start();
    const host = `localhost:${String(server.port)}`;
    const init = await send(server.port, {
      headers: { host, ...LOCAL_TOKEN },
      body: INITIALIZE,
    });
    const sessionId = init.headers['mcp-session-id'] as string;
    const onSession = { host, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' };
    const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

    for (const method of ['POST', 'GET', 'DELETE']) {
      const later = await send(server.port, {
        method,
        headers: { ...onSession, authorization: 'Bearer guess' },
        ...(method === 'POST' ? { body: initialized } : {}),
      });
      expect(later.status).toBe(401);
      expect((JSON.parse(later.body) as { error: string }).error).toContain('yarn mcp:setup');
    }
    expect(server.activeSessions.has(sessionId)).toBe(true);

    const same = await send(server.port, {
      headers: { ...onSession, ...LOCAL_TOKEN },
      body: initialized,
    });
    expect(same.status).toBe(202);
  });

  /** The SDK's own check, pinned to the Host the session was admitted under. */
  it('refuses a session’s later request under a different Host, through the transport', async () => {
    const server = await start();
    const init = await send(server.port, {
      headers: { host: `localhost:${String(server.port)}`, ...LOCAL_TOKEN },
      body: INITIALIZE,
    });
    const sessionId = init.headers['mcp-session-id'] as string;

    const later = await send(server.port, {
      headers: {
        host: `127.0.0.1:${String(server.port)}`,
        ...LOCAL_TOKEN,
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    expect(later.status).toBe(403);
    expect(later.body).toContain('Invalid Host header');
  });
});
