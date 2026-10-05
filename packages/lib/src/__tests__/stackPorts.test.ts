/**
 * Contract: every port this stack serves on is one `stackOwnPorts()` knows,
 * by default and wherever its variable moves it — the ports a browser profile
 * may never be opened to (Plan 320 D12). Each service is named here, and every
 * port the Compose files publish or the dev runner starts on is matched to one
 * of them, so a service added to either fails this test until it is named.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  describeStackPortOwner,
  STACK_SERVICES,
  type StackService,
  stackOwnPorts,
} from '../stackPorts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Each service and the ports it answers on when nothing moves it. */
const SERVICES: Readonly<Record<StackService, readonly number[]>> = {
  api: [3000],
  web: [3001, 3002],
  mcp: [3100],
  redis: [6379, 6380],
  postgres: [5433],
  pgadmin: [8080],
  'redis-commander': [8081],
};

/** What the Compose files and the dev runner call each service. */
const NAMED_AS: Readonly<Record<string, StackService>> = {
  api: 'api',
  server: 'api',
  web: 'web',
  'web-local': 'web',
  mcp: 'mcp',
  redis: 'redis',
  postgres: 'postgres',
  pgadmin: 'pgadmin',
  'redis-commander': 'redis-commander',
};

interface Published {
  readonly file: string;
  readonly name: string;
  readonly port: number;
  readonly variable?: string;
}

/** Every host port a Compose file publishes, under the service publishing it. */
function composePublished(file: string): Published[] {
  const found: Published[] = [];
  let service = '';
  for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1] !== undefined) service = header[1];
    const mapping = /^\s+- '[\d.]+:(?:\$\{(\w+):-(\d+)\}|(\d+)):\d+'/.exec(line);
    if (mapping === null) continue;
    const port = Number(mapping[2] ?? mapping[3]);
    found.push({
      file,
      name: service,
      port,
      ...(mapping[1] !== undefined ? { variable: mapping[1] } : {}),
    });
  }
  return found;
}

/** Every service the dev runner starts on a port. */
function devRunnerPorts(): Published[] {
  const found: Published[] = [];
  const source = readFileSync(join(REPO_ROOT, 'scripts/dev.mjs'), 'utf8');
  for (const match of source.matchAll(/^\s+'?([a-z0-9-]+)'?: \{[^\n]*ports: \[([\d, ]+)\]/gm)) {
    for (const port of (match[2] ?? '').split(',')) {
      found.push({ file: 'scripts/dev.mjs', name: match[1] ?? '', port: Number(port.trim()) });
    }
  }
  return found;
}

describe('the ports this stack serves on', () => {
  it('are named, service by service, with their defaults', () => {
    expect([...STACK_SERVICES].sort()).toEqual(Object.keys(SERVICES).sort());
    const known = stackOwnPorts({});
    for (const [service, ports] of Object.entries(SERVICES)) {
      for (const port of ports) {
        expect(known.get(port), `${service} on ${String(port)}`).toEqual({
          service,
          from: 'default',
        });
      }
    }
    expect([...known.keys()].sort()).toEqual(Object.values(SERVICES).flat().sort());
  });

  it('cover every port the Compose files publish and the dev runner starts on, under a named service', () => {
    const published = [
      ...composePublished('docker-compose.yml'),
      ...composePublished('docker-compose.local.yml'),
      ...devRunnerPorts(),
    ];
    expect(published.length).toBeGreaterThanOrEqual(10);
    const known = stackOwnPorts({});
    for (const { file, name, port } of published) {
      const service = NAMED_AS[name];
      expect(service, `${file}: ${name} publishes ${String(port)} and is not named here`).toBe(
        known.get(port)?.service,
      );
    }
  });

  it('follow each variable that moves a published port', () => {
    const moved = 41_000;
    for (const { file, name, variable } of [
      ...composePublished('docker-compose.yml'),
      ...composePublished('docker-compose.local.yml'),
    ]) {
      if (variable === undefined) continue;
      expect(stackOwnPorts({ [variable]: String(moved) }).get(moved), `${file}: ${name}`).toEqual({
        service: NAMED_AS[name],
        from: variable,
      });
    }
  });

  it('read the port each service is configured with, from a port or a URL', () => {
    const env = {
      PORT: '4000',
      WEB_BASE_URL: 'http://localhost:4001',
      MCP_PORT: '4100',
      REDIS_URL: 'redis://127.0.0.1:6390',
      DATABASE_URL: 'postgres://db@localhost:6543/aflow',
      AFLOW_API_URL: 'http://127.0.0.1:4002',
      PHOENIX_HOST_REDIS_URL: 'redis://127.0.0.1',
    };
    const known = stackOwnPorts(env);
    expect(known.get(4000)).toEqual({ service: 'api', from: 'PORT' });
    expect(known.get(4001)).toEqual({ service: 'web', from: 'WEB_BASE_URL' });
    expect(known.get(4100)).toEqual({ service: 'mcp', from: 'MCP_PORT' });
    expect(known.get(6390)).toEqual({ service: 'redis', from: 'REDIS_URL' });
    expect(known.get(6543)).toEqual({ service: 'postgres', from: 'DATABASE_URL' });
    expect(known.get(4002)).toEqual({ service: 'api', from: 'AFLOW_API_URL' });
    expect(known.get(6379)).toEqual({ service: 'redis', from: 'PHOENIX_HOST_REDIS_URL' });
    // The defaults stand beside a moved port: another process may still use them.
    expect(known.get(3000)?.service).toBe('api');
    for (const value of ['', 'not-a-port', '0', '70000', 'http://']) {
      expect(stackOwnPorts({ PORT: value }).size).toBe(stackOwnPorts({}).size);
    }
  });

  it('take a port from a URL only when it names this machine by a localhost name or a loopback literal', () => {
    const defaults = stackOwnPorts({}).size;
    for (const value of [
      'https://aflow.example.com',
      'http://aflow.example.com',
      'http://aflow.example.com:4005',
      'http://192.0.2.10:4005',
      'http://[2001:db8::1]:4005',
      'http://localhost.example.com:4005',
    ]) {
      const known = stackOwnPorts({ API_BASE_URL: value });
      expect(known.size, value).toBe(defaults);
      expect(known.has(4005) || known.has(80) || known.has(443), value).toBe(false);
    }
    for (const [value, port] of [
      ['http://localhost', 80],
      ['https://app.localhost', 443],
      ['http://LOCALHOST.:4005', 4005],
      ['http://127.0.0.2:4006', 4006],
      ['http://[::1]:4007', 4007],
      ['http://[::ffff:127.0.0.1]:4008', 4008],
    ] as const) {
      expect(stackOwnPorts({ API_BASE_URL: value }).get(port), value).toEqual({
        service: 'api',
        from: 'API_BASE_URL',
      });
    }
  });

  it('say whose a port is and where that came from', () => {
    expect(describeStackPortOwner({ service: 'web', from: 'default' })).toBe(
      'the web application, by default',
    );
    expect(describeStackPortOwner({ service: 'api', from: 'PORT' })).toBe(
      'the API, as PORT sets it',
    );
  });
});
