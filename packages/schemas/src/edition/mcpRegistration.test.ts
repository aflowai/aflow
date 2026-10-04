import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// An allowlist rather than a denylist of `env` and the like: any key beyond these
// is a place a credential could be written into a tracked file. `headers` is
// such a place too, so each value may only name a variable the client expands
// from the shell, never hold the token itself.
const ALLOWED_SERVER_KEYS = ['type', 'url', 'headers'];
const SHELL_REFERENCE_HEADER = /^Bearer \$\{[A-Z][A-Z0-9_]*:-\}$/;

function readMcpConfig(): unknown {
  return JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf-8'));
}

function serverEntries(config: unknown): [string, Record<string, unknown>][] {
  expect(config).toBeTypeOf('object');
  const servers = (config as Record<string, unknown>)['mcpServers'];
  expect(servers).toBeTypeOf('object');
  return Object.entries(servers as Record<string, Record<string, unknown>>);
}

/** The fields of one server registration that could carry a credential. */
function credentialPlaces(server: Record<string, unknown>): string[] {
  const places = Object.keys(server).filter((key) => !ALLOWED_SERVER_KEYS.includes(key));
  const url = new URL(String(server['url']));
  if (url.username + url.password + url.search + url.hash !== '') places.push('url');
  const headers = server['headers'] ?? {};
  if (typeof headers !== 'object' || headers === null) return [...places, 'headers'];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !SHELL_REFERENCE_HEADER.test(value)) {
      places.push(`headers.${name}`);
    }
  }
  return places;
}

describe('.mcp.json', () => {
  it('registers aflow-local as an HTTP server on the dev stack MCP port', () => {
    const servers = Object.fromEntries(serverEntries(readMcpConfig()));
    expect(servers['aflow-local']).toStrictEqual({
      type: 'http',
      url: 'http://localhost:3100',
      headers: { Authorization: 'Bearer ${AFLOW_MCP_LOCAL_TOKEN:-}' },
    });
  });

  it('holds nothing but the server registrations', () => {
    expect(Object.keys(readMcpConfig() as object)).toEqual(['mcpServers']);
  });

  it('gives no server a field that could carry a credential', () => {
    for (const [name, server] of serverEntries(readMcpConfig())) {
      expect(credentialPlaces(server), name).toEqual([]);
    }
  });

  it('refuses a header holding a literal token rather than a shell reference', () => {
    const server = {
      type: 'http',
      url: 'http://localhost:3100',
      headers: { Authorization: 'Bearer 4f1c9e0b7a2d' },
    };
    expect(credentialPlaces(server)).toEqual(['headers.Authorization']);
  });
});
