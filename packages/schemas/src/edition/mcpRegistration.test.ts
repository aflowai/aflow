import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// An allowlist rather than a denylist of `headers`/`env`: any key beyond these
// is a place a credential could be written into a tracked file.
const ALLOWED_SERVER_KEYS = ['type', 'url'];

function readMcpConfig(): unknown {
  return JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf-8'));
}

function serverEntries(config: unknown): [string, Record<string, unknown>][] {
  expect(config).toBeTypeOf('object');
  const servers = (config as Record<string, unknown>)['mcpServers'];
  expect(servers).toBeTypeOf('object');
  return Object.entries(servers as Record<string, Record<string, unknown>>);
}

describe('.mcp.json', () => {
  it('registers aflow-local as an HTTP server on the dev stack MCP port', () => {
    const servers = Object.fromEntries(serverEntries(readMcpConfig()));
    expect(servers['aflow-local']).toStrictEqual({ type: 'http', url: 'http://localhost:3100' });
  });

  it('holds nothing but the server registrations', () => {
    expect(Object.keys(readMcpConfig() as object)).toEqual(['mcpServers']);
  });

  it('gives no server a field that could carry a credential', () => {
    for (const [name, server] of serverEntries(readMcpConfig())) {
      const extra = Object.keys(server).filter((key) => !ALLOWED_SERVER_KEYS.includes(key));
      expect(extra, name).toEqual([]);

      const url = new URL(String(server['url']));
      expect(url.username + url.password + url.search + url.hash, name).toBe('');
    }
  });
});
